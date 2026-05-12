import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/auth'
import { prisma } from '@/lib/prisma'
import { sendEmail, getPublicOrigin } from '@/lib/gmail'

const ADMIN_NOTIFY_EMAIL =
  process.env.CLIENT_ONBOARDING_NOTIFY_EMAIL ||
  process.env.AGENT_APPROVAL_NOTIFY_EMAIL ||
  'alex@leadgenisys.com'
const FROM_GMAIL_ACCOUNT =
  process.env.AGENT_APPROVAL_FROM_EMAIL || ADMIN_NOTIFY_EMAIL

/**
 * POST /api/client/select-plan
 *
 * First step inside /client for newly-registered users (role
 * 'client_pending'). Collects the bare minimum to track the
 * prospect: business name + package picked. Creates the Client
 * row (lifecycle='pending') so admin sees them in the approval
 * queue, and links the caller's User to that Client.
 *
 * Pay-in-full vs. 50%-upfront for Growth is conveyed via the
 * separate `paymentOption` field — admin uses it to know which
 * QuickBooks link the prospect followed. Doesn't change the
 * `package` enum (still 'ppa' | 'growth' | 'pro' | 'custom').
 *
 * Idempotent for the same User: a second POST updates the existing
 * Client instead of creating a duplicate. Lets the user change
 * their mind on plan before admin approves.
 *
 * After admin approves (separate flow at /api/clients/[id]/onboarding-
 * decision), the role flips to 'client_onboarding' and the same
 * /client renders the onboarding form. Submitting THAT moves the
 * client to 'client_active' and they see the live appointments
 * tracker.
 */
const VALID_PACKAGES = new Set(['ppa', 'growth'])
const VALID_PAYMENT_OPTIONS = new Set([
  'ppa',
  'growth_full',
  'growth_half',
])

