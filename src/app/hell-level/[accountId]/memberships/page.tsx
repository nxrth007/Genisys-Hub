'use client'

import { Suspense, type ReactNode } from 'react'
import { useParams } from 'next/navigation'
import { useQuery } from '@tanstack/react-query'
import { AlertTriangle, CalendarCheck, CircleDashed, CreditCard, KeyRound } from 'lucide-react'
import { Badge, Card, ErrorNote, PageHeader, Spinner, hlFetch } from '@/components/hell-level/ui'
import { NotYet, money, useSectionTab } from '@/components/hell-level/section'

/** GET /api/hl/accounts/:id/membership (src/lib/hl/membership-plan.ts). */
type Membership = {
  registered: { at: string; how: string } | null
  subAccount: { at: string | null; how: string }
  hellLevel: { at: string; how: string } | null
  daysAsClient: number | null
  timeline: { at: string; label: string }[]
  next: string[]
  ended: string | null
}

/** GoHighLevel's membership areas, which Hell-level doesn't have yet. */
const NOT_YET: Record<string, { title: string; what: string }> = {
  courses: { title: 'Courses', what: 'Video courses with lessons and drip schedules. GHL’s API doesn’t export courses, so nothing comes over from GHL here.' },
  communities: { title: 'Communities', what: 'Member groups with posts and chat.' },
  certificates: { title: 'Certificates', what: 'Certificates for finishing a course.' },
  'client-portal': { title: 'Client Portal', what: 'One login for the business’s customers to reach courses and communities.' },
}

export default function MembershipsPage() {
  return (
    <Suspense
      fallback={
        <div className="flex justify-center py-24">
          <Spinner />
        </div>
      }
    >
      <Memberships />
    </Suspense>
  )
}

function Memberships() {
  const tab = useSectionTab('memberships')
  const n = NOT_YET[tab]
  return n ? <NotYet title={n.title} what={n.what} /> : <MembershipCard />
}

const day = (iso: string) => new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })

function tenure(days: number): string {
  if (days < 1) return 'Joined today'
  if (days < 60) return `Client for ${days} day${days === 1 ? '' : 's'}`
  const months = Math.floor(days / 30.44)
  return months < 24 ? `Client for ${months} months` : `Client for ${Math.floor(months / 12)} years`
}

/** The client's membership with Genisys: when they registered and got their sub-account, and what happened since. */
function MembershipCard() {
  const { accountId } = useParams<{ accountId: string }>()
  const q = useQuery<{ membership: Membership }>({ queryKey: ['hl', 'membership', accountId], queryFn: () => hlFetch(`/api/hl/accounts/${accountId}/membership`) })
  const m = q.data?.membership ?? null
  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-5 px-6 py-7">
      <PageHeader
        title={
          <span className="inline-flex flex-wrap items-center gap-2.5">
            Membership {m?.ended && <Badge color="gray">{m.ended}</Badge>}
          </span>
        }
        description="When the client joined Genisys and got their sub-account, and what’s happened since."
      />
      {q.isLoading ? (
        <div className="flex justify-center py-20">
          <Spinner />
        </div>
      ) : m ? (
        <>
          <div className="grid gap-4 sm:grid-cols-2">
            <DateCard icon={<CalendarCheck className="h-4 w-4" />} label="Registered" at={m.registered?.at ?? null} how={m.registered?.how ?? 'No sign-up on file'} extra={m.daysAsClient !== null ? tenure(m.daysAsClient) : null} />
            <DateCard
              icon={<KeyRound className="h-4 w-4" />}
              label="Got their sub-account"
              at={m.subAccount.at}
              how={m.subAccount.how}
              extra={m.hellLevel ? `${m.hellLevel.how} ${day(m.hellLevel.at)}` : null}
            />
          </div>
          <BillingCard accountId={accountId} />
          <Card className="p-5">
            <h2 className="text-[14px] font-semibold text-foreground">Timeline</h2>
            {m.timeline.length ? (
              <ol className="mt-3 flex flex-col">
                {m.timeline.map((t, i) => (
                  <li key={`${t.at}-${i}`} className="flex items-baseline gap-4 border-t border-border/60 py-2.5 first:border-t-0">
                    <span className="w-28 shrink-0 text-[12.5px] tabular-nums text-muted-foreground">{day(t.at)}</span>
                    <span className="min-w-0 break-words text-[13.5px] text-foreground">{t.label}</span>
                  </li>
                ))}
              </ol>
            ) : (
              <p className="mt-2 text-[13px] text-muted-foreground">Nothing on file yet.</p>
            )}
          </Card>
          {m.next.length > 0 && (
            <Card className="p-5">
              <h2 className="text-[14px] font-semibold text-foreground">Still to come</h2>
              <ul className="mt-3 flex flex-wrap gap-2">
                {m.next.map((x) => (
                  <li key={x} className="inline-flex items-center gap-1.5 rounded-lg border border-border px-2.5 py-1.5 text-[13px] text-foreground/90">
                    <CircleDashed className="h-3.5 w-3.5 text-muted-foreground" /> {x}
                  </li>
                ))}
              </ul>
            </Card>
          )}
        </>
      ) : null}
      <ErrorNote error={q.error} />
    </div>
  )
}

