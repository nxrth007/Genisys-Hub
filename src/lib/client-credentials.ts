/**
 * Client login provisioning — shared logic for the single-client
 * "Generate login" admin button + the bulk roll-out flow. One source
 * of truth for: temp-password generation, User upsert (create-or-
 * rotate-password), conflict detection (don't repurpose staff/agent
 * accounts), and the welcome email + SMS templates.
 *
 * Per Alex's 2026-05-29 spec:
 *   - Email carries the credentials (sign-in URL + email + temp pass)
 *     in a professional welcome layout.
 *   - SMS does NOT carry the credentials — only a heads-up that the
 *     login is ready and to check email. SMS is unencrypted in flight
 *     so password material stays off it.
 *   - Password change is encouraged (banner on dashboard) but NOT
 *     forced — mustChangePassword stays false on provisioning so
 *     middleware doesn't redirect them to /client/change-password.
 *     They can keep using the temp password if they really want to;
 *     the dashboard nudges them to set their own.
 */

import bcrypt from 'bcryptjs'
import { randomBytes } from 'node:crypto'
import { prisma } from './prisma'
import { sendEmail } from './gmail'
import { sendSmsToPhone } from './ghl'

/** 16 random bytes → 22 chars base64url. Plenty of entropy
 *  (128 bits), URL-safe characters only, no ambiguous glyphs. */
const TEMP_PASSWORD_BYTES = 16

/** Admin email that gets cc'd a "login provisioned" notification so
 *  there's a paper trail outside the client's inbox. Override via
 *  env if Ethan needs to be looped in too. */
const ADMIN_NOTIFY_EMAIL =
  process.env.CLIENT_CREDENTIAL_NOTIFY_EMAIL || 'alex@leadgenisys.com'

/** Gmail account used as the From: for the welcome email. Defaults
 *  to alex@ so the email comes from a recognizable address that
 *  clients are likely already corresponding with. */
const FROM_GMAIL_ACCOUNT =
  process.env.AGENT_APPROVAL_FROM_EMAIL || ADMIN_NOTIFY_EMAIL

/** Vault entry name for the GHL SMS-sending token. Same one the
 *  ClientAlertsConfig uses by default; the welcome SMS reuses that
 *  pipeline rather than introducing a parallel send path. */
const SMS_VAULT_ENTRY = 'GHL Genisys Token'

export type ProvisionResult = {
  ok: true
  userId: string
  email: string
  tempPassword: string
  /** Was this a brand-new login (true) or a password rotation on an
   *  already-provisioned client (false)? Used by the UI summary
   *  so admin can tell which clients were freshly minted vs. reset. */
  isNewLogin: boolean
} | {
  ok: false
  /** Stable code so the bulk-endpoint summary can group + label
   *  failures consistently. */
  code: 'no_contact_email' | 'email_collision_with_staff' | 'email_collision_with_other_client' | 'multiple_logins_exist'
  error: string
}

/**
 * Provision (create or rotate) a /client login for the given client.
 * Same logic the single-client and bulk flows both use — extracted so
 * the rules can't drift between them.
 *
 * Does NOT send the email or SMS — that's a separate step the caller
 * fires explicitly. Keeps this function easy to test + retry-safe
 * (a transient Gmail outage can't half-provision the user).
 */
