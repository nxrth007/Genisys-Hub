import { prisma } from '@/lib/prisma'
import { hubAlert, hubLink } from '@/lib/hub-alerts'
import { getWhopCompanyId, listWhopMemberships, listWhopOrders, whopConfigured, type WhopMembership } from '@/lib/whop'
import { textTeam, whopSignupText } from '@/lib/team-sms'
import { markTrackerStep } from '@/lib/onboarding-tracker'

/**
 * Text Alex and Ethan when someone signs up on Whop.
 *
 * Whop isn't set up to call the Hub, so the scheduler checks the newest
 * memberships every 5 minutes and texts about any it hasn't seen. The
 * first check only records who's already there, so turning this on never
 * texts about old sign-ups. Seen ids live in AppSetting `whop.signupAlerts`.
 */

const KEY = 'whop.signupAlerts'
const EVERY_MS = 5 * 60_000
/** Memberships that mean someone actually joined (not a draft checkout). */
const JOINED = new Set(['active', 'trialing', 'completed', 'past_due'])

type State = { seen: string[]; since: string }

/**
 * The new member's name. Whop's profile name is usually blank, so: the
 * membership, then the name on their checkout payment, then the owner's
 * name from the Hub if their email matches a client (the onboarding form
 * often comes first), else null and the text uses the email and username.
 */
async function signupName(m: WhopMembership): Promise<string | null> {
  if (m.customerName) return m.customerName
  const email = m.customerEmail?.trim().toLowerCase()
  if (email) {
    // A free trial's first payment stays "open", so not just paid ones.
    const { orders } = await listWhopOrders({ max: 25, statuses: ['paid', 'open', 'pending', 'unresolved'] }).catch(() => ({ orders: [] as Awaited<ReturnType<typeof listWhopOrders>>['orders'] }))
    const paid = orders.find((o) => o.customerEmail?.trim().toLowerCase() === email && o.customerName)
    if (paid?.customerName) return paid.customerName
    const intake = await prisma.clientIntake
      .findFirst({ where: { leadEmail: { equals: email, mode: 'insensitive' } }, orderBy: { receivedAt: 'desc' }, select: { fullName: true } })
      .catch(() => null)
    if (intake?.fullName?.trim()) return intake.fullName.trim()
    const client = await prisma.client
      .findFirst({ where: { contactEmail: { equals: email, mode: 'insensitive' } }, select: { contactName: true } })
      .catch(() => null)
    if (client?.contactName?.trim()) return client.contactName.trim()
  }
  return null
}

let lastRun = 0
let inFlight = false

export async function maybeAlertWhopSignups(): Promise<number> {
  // The scheduler also runs under `next dev`; only the live Hub texts anyone.
  if (process.env.NODE_ENV !== 'production') return 0
  if (inFlight || Date.now() - lastRun < EVERY_MS) return 0
  lastRun = Date.now()
  inFlight = true
  try {
    if (!(await whopConfigured())) return 0
    const companyId = await getWhopCompanyId()
    if (!companyId) return 0
    const { memberships } = await listWhopMemberships(companyId, 50)
    const row = await prisma.appSetting.findUnique({ where: { key: KEY } })
    const state: State | null = row ? (JSON.parse(row.value) as State) : null

    const save = (s: State) =>
      prisma.appSetting.upsert({ where: { key: KEY }, create: { key: KEY, value: JSON.stringify(s) }, update: { value: JSON.stringify(s) } })

    if (!state) {
      await save({ seen: memberships.filter((m) => JOINED.has(m.status.toLowerCase())).map((m) => m.id), since: new Date().toISOString() })
      console.log(`[whop-signups] baseline: ${memberships.length} existing membership(s); texting new ones from now on`)
      return 0
    }

    const seen = new Set(state.seen)
    const fresh = memberships.filter((m) => !seen.has(m.id) && JOINED.has(m.status.toLowerCase()))
    // Oldest first, so the texts arrive in the order people joined.
    for (const m of fresh.reverse()) {
      const name = await signupName(m)
      const text = whopSignupText({ name, email: m.customerEmail, username: m.customerUsername, product: m.productTitle, price: m.renewalPrice, link: hubLink('/payments') })
      const sent = await textTeam(text, 'Whop sign-up')
      // Ethan's onboarding tracker: tick "Sign-Up Link Completed" (adds the client's row if there isn't one yet).
      const tracked = await markTrackerStep('signup', { emails: [m.customerEmail], name }, { addIfMissing: true })
      if (!tracked.ok) console.warn(`[whop-signups] tracker: ${tracked.detail}`)
      await hubAlert(`:moneybag: *New Whop sign-up* — ${name ?? m.customerEmail ?? 'someone'}${name && m.customerEmail ? ` (${m.customerEmail})` : ''}${m.productTitle ? ` joined *${m.productTitle}*` : ''}${m.renewalPrice ? ` (${m.renewalPrice})` : ''}. <${hubLink('/payments')}|Payments>`).catch(() => {})
      console.log(`[whop-signups] ${m.id}: texted ${sent.filter((s) => s.ok).map((s) => s.name).join(', ') || 'nobody'}`)
      seen.add(m.id)
    }
    // Only joined memberships are remembered: a checkout still in draft is announced once it turns active.
    await save({ seen: [...seen].slice(-1000), since: state.since })
    return fresh.length
  } finally {
    inFlight = false
  }
}