function trim(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

export async function POST(req: NextRequest) {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }
  if (session.user.role !== 'client_pending') {
    return NextResponse.json(
      {
        error:
          'Plan selection is only available before admin approval. Refresh the page if you think this is wrong.',
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
  const tier = trim(body.tier).toLowerCase()
  const paymentOption = trim(body.paymentOption).toLowerCase()

  if (!businessName) {
    return NextResponse.json(
      { error: 'Business name is required.' },
      { status: 400 },
    )
  }
  if (!VALID_PACKAGES.has(tier)) {
    return NextResponse.json(
      {
        error:
          'Pick a package: pay-per-appointment or Growth Pack.',
      },
      { status: 400 },
    )
  }
  if (!VALID_PAYMENT_OPTIONS.has(paymentOption)) {
    return NextResponse.json(
      { error: 'Pick a payment option.' },
      { status: 400 },
    )
  }
  // Sanity: PPA only ships with ppa option; Growth ships with the
  // two growth_* options. Refuse mismatched combos so the row never
  // ends up with paymentOption='ppa' on a tier='growth' record.
  if (
    (tier === 'ppa' && paymentOption !== 'ppa') ||
    (tier === 'growth' && paymentOption === 'ppa')
  ) {
    return NextResponse.json(
      { error: 'Payment option does not match the selected package.' },
      { status: 400 },
    )
  }

  const me = await prisma.user.findUnique({
    where: { id: session.user.id },
    select: { id: true, email: true, clientId: true },
  })
  if (!me) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  // If the user already has a linked Client (they clicked plan-picker
  // a second time before admin approved), update it instead of
  // creating a duplicate. Otherwise create fresh and link.
  if (me.clientId) {
    const existing = await prisma.client.findUnique({
      where: { id: me.clientId },
      select: { id: true, lifecycle: true },
    })
    if (existing && existing.lifecycle === 'pending') {
      const updated = await prisma.client.update({
        where: { id: existing.id },
        data: {
          name: businessName,
          package: tier,
          // Stash the payment option in onboardingNotes prefix so
          // admin sees "(Growth — 50% upfront)" in the review queue.
          // Cleaner than adding a column for a value we mostly only
          // use at review time.
          onboardingNotes: paymentOptionNote(paymentOption),
        },
        select: { id: true, name: true, package: true },
      })
      notifyAdminPlanSelected(req, {
        kind: 'changed',
        clientName: updated.name,
        package: updated.package,
        paymentOption,
        userEmail: me.email,
      })
      return NextResponse.json({
        ok: true,
        clientId: updated.id,
        package: updated.package,
      })
    }
    // Edge case: clientId points at a Client that's no longer pending
    // (admin somehow advanced lifecycle independently). Refuse to
    // mutate — surface a clear error instead.
    return NextResponse.json(
      {
        error:
          'Your account has already advanced past plan selection. Refresh the page.',
      },
      { status: 409 },
    )
  }

  // Block name collisions with existing clients — Client.name is
  // unique. Friendly error rather than a Prisma constraint blow-up.
  const nameTaken = await prisma.client.findUnique({
    where: { name: businessName },
    select: { id: true },
  })
  if (nameTaken) {
    return NextResponse.json(
      {
        error:
          'A client with that business name already exists. If that\'s you, contact your account manager.',
      },
      { status: 409 },
    )
  }

  // Create the Client + link to user in one tx so we never end up
  // with a half-created prospect.
  const created = await prisma.$transaction(async (tx) => {
    const client = await tx.client.create({
      data: {
        name: businessName,
        package: tier,
        contactEmail: me.email,
        onboardingNotes: paymentOptionNote(paymentOption),
        lifecycle: 'pending',
        active: false,
      },
      select: { id: true, name: true, package: true },
    })
    await tx.user.update({
      where: { id: me.id },
      data: { clientId: client.id },
    })
    return client
  })

  notifyAdminPlanSelected(req, {
    kind: 'new',
    clientName: created.name,
    package: created.package,
    paymentOption,
    userEmail: me.email,
  })

  return NextResponse.json({
    ok: true,
    clientId: created.id,
    package: created.package,
  })
}

/** Fire-and-forget admin email at the moment the prospect picks a plan
 *  and gets sent to QuickBooks — this is the actual "ready for review"
 *  signal. The register-step email is too early (no business name yet);
 *  the onboarding-form email is too late (post-approval). This one
 *  lands when the prospect actually shows up on the Pending tab. */
function notifyAdminPlanSelected(
  req: NextRequest,
  payload: {
    kind: 'new' | 'changed'
    clientName: string
    package: string
    paymentOption: string
    userEmail: string | null
  },
) {
  const origin = getPublicOrigin(req)
  const label = paymentOptionNote(payload.paymentOption) || payload.paymentOption
  const subject =
    payload.kind === 'new'
      ? `[Genisys Hub] Plan picked — ready for review: ${payload.clientName}`
      : `[Genisys Hub] Plan changed (still pending): ${payload.clientName}`
  const lead =
    payload.kind === 'new'
      ? `**${payload.clientName}** just picked a plan and was sent to QuickBooks to pay. They are now on the Pending tab waiting for your approval (once Ethan confirms payment landed).`
      : `**${payload.clientName}** changed their plan selection before approval. Updated selection below.`
  sendEmail({
    accountEmail: FROM_GMAIL_ACCOUNT,
    to: ADMIN_NOTIFY_EMAIL,
    subject,
    body: [
      lead,
      '',
      `Package: ${payload.package}`,
      `${label}`,
      payload.userEmail ? `Signin email: ${payload.userEmail}` : '',
      '',
      `[Open Pending tab →](${origin}/clients/onboarding)`,
    ]
      .filter(Boolean)
      .join('\n'),
  }).catch((err) => {
    console.error('[client/select-plan] admin notify failed:', err)
  })
}

/** Human-readable payment-option label that gets stashed in
 *  onboardingNotes so admin sees "(Growth — 50% upfront)" in the
 *  approval queue. Replaced verbatim if the user submits the full
 *  onboarding form later (which has its own Additional notes field). */
function paymentOptionNote(opt: string): string {
  if (opt === 'ppa') return 'Selected: Pay-per-appointment'
  if (opt === 'growth_full') return 'Selected: Growth Pack — Pay in full'
  if (opt === 'growth_half')
    return 'Selected: Growth Pack — Pay 50% upfront'
  return ''
}
