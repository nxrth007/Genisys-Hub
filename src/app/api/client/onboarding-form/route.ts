import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/auth'
import { prisma } from '@/lib/prisma'
import { sendEmail, getPublicOrigin } from '@/lib/gmail'
import { canonicalizeStateName, isKnownState } from '@/lib/address'
import { provisionClientWorkspace } from '@/lib/client-workspace'

/**
 * POST /api/client/onboarding-form
 *
 * Step 2 of the client signup funnel — collects the business + contact
 * details Alex would normally type into the admin "+ New client"
 * dialog. Creates the Client row with lifecycle="pending", links the
 * caller's User to it, and bumps role to "client_onboarding" so
 * middleware moves them to the "we're reviewing" waiting screen.
 *
 * Caller must already have a session (role=client_pending) — the
 * register endpoint creates that, then auto-signs them in. This
 * endpoint is the second leg.
 */
const ADMIN_NOTIFY_EMAIL =
  process.env.CLIENT_ONBOARDING_NOTIFY_EMAIL ||
  process.env.AGENT_APPROVAL_NOTIFY_EMAIL ||
  'alex@leadgenisys.com'
const FROM_GMAIL_ACCOUNT =
  process.env.AGENT_APPROVAL_FROM_EMAIL || ADMIN_NOTIFY_EMAIL

// Pro is intentionally absent — disabled in the UI ("Coming soon")
// while the QuickBooks $5K multi-use link cap is sorted out. Belt-
// and-suspenders: if a user bypasses the disabled button via
// devtools and posts tier=pro, the API rejects it instead of letting
// an un-payable client through.
const VALID_PACKAGES = new Set(['ppa', 'growth', 'custom'])

// Appointment-types enum — keep narrow so admin reports + filters
// have a stable vocabulary. Free-text "hybrid" / "either" inputs map
// to "both" at validation time.
const VALID_APPOINTMENT_TYPES = new Set(['in_person', 'virtual', 'both'])

