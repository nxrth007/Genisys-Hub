import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/auth'
import { prisma } from '@/lib/prisma'
import { sendEmail, getPublicOrigin } from '@/lib/gmail'
import { canonicalizeStateName, isKnownState } from '@/lib/address'

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
  // Already-submitted: helpful message instead of a confusing 403.
  // Middleware will route them to /signin/client/pending on their
  // next navigation.
  if (session.user.role === 'client_onboarding') {
    return NextResponse.json(
      {
        error:
          'You have already submitted this form. Our team is reviewing it now — you will get an email when your account is approved.',
      },
      { status: 409 },
    )
  }
  if (session.user.role !== 'client_pending') {
    console.warn(
      `[client/onboarding-form] unexpected role=${session.user.role} for user ${session.user.id}`,
    )
    return NextResponse.json(
      {
        error:
          'This form is only available to newly registered accounts. If you signed in with an existing staff or agent account, sign out and register again with a different email.',
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
  const website = asOptional(body.website)
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

  // Block name collisions with existing clients — Client.name is
  // unique. Friendly error rather than a Prisma constraint blow-up.
  const existingClient = await prisma.client.findUnique({
    where: { name: businessName },
    select: { id: true },
  })
  if (existingClient) {
    return NextResponse.json(
      {
        error:
          'A client with that business name already exists. If that is you, contact your account manager.',
      },
      { status: 409 },
    )
  }

  // Re-fetch the user to be sure the role-flip happens against the
  // latest server state (and to grab the email for the contactEmail
  // default — Phase 2 uses the signin email as the client's contact
  // email by default, admin can edit later).
  const me = await prisma.user.findUnique({
    where: { id: session.user.id },
    select: { id: true, email: true },
  })
  if (!me) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  // Two writes in one transaction: create the Client + flip the User
  // role + clientId pointer. Atomic so we never end up with a Client
  // row that no User points to (or vice-versa).
  const created = await prisma.$transaction(async (tx) => {
    const client = await tx.client.create({
      data: {
        name: businessName,
        // Canonicalize so "NH" / "nh" → "New Hampshire" before
        // hitting the DB. Display + filtering then read consistent
        // values regardless of how the prospect typed it.
        state: canonicalizeStateName(state),
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
        // Long-form intake answers — optional, can be null.
        qualificationCriteria,
        onboardingNotes,
        lifecycle: 'pending',
        // Hide pending clients from the booking picker so agents
        // don't accidentally start logging appointments against an
        // unapproved business.
        active: false,
      },
      select: { id: true, name: true, package: true },
    })
    const user = await tx.user.update({
      where: { id: me.id },
      data: {
        clientId: client.id,
        role: 'client_onboarding',
        name: fullName,
      },
      select: { id: true, email: true, name: true },
    })
    return { client, user }
  })

  // Fire-and-forget both notifications so the user-facing API doesn't
  // block on Gmail. If a send fails, it lands in the server log via
  // .catch — admin can resend manually from /clients/onboarding.
  const origin = getPublicOrigin(req)
  const reviewUrl = `${origin}/clients/onboarding`
  const clientSigninUrl = `${origin}/signin/client`
  sendEmail({
    accountEmail: FROM_GMAIL_ACCOUNT,
    to: ADMIN_NOTIFY_EMAIL,
    subject: `[Genisys Hub] Onboarding submitted: ${created.client.name}`,
    body: [
      `**${fullName}** at **${created.client.name}** just completed the onboarding form.`,
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
      `[Review on Hub →](${reviewUrl})`,
      '',
      'Approve or deny on the Onboarding → Pending tab.',
    ]
      .filter(Boolean)
      .join('\n'),
  }).catch((err) => {
    console.error('[client/onboarding-form] admin notify failed:', err)
  })

  // Confirmation email to the client. Sets expectation that admin
  // review is the next step. Includes the sign-in URL so they can
  // bookmark it for when approval lands.
  sendEmail({
    accountEmail: FROM_GMAIL_ACCOUNT,
    to: created.user.email,
    subject: 'Your Lead Genisys application is in review',
    body: [
      `Hi ${fullName},`,
      '',
      `Thanks for completing your onboarding for **${created.client.name}**. Our team is reviewing your application now and will reach out shortly.`,
      '',
      `You will get another email the moment we approve you — at that point you can sign in here and watch your appointments come through in real time:`,
      '',
      `[Sign in →](${clientSigninUrl})`,
      '',
      '— Lead Genisys',
    ].join('\n'),
  }).catch((err) => {
    console.error('[client/onboarding-form] client notify failed:', err)
  })

  return NextResponse.json({
    ok: true,
    clientId: created.client.id,
    clientName: created.client.name,
  })
}
