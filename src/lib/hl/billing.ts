/**
 * A sub-account's Whop billing for Hell-level → Memberships: read only (Alex, 2026-11-14). Whop's
 * memberships and payments are read with the Vault key (src/lib/whop.ts, which never writes) and kept
 * five minutes, so opening a few sub-accounts in a row asks Whop once. ./billing-plan.ts picks theirs.
 */
import { prisma } from '@/lib/prisma'
import { getWhopCompanyId, listWhopMemberships, listWhopOrders, whopConfigured, type WhopMembership, type WhopOrder } from '@/lib/whop'
import { billingOf, membershipIdFrom, normEmail, type Billing } from './billing-plan'

const KEEP_MS = 5 * 60_000

type WhopData = { at: number; memberships: WhopMembership[]; orders: WhopOrder[] }
let kept: WhopData | null = null
let loading: Promise<WhopData> | null = null

async function whopData(): Promise<WhopData> {
  if (kept && Date.now() - kept.at < KEEP_MS) return kept
  loading ??= (async () => {
    const companyId = await getWhopCompanyId()
    if (!companyId) throw new Error('The Hub couldn’t tell which Whop account to read (Payments → Whop → Run diagnostic).')
    // Every payment status: a free month's first charge stays "open" until it's paid.
    const [{ memberships }, { orders }] = await Promise.all([listWhopMemberships(companyId, 500), listWhopOrders({ max: 1000, statuses: [] })])
    kept = { at: Date.now(), memberships, orders }
    return kept
  })().finally(() => {
    loading = null
  })
  return loading
}

export type BillingView = {
  /** Whop's key is in the Vault. */
  configured: boolean
  billing: Billing | null
  /** The emails looked for, when nothing matched. */
  emails: string[]
}

export async function readBilling(accountId: string): Promise<BillingView | null> {
  const a = await prisma.hlAccount.findUnique({
    where: { id: accountId },
    select: { profile: true, clientId: true, members: { select: { user: { select: { email: true } } } } },
  })
  if (!a) return null
  const c = a.clientId
    ? await prisma.client.findUnique({
        where: { id: a.clientId },
        select: {
          contactEmail: true,
          siteUrl: true,
          intakes: { select: { leadEmail: true } },
          tracker: { select: { contactEmail: true } },
          journeyStages: { where: { stage: 'signup' }, select: { note: true } },
        },
      })
    : null
  const notify = (a.profile as { notifyEmail?: unknown } | null)?.notifyEmail
  const emails = [
    ...new Set(
      [c?.contactEmail, ...(c?.intakes.map((i) => i.leadEmail) ?? []), c?.tracker?.contactEmail, typeof notify === 'string' ? notify : null, ...a.members.map((m) => m.user.email)]
        .map(normEmail)
        .filter((e): e is string => !!e),
    ),
  ]
  if (!(await whopConfigured())) return { configured: false, billing: null, emails }
  const membershipId = membershipIdFrom(c?.journeyStages[0]?.note)
  if (!emails.length && !membershipId) return { configured: true, billing: null, emails }
  const data = await whopData()
  return { configured: true, billing: billingOf(data.memberships, data.orders, { membershipId, emails, siteLive: !!c?.siteUrl?.trim() }), emails }
}