export async function provisionClientCredentials(
  clientId: string,
): Promise<ProvisionResult> {
  const client = await prisma.client.findUnique({
    where: { id: clientId },
    select: { id: true, name: true, contactEmail: true, contactName: true },
  })
  if (!client) {
    return {
      ok: false,
      code: 'no_contact_email',
      error: 'client not found',
    }
  }
  const email = client.contactEmail?.trim().toLowerCase()
  if (!email) {
    return {
      ok: false,
      code: 'no_contact_email',
      error: 'No contact email — set one on the client edit form first.',
    }
  }

  // Conflict detection. Same guards as the legacy single-client
  // endpoint: don't repurpose staff/agent accounts, don't link a
  // login that's already tied to a different client, don't create
  // a second login on a client that already has one.
  const existing = await prisma.user.findUnique({
    where: { email },
    select: { id: true, role: true, clientId: true },
  })
  if (
    existing &&
    existing.role !== 'client_active' &&
    existing.role !== 'client_pending' &&
    existing.role !== 'client_onboarding' &&
    existing.role !== 'client_denied'
  ) {
    return {
      ok: false,
      code: 'email_collision_with_staff',
      error: `${email} is already a non-client user (role=${existing.role}). Use a different contact email on this client.`,
    }
  }
  if (existing && existing.clientId && existing.clientId !== clientId) {
    return {
      ok: false,
      code: 'email_collision_with_other_client',
      error: `${email} is already linked to a different client. Resolve the conflict before generating credentials.`,
    }
  }
  if (!existing) {
    const otherLogin = await prisma.user.findFirst({
      where: {
        clientId,
        role: { startsWith: 'client_' },
      },
      select: { id: true, email: true },
    })
    if (otherLogin) {
      return {
        ok: false,
        code: 'multiple_logins_exist',
        error: `Client already has a login (${otherLogin.email}). Update the contact email to match, or reset that login's password instead.`,
      }
    }
  }

  const tempPassword = generateTempPassword()
  const passwordHash = await bcrypt.hash(tempPassword, 12)
  const isNewLogin = !existing

  const user = existing
    ? await prisma.user.update({
        where: { id: existing.id },
        data: {
          passwordHash,
          // Password change is encouraged but NOT forced — middleware
          // would redirect to /client/change-password if this were
          // true. Per Alex's 2026-05-29 spec, the dashboard nudges
          // them to set their own password but lets them keep using
          // the temp one if they really want to. The
          // mustChangePassword=true flag is only set when admin
          // explicitly resets a forgotten password (separate flow).
          mustChangePassword: false,
          role: 'client_active',
          clientId,
        },
        select: { id: true, email: true },
      })
    : await prisma.user.create({
        data: {
          email,
          name: client.contactName ?? client.name,
          passwordHash,
          mustChangePassword: false,
          role: 'client_active',
          clientId,
        },
        select: { id: true, email: true },
      })

  return {
    ok: true,
    userId: user.id,
    email,
    tempPassword,
    isNewLogin,
  }
}

function generateTempPassword(): string {
  return randomBytes(TEMP_PASSWORD_BYTES).toString('base64url')
}

/* -------------------------------------------------------------------------- */
/*  Welcome email + SMS                                                       */
/* -------------------------------------------------------------------------- */

export type SendWelcomeOptions = {
  client: {
    id: string
    name: string
    contactName: string | null
    contactEmail: string
    contactPhone: string | null
  }
  email: string
  tempPassword: string
  hubOrigin: string
}

export type SendWelcomeResult = {
  emailSent: boolean
  emailError: string | null
  smsSent: boolean
  smsError: string | null
  smsSkippedReason: 'no_phone' | null
}

/**
 * Send the welcome email + welcome SMS in parallel. Returns a result
 * object so the caller can build a summary; never throws (any single
 * delivery failure is captured and surfaced in the result). The
 * email is the source of truth for credentials; the SMS is a
 * heads-up that points the recipient at their inbox.
 */