/** GET /api/hl/accounts/:id/billing (src/lib/hl/billing-plan.ts). */
type Billing = {
  matchedBy: string
  email: string | null
  status: string
  label: string
  tone: 'green' | 'amber' | 'red' | 'gray'
  product: string | null
  price: string | null
  joinedAt: string | null
  periodEndsAt: string | null
  periodLabel: string | null
  canceledAt: string | null
  cancellationReason: string | null
  lastPaid: { at: string; amount: number | null; currency: string | null } | null
  paidCount: number
  paidUsd: number
  refundedUsd: number
  card: string | null
  warning: string | null
  otherMemberships: number
}

/** Their Whop membership and payments: read only, nothing here changes anything on Whop. */
function BillingCard({ accountId }: { accountId: string }) {
  const q = useQuery<{ configured: boolean; billing: Billing | null; emails: string[] }>({
    queryKey: ['hl', 'billing', accountId],
    queryFn: () => hlFetch(`/api/hl/accounts/${accountId}/billing`),
  })
  const b = q.data?.billing ?? null
  return (
    <Card className="p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="inline-flex items-center gap-2 text-[14px] font-semibold text-foreground">
          <CreditCard className="h-4 w-4 text-muted-foreground" /> Billing on Whop
        </h2>
        <span className="text-[12px] text-muted-foreground">Read only. Changes are made in Whop.</span>
      </div>
      {q.isLoading ? (
        <div className="flex justify-center py-8">
          <Spinner />
        </div>
      ) : q.error ? (
        <div className="mt-3">
          <ErrorNote error={q.error} />
        </div>
      ) : !q.data?.configured ? (
        <p className="mt-2 text-[13px] text-muted-foreground">Whop isn’t connected (the Vault has no “Whop API Key”).</p>
      ) : !b ? (
        <p className="mt-2 text-[13px] text-muted-foreground">
          {q.data.emails.length ? `No Whop membership found for ${q.data.emails.join(', ')}.` : 'No email on file to look them up on Whop.'}
        </p>
      ) : (
        <div className="mt-3 flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-2.5">
            <Badge color={b.tone} dot>
              {b.label}
            </Badge>
            <span className="text-[14px] font-medium text-foreground">{[b.product, b.price].filter(Boolean).join(' · ') || 'Whop membership'}</span>
          </div>
          {b.warning && (
            <p className={`inline-flex items-start gap-2 rounded-md border px-3 py-2 text-[13px] ${b.tone === 'red' ? 'border-destructive/30 bg-destructive/10 text-destructive' : 'border-amber-500/30 bg-amber-500/10 text-amber-300'}`}>
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" /> {b.warning}
            </p>
          )}
          <dl className="grid gap-x-6 gap-y-2.5 text-[13px] sm:grid-cols-2">
            <Row label="Joined Whop" value={b.joinedAt ? day(b.joinedAt) : null} />
            {b.periodLabel && <Row label={b.periodLabel} value={b.periodEndsAt ? day(b.periodEndsAt) : null} />}
            {b.canceledAt && <Row label="Canceled" value={`${day(b.canceledAt)}${b.cancellationReason ? ` (“${b.cancellationReason}”)` : ''}`} />}
            <Row label="Last payment" value={b.lastPaid ? `${day(b.lastPaid.at)}${b.lastPaid.amount !== null ? ` · ${money(b.lastPaid.amount, (b.lastPaid.currency ?? 'usd').toUpperCase())}` : ''}` : 'None yet'} />
            <Row label="Paid so far" value={`${money(b.paidUsd)} over ${b.paidCount} payment${b.paidCount === 1 ? '' : 's'}${b.refundedUsd ? ` (${money(b.refundedUsd)} refunded)` : ''}`} />
            {b.card && <Row label="Card" value={b.card} />}
          </dl>
          <p className="text-[12px] text-muted-foreground">
            Found by {b.matchedBy}.{b.otherMemberships ? ` They have ${b.otherMemberships} other Whop membership${b.otherMemberships === 1 ? '' : 's'} too.` : ''}
          </p>
        </div>
      )}
    </Card>
  )
}

function Row({ label, value }: { label: string; value: string | null }) {
  return (
    <div className="flex items-baseline justify-between gap-3 border-b border-border/50 pb-2 sm:block sm:border-0 sm:pb-0">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="text-right text-foreground sm:mt-0.5 sm:text-left">{value ?? '—'}</dd>
    </div>
  )
}

function DateCard({ icon, label, at, how, extra }: { icon: ReactNode; label: string; at: string | null; how: string; extra: string | null }) {
  return (
    <Card className="flex flex-col gap-1.5 p-5">
      <span className="inline-flex items-center gap-2 text-[12.5px] font-medium text-muted-foreground">
        {icon} {label}
      </span>
      <span className="text-[22px] font-semibold tracking-tight text-foreground">{at ? day(at) : 'Not on file'}</span>
      <span className="text-[13px] text-muted-foreground">{how}</span>
      {extra && <span className="text-[12.5px] text-muted-foreground/90">{extra}</span>}
    </Card>
  )
}