function trim(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

function asOptional(v: unknown): string | null {
  const s = trim(v)
  return s.length === 0 ? null : s
}

export async function POST(req: NextRequest) {
  const session = await auth()
  if (!session?.user?.id) {
    // Logged so we can tell whether the cookie didn't reach this
    // handler at all vs. it being a wrong-role situation below.
    console.warn(
      '[client/onboarding-form] no session — cookie did not reach handler',
    )
    return NextResponse.json(
      {
        error:
          'Your session expired. Please sign in again at /signin/client.',
      },
      { status: 401 },
    )
  }
  // As of 2026-05-11 the onboarding form is filled out AFTER admin
  // approves the prospect (post-payment). Role must be
  // 'client_onboarding'; anyone else gets a clear redirect message.
  if (session.user.role !== 'client_onboarding') {
    if (session.user.role === 'client_active') {
      return NextResponse.json(
        {
          error:
            'You have already completed onboarding. Refresh the page to see your tracker.',
        },
        { status: 409 },
      )
    }
    if (session.user.role === 'client_pending') {
      return NextResponse.json(
        {
          error:
            'Please complete payment first. We will review your account before you can fill out the onboarding form.',
        },
        { status: 403 },
      )
    }
    console.warn(
      `[client/onboarding-form] unexpected role=${session.user.role} for user ${session.user.id}`,
    )
    return NextResponse.json(
      {
        error:
          'This form is only available to approved clients filling out their onboarding. If you signed in with a different account, sign out and use your client account.',
      },
      { status: 403 },
    )
  }

  let body: Record<string, unknown>
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const businessName = trim(body.businessName)
  const state = trim(body.state)
  const tier = trim(body.tier).toLowerCase()
  const fullName = trim(body.fullName)
  const role = trim(body.role)
  const phone = trim(body.phone)
  const address = trim(body.address)
  const servicingZipcodes = asOptional(body.servicingZipcodes)
  const appointmentTypesRaw = trim(body.appointmentTypes).toLowerCase()
  const website = normalizeWebsite(asOptional(body.website))
  // Booleans posted explicitly as `true` / `false`; reject anything else
  // (don't silently coerce a missing field to false, since the form
  // is supposed to force an answer).
  const bookWeekends =
    typeof body.bookWeekends === 'boolean' ? body.bookWeekends : null
  const providesBatteryBackup =
    typeof body.providesBatteryBackup === 'boolean'
      ? body.providesBatteryBackup
      : null
  // Optional business contact email — defaults to signin email below.
  const emailInput = asOptional(body.email)
  // Long-form intake answers. Both optional; empty string -> null.
  const qualificationCriteria = asOptional(body.qualificationCriteria)
  const onboardingNotes = asOptional(body.onboardingNotes)

  if (!businessName) {
    return NextResponse.json(
      { error: 'Business name is required.' },
      { status: 400 },
    )
  }
  if (!fullName) {
    return NextResponse.json(
      { error: 'Your full name is required.' },
      { status: 400 },
    )
  }
  if (!phone) {
    return NextResponse.json(
      { error: 'Phone number is required.' },
      { status: 400 },
    )
  }
  if (!address) {
    return NextResponse.json(
      { error: 'Business address is required.' },
      { status: 400 },
    )
  }
  // State is optional, but if filled in it must be a recognized US
  // state. Reject typos before they land in the DB.
  if (state && !isKnownState(state)) {
    return NextResponse.json(
      {
        error: `"${state}" doesn't match a US state. Use the full name (e.g. "New Hampshire") or a 2-letter code (e.g. "NH"), or leave it blank.`,
      },
      { status: 400 },
    )
  }
  if (tier === 'pro') {
    return NextResponse.json(
      {
        error:
          'The Pro Pack is coming soon — please pick another package for now. Your account manager can move you to Pro later.',
      },
      { status: 400 },
    )
  }
  if (!VALID_PACKAGES.has(tier)) {
    return NextResponse.json(
      {
        error: 'Pick a package: pay-per-appointment, growth, or custom.',
      },
      { status: 400 },
    )
  }
  if (!VALID_APPOINTMENT_TYPES.has(appointmentTypesRaw)) {
    return NextResponse.json(
      {
        error:
          'Pick an appointment type: in-person, virtual, or both.',
      },
      { status: 400 },
    )
  }
  if (bookWeekends === null) {
    return NextResponse.json(
      {
        error: 'Please answer whether you book during weekends.',
      },
      { status: 400 },
    )
  }
  if (providesBatteryBackup === null) {
    return NextResponse.json(
      {
        error:
          'Please answer whether you provide battery backup installs.',
      },
      { status: 400 },
    )
  }
  // Loose email check — if the prospect provided a business email
  // explicitly, validate the shape. Blank is fine (falls back to
  // signin email below).
  if (emailInput && !/^\S+@\S+\.\S+$/.test(emailInput)) {
    return NextResponse.json(
      {
        error:
          'That business email doesn\'t look right. Please double-check or leave it blank to use your sign-in email.',
      },
      { status: 400 },
    )
  }

  // Re-fetch the user (need clientId + email). The Client row was
  // created at select-plan time; this handler updates it in place.
  const me = await prisma.user.findUnique({
    where: { id: session.user.id },
    select: { id: true, email: true, clientId: true },
  })
  if (!me) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }
  if (!me.clientId) {
    return NextResponse.json(
      {
        error:
          'Your account is missing its client record. Contact support — this should never happen for an approved client.',
      },
      { status: 409 },
    )
  }

  // Block name collisions with OTHER clients — Client.name is
  // unique. The current Client (this user's own) is excluded so
  // changing other details while keeping the same business name
  // doesn't trip the constraint.
  const nameTaken = await prisma.client.findFirst({
    where: { name: businessName, id: { not: me.clientId } },
    select: { id: true },
  })
  if (nameTaken) {
    return NextResponse.json(
      {
        error:
          'A client with that business name already exists. If that is you, contact your account manager.',
      },
      { status: 409 },
    )
  }

  // Update the existing Client (created at select-plan time) +
  // flip the user role to client_active. Atomic so a partial
  // failure can't leave the user in an inconsistent state.
  const updated = await prisma.$transaction(async (tx) => {
    const client = await tx.client.update({
      where: { id: me.clientId! },
      data: {
        name: businessName,
        // Canonicalize so "NH" / "nh" → "New Hampshire" before
        // hitting the DB. Display + filtering then read consistent
        // values regardless of how the prospect typed it.
        state: canonicalizeStateName(state),
        // Tier may have been changed since the select-plan step
        // (admin might have edited it during review, or the user
        // submitted a different value here). Trust what's on the
        // form now.
        package: tier,
        contactName: fullName,
        contactRole: role || null,
        // contactEmail comes from the explicit form field when
        // provided (lets prospects record a business address like
        // info@company.com), otherwise falls back to their signin
        // email. The signin email itself never changes — that's
        // their login.
        contactEmail: emailInput ?? me.email,
        contactPhone: phone,
        address,
        servicingZipcodes,
        // Intake answers (added 2026-05-11). Required at the form,
        // so guaranteed non-null here.
        appointmentTypes: appointmentTypesRaw,
        bookWeekends,
        website,
        providesBatteryBackup,
        // Long-form intake answers — optional, can be null. The
        // select-plan step stashed a payment-option note here; this
        // submission replaces it with the prospect's own notes (if
        // any). Admin can still see the original note in the email
        // notification that fired at select-plan time.
        qualificationCriteria,
        onboardingNotes,
        lifecycle: 'active',
        active: true,
        // Official "start of services" — drives the PPA bi-weekly
        // invoicing cadence (first invoice = serviceStartDate + 14
        // days). Stamped here, not at admin-approval time, because
        // the client only counts as "active" once they've filled
        // out the onboarding form. Existing clients are backfilled
        // via the 20260602000000_ppa_invoicing migration.
        serviceStartDate: new Date(),
      },
      select: { id: true, name: true, package: true },
    })
    const user = await tx.user.update({
      where: { id: me.id },
      data: {
        role: 'client_active',
        name: fullName,
      },
      select: { id: true, email: true, name: true },
    })
    return { client, user }
  })

  // Reuse the variable name the rest of the file expects.
  const created = updated

  // Fire-and-forget both notifications so the user-facing API doesn't
  // block on Gmail. If a send fails, it lands in the server log via
  // .catch — admin can resend manually from /clients/onboarding.
  const origin = getPublicOrigin(req)
  const reviewUrl = `${origin}/clients/onboarding`
  const clientSigninUrl = `${origin}/signin/client`
  sendEmail({
    accountEmail: FROM_GMAIL_ACCOUNT,
    to: ADMIN_NOTIFY_EMAIL,
    subject: `[Genisys Hub] Onboarding details submitted: ${created.client.name}`,
    body: [
      `**${fullName}** at **${created.client.name}** just submitted their full onboarding details. The account is now active and they can see appointments come through as Mary books them.`,
      '',
      `Tier: ${created.client.package}`,
      `Email: ${created.user.email}`,
      `Phone: ${phone}`,
      `Address: ${address}`,
      servicingZipcodes ? `Servicing zipcodes: ${servicingZipcodes}` : '',
      `Appointment types: ${
        appointmentTypesRaw === 'in_person'
          ? 'In-person'
          : appointmentTypesRaw === 'virtual'
            ? 'Virtual'
            : 'Both'
      }`,
      `Weekends: ${bookWeekends ? 'Yes' : 'No'}`,
      `Battery backup: ${providesBatteryBackup ? 'Yes' : 'No'}`,
      website ? `Website: ${website}` : '',
      emailInput && emailInput !== me.email
        ? `Business email: ${emailInput} (signin: ${me.email})`
        : '',
      qualificationCriteria
        ? `\nQualification criteria:\n${qualificationCriteria}`
        : '',
      onboardingNotes ? `\nAdditional notes:\n${onboardingNotes}` : '',
      '',
      `[View on Hub →](${reviewUrl})`,
      '',
      'Their account is already active; this email is a heads-up so you can spot-check the details if needed.',
    ]
      .filter(Boolean)
      .join('\n'),
  }).catch((err) => {
    console.error('[client/onboarding-form] admin notify failed:', err)
  })

  // Confirmation email to the client. They're already approved at
  // this point (this submission is the LAST step of the funnel
  // post-approval), so the message reads as a welcome rather than a
  // "you're under review" note.
  sendEmail({
    accountEmail: FROM_GMAIL_ACCOUNT,
    to: created.user.email,
    subject: `Welcome to Lead Genisys, ${created.client.name}`,
    body: [
      `Hi ${fullName},`,
      '',
      `You're all set! Your onboarding for **${created.client.name}** is complete and your dashboard is live.`,
      '',
      `Appointments will show up in real time as we book them for you:`,
      '',
      `[Open your dashboard →](${clientSigninUrl})`,
      '',
      '— Lead Genisys',
    ].join('\n'),
  }).catch((err) => {
    console.error('[client/onboarding-form] client notify failed:', err)
  })

  // Slack workspace provisioning (private channel, team invites,
  // Slack Connect invite to the client's contactEmail) fires here
  // now that the business name + contact details are finalized.
  // The approval API skips provisioning when needsOnboarding=true
  // for exactly this reason — wait until the name is stable.
  provisionClientWorkspace(created.client.id).catch((err) => {
    console.error(
      `[client/onboarding-form] Slack provisioning crashed for ${created.client.id}:`,
      err,
    )
  })

  return NextResponse.json({
    ok: true,
    clientId: created.client.id,
    clientName: created.client.name,
  })
}

/** Normalize a website value typed by a client. Most clients type
 *  "solarguys.com" (or worse, "www.solarguys.com") and expect it to
 *  Just Work. Without a scheme, the stored value isn't a valid URL —
 *  links from admin tooling won't open in a new tab, etc. Prepend
 *  https:// when there's no scheme; otherwise pass through. Returns
 *  null on empty so the column stays nullable as before. */
function normalizeWebsite(input: string | null): string | null {
  if (!input) return null
  const trimmed = input.trim()
  if (!trimmed) return null
  // Already has a scheme — accept as-is. Cover http(s)://, plus the
  // rare ftp:// / mailto: a client might paste. The point is "if
  // they specified a protocol, don't second-guess it."
  if (/^[a-z][a-z0-9+.\-]*:\/\//i.test(trimmed)) return trimmed
  if (/^mailto:/i.test(trimmed)) return trimmed
  // Bare domain → assume https. Don't try to validate the domain
  // shape; the form is optional and a typo'd value is recoverable
  // by admin editing later.
  return `https://${trimmed}`
}