export async function sendClientWelcomeMessages(
  opts: SendWelcomeOptions,
): Promise<SendWelcomeResult> {
  const signinUrl = `${opts.hubOrigin.replace(/\/$/, '')}/signin/client`

  const result: SendWelcomeResult = {
    emailSent: false,
    emailError: null,
    smsSent: false,
    smsError: null,
    smsSkippedReason: null,
  }

  // Email — primary delivery channel. Awaited so we can capture
  // success/failure for the bulk summary, but written with try/catch
  // so a Gmail blip doesn't poison the whole bulk run.
  try {
    await sendEmail({
      accountEmail: FROM_GMAIL_ACCOUNT,
      to: opts.email,
      subject: 'Your Genisys client portal is ready',
      body: formatClientWelcomeEmail({
        clientName: opts.client.name,
        contactName: opts.client.contactName,
        email: opts.email,
        tempPassword: opts.tempPassword,
        signinUrl,
      }),
      fromName: 'Genisys',
    })
    result.emailSent = true
  } catch (err) {
    result.emailError = err instanceof Error ? err.message : 'send failed'
    console.error(
      `[client-credentials] welcome email failed for ${opts.email}:`,
      err,
    )
  }

  // SMS — secondary, only when contactPhone is set. Never carries
  // the password; just nudges the recipient to check their email.
  if (!opts.client.contactPhone?.trim()) {
    result.smsSkippedReason = 'no_phone'
  } else {
    try {
      await sendSmsToPhone(SMS_VAULT_ENTRY, {
        phone: opts.client.contactPhone.trim(),
        message: formatClientWelcomeSms({
          clientName: opts.client.name,
          email: opts.email,
          signinUrl,
        }),
        // Contact-create hints for GHL if no contact exists at this
        // phone yet. Existing contacts are never touched.
        companyName: opts.client.name,
        ...(opts.client.contactName
          ? splitName(opts.client.contactName)
          : {}),
      })
      result.smsSent = true
    } catch (err) {
      result.smsError = err instanceof Error ? err.message : 'send failed'
      console.error(
        `[client-credentials] welcome SMS failed for ${opts.client.contactPhone}:`,
        err,
      )
    }
  }

  // Fire-and-forget admin paper-trail email. Loops Alex in (no creds
  // in the body — just "this client got provisioned").
  sendEmail({
    accountEmail: FROM_GMAIL_ACCOUNT,
    to: ADMIN_NOTIFY_EMAIL,
    subject: `[Genisys Hub] Client login provisioned: ${opts.client.name}`,
    body: [
      `Login generated for **${opts.client.name}**${
        opts.client.contactName ? ` (${opts.client.contactName})` : ''
      }.`,
      '',
      `Email: ${opts.email}`,
      `Sign in: ${signinUrl}`,
      '',
      `Welcome email: ${result.emailSent ? 'sent' : `FAILED — ${result.emailError}`}`,
      `Welcome SMS:   ${
        result.smsSent
          ? 'sent'
          : result.smsSkippedReason === 'no_phone'
            ? 'skipped (no contactPhone on file)'
            : `FAILED — ${result.smsError}`
      }`,
      '',
      '— Genisys Hub',
    ].join('\n'),
  }).catch((err) => {
    console.error('[client-credentials] admin paper-trail email failed:', err)
  })

  return result
}

/** Split a full name into firstName + lastName for GHL contact
 *  hints. Same shape as the helper in client-alert.ts. */
function splitName(raw: string): {
  firstName: string | undefined
  lastName: string | undefined
} {
  const parts = raw.trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return { firstName: undefined, lastName: undefined }
  if (parts.length === 1)
    return { firstName: parts[0], lastName: undefined }
  return { firstName: parts[0], lastName: parts.slice(1).join(' ') }
}

/* -------------------------------------------------------------------------- */
/*  Email body (HTML, branded, inline styles for email-client compat)         */
/* -------------------------------------------------------------------------- */

function escHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function formatClientWelcomeEmail(params: {
  clientName: string
  contactName: string | null
  email: string
  tempPassword: string
  signinUrl: string
}): string {
  const greetingName = params.contactName?.trim()
    ? params.contactName.trim()
    : 'there'
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1.0">
  <title>Welcome to your Genisys client portal</title>
</head>
<body style="margin:0;padding:0;background:#f3f4f6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#111827;">
  <table cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#f3f4f6;padding:24px 0;">
    <tr>
      <td align="center">
        <table cellpadding="0" cellspacing="0" border="0" width="600" style="max-width:600px;width:100%;background:#ffffff;border-radius:12px;box-shadow:0 1px 3px rgba(0,0,0,0.06);overflow:hidden;">
          <!-- Brand header -->
          <tr>
            <td style="background:#1e3a8a;padding:22px 28px;color:#ffffff;">
              <div style="font-size:12px;text-transform:uppercase;letter-spacing:0.12em;opacity:0.7;">Genisys</div>
              <div style="font-size:20px;font-weight:700;margin-top:4px;">Welcome to your client portal</div>
            </td>
          </tr>

          <!-- Body -->
          <tr>
            <td style="padding:28px;">
              <p style="margin:0 0 14px 0;font-size:15px;line-height:1.6;color:#374151;">
                Hi ${escHtml(greetingName)},
              </p>
              <p style="margin:0 0 14px 0;font-size:15px;line-height:1.6;color:#374151;">
                We've just provisioned a Genisys Hub login for <strong>${escHtml(params.clientName)}</strong>. Your portal is where you can see every appointment we're delivering for you in real time, mark show outcomes, listen to the original call recordings, and keep your closer team aligned without having to ping us.
              </p>

              <!-- Credentials box -->
              <table cellpadding="0" cellspacing="0" border="0" width="100%" style="margin:22px 0;border-collapse:collapse;">
                <tr>
                  <td style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:8px;padding:18px;">
                    <p style="margin:0 0 10px 0;font-size:11px;text-transform:uppercase;letter-spacing:0.08em;color:#6b7280;font-weight:700;">Your sign-in details</p>
                    <table cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:collapse;">
                      <tr>
                        <td style="padding:4px 0;color:#6b7280;font-size:13px;width:130px;vertical-align:top;">Sign-in URL</td>
                        <td style="padding:4px 0;font-size:14px;font-weight:600;">
                          <a href="${escHtml(params.signinUrl)}" style="color:#1e3a8a;text-decoration:none;">${escHtml(params.signinUrl)}</a>
                        </td>
                      </tr>
                      <tr>
                        <td style="padding:4px 0;color:#6b7280;font-size:13px;vertical-align:top;">Email</td>
                        <td style="padding:4px 0;font-size:14px;font-weight:600;font-family:'SFMono-Regular',Consolas,Menlo,monospace;">${escHtml(params.email)}</td>
                      </tr>
                      <tr>
                        <td style="padding:4px 0;color:#6b7280;font-size:13px;vertical-align:top;">Temporary password</td>
                        <td style="padding:4px 0;font-size:14px;font-weight:600;font-family:'SFMono-Regular',Consolas,Menlo,monospace;">${escHtml(params.tempPassword)}</td>
                      </tr>
                    </table>
                  </td>
                </tr>
              </table>

              <!-- Primary CTA -->
              <div style="margin:24px 0;">
                <a href="${escHtml(params.signinUrl)}"
                   style="display:inline-block;background:#1e3a8a;color:#ffffff;text-decoration:none;padding:12px 24px;border-radius:8px;font-size:15px;font-weight:600;">
                  Sign in to your portal
                </a>
              </div>

              <!-- What to expect -->
              <h3 style="margin:28px 0 8px 0;font-size:13px;text-transform:uppercase;letter-spacing:0.06em;color:#6b7280;font-weight:700;">What you can do once you're in</h3>
              <ul style="margin:0 0 16px 18px;padding:0;font-size:14px;line-height:1.7;color:#374151;">
                <li>See every appointment we deliver, with phone, address, utility, and bill on file</li>
                <li>Mark each appointment as showed / didn't show, and add your own notes — closes the loop without a follow-up call</li>
                <li>Play back the original phone call from the appointment-setting agent, for context before your sit-down</li>
                <li>Track your monthly delivery pace at a glance (Growth Pack clients)</li>
              </ul>

              <!-- Recommended next step (soft, not forced) -->
              <h3 style="margin:28px 0 8px 0;font-size:13px;text-transform:uppercase;letter-spacing:0.06em;color:#6b7280;font-weight:700;">Recommended: set your own password</h3>
              <p style="margin:0 0 14px 0;font-size:14px;line-height:1.6;color:#374151;">
                The password above is temporary — we'd recommend setting one of your own from your account page after you sign in. It only takes a minute. You're welcome to keep using the temporary one if you'd rather; we just wanted to make the option clear.
              </p>

              <p style="margin:24px 0 0 0;font-size:14px;line-height:1.6;color:#374151;">
                If you have any questions or hit any snags, just reply to this email and we'll get back to you.
              </p>
              <p style="margin:18px 0 0 0;font-size:14px;line-height:1.6;color:#374151;">
                Welcome aboard,<br>
                <strong>The Genisys team</strong>
              </p>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="padding:18px 28px;background:#f9fafb;border-top:1px solid #e5e7eb;color:#6b7280;font-size:12px;line-height:1.5;">
              You're receiving this because a Genisys Hub account has been provisioned for ${escHtml(params.clientName)}. If you weren't expecting this email, please reply and let us know.
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`
}

/* -------------------------------------------------------------------------- */
/*  SMS body                                                                  */
/* -------------------------------------------------------------------------- */

function formatClientWelcomeSms(params: {
  clientName: string
  email: string
  signinUrl: string
}): string {
  // Single segment when possible. Mentions the email-on-file so the
  // recipient knows where to look without us spelling it out in the
  // text. Reply STOP is the GHL standard opt-out footer; carriers
  // require it for first-touch outbound messages.
  return [
    `Your ${params.clientName} Genisys client portal is now live.`,
    `Sign in at ${params.signinUrl}.`,
    `Your username + temporary password were just emailed to the address we have on file. Reply STOP to opt out.`,
  ].join(' ')
}
