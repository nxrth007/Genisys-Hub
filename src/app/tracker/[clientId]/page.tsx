'use client'

/**
 * One client on the Tracker: the three milestones (Stripe → Onboarding → Site)
 * with what the team does next, the contact and business details, and the
 * fulfillment list (sub-account, domain, phone number, texting registration,
 * automations, Google profile, SEO, and QA) with each step's evidence and a
 * link to where to act. A person marks the final check here, and the
 * sheet-era steps by hand. A Stripe sign-up with no client yet opens here too
 * (its id is the Stripe customer id): what Stripe knows, and who it might be.
 * Reads /api/tracker/<id>. Staff only.
 */
import { useState } from 'react'
import Link from 'next/link'
import { useParams } from 'next/navigation'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowLeft, ExternalLink, Link2, RefreshCw } from 'lucide-react'
import { cn } from '@/lib/utils'
import { shortDate } from '@/lib/stripe-billing-plan'
import { FULFILLMENT, MILESTONES, STEP_MEANS, STEP_TITLE, isHandStep, isManualStep, type StepState, type TrackStep, type TrackerRow } from '@/lib/tracker/derive'
import { Mark, NextActionText, markTitle, rowTitle, signedUpLong } from '../ui'

type Profile = { person: string | null; email: string | null; phone: string | null; business: string | null; services: string | null; address: string | null; website: string | null }
type HistoryEvent = { id: string; stage: string; fromStatus: string | null; toStatus: string; note: string | null; actor: string | null; createdAt: string }
type Detail = {
  row: TrackerRow
  profile: Profile
  billing: { asOf: string | null; error: string | null; account: { id: string | null; name: string | null } | null }
  events: HistoryEvent[]
  asOf: string
}

const MILESTONE_LABEL: Partial<Record<TrackStep, string>> = { signup: 'Stripe', intake: 'Onboarding', website: 'Site' }
const FULFILL_LABEL: Partial<Record<TrackStep, string>> = {
  subaccount: 'Sub-account',
  domain: 'Domain',
  number: 'Phone number',
  texting: 'Texting registration',
  automations: 'Automations',
  gbp: 'Google profile',
  seo: 'SEO',
  qa: 'QA (test & final check)',
}
const labelOf = (s: TrackStep) => FULFILL_LABEL[s] ?? MILESTONE_LABEL[s] ?? STEP_TITLE[s]
const past = (st: StepState) => st === 'done' || st === 'not_needed'

const button = 'inline-flex h-8 items-center gap-1.5 rounded-md border border-border bg-card px-2.5 text-[12.5px] text-muted-foreground transition hover:bg-muted hover:text-foreground disabled:opacity-50'
const quiet = 'text-[12px] text-muted-foreground underline-offset-2 transition hover:text-foreground hover:underline disabled:opacity-50'

function Href({ href, children, className }: { href: string; children: React.ReactNode; className?: string }) {
  const cls = cn('inline-flex items-center gap-1 text-primary underline-offset-2 hover:underline', className)
  if (/^https?:\/\//i.test(href)) {
    return (
      <a href={href} target="_blank" rel="noreferrer" className={cls}>
        {children}
        <ExternalLink className="h-3 w-3 shrink-0" />
      </a>
    )
  }
  if (/^(mailto|tel|sms):/i.test(href)) {
    return (
      <a href={href} className={cls}>
        {children}
      </a>
    )
  }
  return (
    <Link href={href} className={cls}>
      {children}
    </Link>
  )
}

/** The short line under a milestone: the plan, when the form came in, where the site lives. */
function caption(s: TrackStep, row: TrackerRow): string | null {
  const v = row.steps[s]
  if (v.byHand) return 'Marked done by hand'
  if (s === 'signup') {
    if (row.billing && row.billing.state !== 'none') return row.billing.text
    return v.state === 'none' ? 'Couldn’t be read' : 'Not in Stripe'
  }
  if (s === 'intake') return v.state === 'done' ? (v.at ? `Received ${shortDate(v.at)}` : 'Received') : 'Not received yet'
  if (s === 'website') {
    if (v.state === 'done') return v.note?.replace(/^Live at /, '') ?? 'Live'
    return v.empty ? 'Not started' : v.note
  }
  return v.note
}

/** Who made a mark, for the history: a name from an email, or nothing for a bare user id. */
function byWhom(actor: string | null): string {
  if (!actor) return ''
  if (actor === 'board') return ' from its board'
  if (actor.startsWith('api:')) return ' through the API'
  if (actor.includes('@')) return ` by ${actor.split('@')[0]}`
  return /^c[a-z0-9]{20,}$/.test(actor) ? '' : ` by ${actor}`
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h2 className="mb-1.5 text-[17px] font-semibold tracking-[-0.01em] text-foreground">{title}</h2>
      {children}
    </section>
  )
}

/** A label and its value, on a hairline, the way the reference lays out Contact and Business. */
function Field({ label, value, href }: { label: string; value: string | null | undefined; href?: string | null }) {
  return (
    <div className="grid grid-cols-[8.5rem_minmax(0,1fr)] items-baseline gap-4 border-b border-border-soft py-3 text-[13.5px]">
      <span className="text-muted-foreground">{label}</span>
      {value ? href ? <Href href={href} className="min-w-0 break-all">{value}</Href> : <span className="min-w-0 break-words text-foreground">{value}</span> : <span className="text-muted-foreground/50">—</span>}
    </div>
  )
}

export default function TrackerClientPage() {
  const { clientId } = useParams<{ clientId: string }>()
  const qc = useQueryClient()
  const [msg, setMsg] = useState<string | null>(null)
  const key = ['tracker-client', clientId]

  const detail = useQuery<Detail>({
    queryKey: key,
    queryFn: async () => {
      const r = await fetch(`/api/tracker/${encodeURIComponent(clientId)}`)
      if (!r.ok) throw new Error(r.status === 404 ? 'There’s no client or Stripe sign-up with this id.' : `HTTP ${r.status}`)
      return r.json()
    },
    staleTime: 30_000,
  })

  const refresh = useMutation({
    mutationFn: async (): Promise<Detail> => {
      const r = await fetch(`/api/tracker/${encodeURIComponent(clientId)}?refresh=1`)
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      return r.json()
    },
    onSuccess: (data) => {
      qc.setQueryData(key, data)
      qc.invalidateQueries({ queryKey: ['tracker'] })
    },
    onError: (e) => setMsg(String(e instanceof Error ? e.message : e)),
  })

  const mark = useMutation({
    mutationFn: async (v: { step: TrackStep; status: 'done' | 'pending'; note?: string | null }) => {
      const r = await fetch('/api/tracker', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ clientId, ...v }) })
      if (!r.ok) throw new Error((await r.json().catch(() => null))?.error ?? `HTTP ${r.status}`)
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: key })
      qc.invalidateQueries({ queryKey: ['tracker'] })
    },
    onError: (e) => setMsg(String(e instanceof Error ? e.message : e)),
  })

  async function copyLink() {
    const r = await fetch(`/api/tracker/${encodeURIComponent(clientId)}/link`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
    const j = await r.json().catch(() => null)
    if (!r.ok || !j?.path) return setMsg(j?.error ?? `Could not create link (HTTP ${r.status})`)
    const url = `${window.location.origin}${j.path}`
    await navigator.clipboard.writeText(url).catch(() => {})
    setMsg(`Status link copied (not sent): ${url}`)
  }

  const back = (
    <Link href="/tracker" className="inline-flex items-center gap-1.5 text-[13px] text-muted-foreground transition hover:text-foreground">
      <ArrowLeft className="h-3.5 w-3.5" />
      Tracker
    </Link>
  )

  if (detail.isLoading) {
    return (
      <div className="mx-auto max-w-4xl space-y-4 p-6">
        {back}
        <p className="text-[12.5px] text-muted-foreground">Reading Stripe, Genisys OS and the boards…</p>
      </div>
    )
  }
  if (detail.error || !detail.data) {
    return (
      <div className="mx-auto max-w-4xl space-y-4 p-6">
        {back}
        <p className="text-[13px] text-destructive">{String(detail.error instanceof Error ? detail.error.message : detail.error ?? 'Nothing came back.')}</p>
      </div>
    )
  }

  const { row, profile, events } = detail.data
  const title = rowTitle(row)

  /** Mark done / clear, for the steps a person can mark. Stripe itself is never marked by hand. */
  function handControls(s: TrackStep, prominent = false) {
    if (row.stripeOnly || !isHandStep(s) || s === 'signup') return null
    const v = row.steps[s]
    const marked = s === 'qa' ? v.state === 'done' : isManualStep(s) && row.manual[s] === 'done'
    if (marked) {
      return (
        <button type="button" className={quiet} disabled={mark.isPending} onClick={() => mark.mutate({ step: s, status: 'pending' })}>
          {s === 'qa' ? 'Undo' : 'Clear mark'}
        </button>
      )
    }
    if (v.state === 'done') return null
    return (
      <button
        type="button"
        className={prominent ? 'rounded-md border border-border bg-card px-2.5 py-1 text-[12px] font-medium text-foreground transition hover:bg-muted disabled:opacity-50' : quiet}
        disabled={mark.isPending}
        onClick={() => {
          const note = prompt(
            s === 'qa'
              ? `Mark the final check done for ${title}? Note what you tested (optional).`
              : `Mark "${labelOf(s)}" done by hand for ${title}? Why? (optional)`,
          )
          if (note === null) return
          mark.mutate({ step: s, status: 'done', note: note.trim() || null })
        }}
      >
        {s === 'qa' ? 'Mark QA done' : 'Mark done'}
      </button>
    )
  }

  return (
    <div className="mx-auto max-w-4xl space-y-8 p-6">
      {/* ---- Who ---- */}
      <div className="space-y-3">
        {back}
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <h1 className="flex flex-wrap items-center gap-2 text-[28px] font-semibold leading-tight tracking-[-0.02em]">
              {title}
              {row.archived && <span className="rounded bg-muted px-1.5 py-0.5 text-[11px] font-medium uppercase tracking-normal text-muted-foreground">Archived</span>}
              {row.lifecycle !== 'active' && row.lifecycle !== 'onboarding' && (
                <span className="rounded bg-muted px-1.5 py-0.5 text-[11px] font-medium uppercase tracking-normal text-muted-foreground">{row.lifecycle}</span>
              )}
            </h1>
            <p className="mt-1 text-[14px] text-muted-foreground">Signed up {signedUpLong(row.signedUpAt)}</p>
          </div>
          <div className="flex items-center gap-1.5">
            {row.stripeOnly
              ? row.steps.signup.href && (
                  <a href={row.steps.signup.href} target="_blank" rel="noreferrer" className={button}>
                    <ExternalLink className="h-3.5 w-3.5" />
                    Open in Stripe
                  </a>
                )
              : (
                  <button type="button" className={button} onClick={copyLink} title="Copy the client's read-only status link (nothing is sent)">
                    <Link2 className="h-3.5 w-3.5" />
                    Status link
                  </button>
                )}
            <button type="button" className={cn(button, 'w-8 justify-center px-0')} disabled={refresh.isPending} onClick={() => refresh.mutate()} title="Re-read Stripe and every board now" aria-label="Refresh">
              <RefreshCw className={cn('h-3.5 w-3.5', refresh.isPending && 'animate-spin')} />
            </button>
          </div>
        </div>
      </div>

      {msg && (
        <p className="cursor-pointer break-all rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-[12.5px]" onClick={() => setMsg(null)}>
          {msg}
        </p>
      )}

      {/* ---- Milestones and the next action ---- */}
      <div className="space-y-6">
        <ol className="mx-auto grid max-w-2xl grid-cols-3">
          {MILESTONES.map((s, i) => {
            const v = row.steps[s]
            const nextStep = MILESTONES[i + 1]
            const lit = !!nextStep && past(v.state) && past(row.steps[nextStep].state)
            return (
              <li key={s} className="relative flex flex-col items-center px-2 text-center">
                {nextStep && <span aria-hidden className={cn('absolute left-[calc(50%+28px)] top-[19px] h-0.5 w-[calc(100%-56px)] rounded-full', lit ? 'bg-success/60' : 'bg-muted-foreground/25')} />}
                <span title={markTitle(v)} className="inline-flex">
                  <Mark state={v.state} size="lg" byHand={v.byHand} />
                </span>
                <span className="mt-2.5 text-[15px] font-semibold text-foreground">{MILESTONE_LABEL[s]}</span>
                <span className="mt-0.5 line-clamp-2 max-w-[11rem] text-[12px] leading-snug text-muted-foreground" title={v.note ?? undefined}>
                  {caption(s, row)}
                </span>
                {s === 'intake' && <span className="mt-1">{handControls(s)}</span>}
              </li>
            )
          })}
        </ol>

        <div className="space-y-2 text-center">
          {row.next.kind === 'done' ? (
            <span className="chip-mint inline-flex items-center rounded-full px-3 py-1 text-[14px] font-medium">Done: every step is complete</span>
          ) : (
            <NextActionText next={row.next} stuckDays={row.stuckDays} stuck={row.stuck} prefix="Next action: " className="text-[17px] font-semibold" />
          )}
          {row.stripeOnly && (
            <p className="mx-auto max-w-xl text-[12.5px] leading-relaxed text-muted-foreground">
              {row.suggestion ? (
                <>
                  Stripe has no client under this email. The name looks like{' '}
                  <Link href={`/tracker/${row.suggestion.clientId}`} className="text-primary underline-offset-2 hover:underline">
                    {row.suggestion.name}
                  </Link>
                  : if it’s them, add this email to their client record and the Hub will match them.
                </>
              ) : (
                'Stripe has this sign-up, but no onboarding form has come in under this email yet. The client appears in the Hub once it does.'
              )}
            </p>
          )}
        </div>
      </div>

      <div className="border-t border-border" />

      {/* ---- Contact and business ---- */}
      <div className="grid gap-x-12 gap-y-8 md:grid-cols-2">
        <Section title="Contact">
          <Field label="Name" value={profile.person} />
          <Field label="Phone" value={profile.phone} href={profile.phone && profile.phone.replace(/\D/g, '').length >= 10 ? `tel:${profile.phone.replace(/[^\d+]/g, '')}` : null} />
          <Field label="Email" value={profile.email} href={profile.email ? `mailto:${profile.email}` : null} />
        </Section>
        <Section title="Business">
          <Field label="Business name" value={profile.business} />
          <Field label="Services" value={profile.services} />
          <Field label="Address" value={profile.address} />
          <Field label="Website" value={profile.website?.replace(/^https?:\/\//i, '').replace(/\/$/, '') ?? null} href={profile.website} />
        </Section>
      </div>

      <div className="border-t border-border" />

      {/* ---- Fulfillment ---- */}
      <Section title="Fulfillment">
        <div>
          {FULFILLMENT.map((s) => {
            const v = row.steps[s]
            const blank = v.empty || !v.note
            return (
              <div key={s} className="flex items-start gap-3 border-b border-border-soft py-3 text-[13.5px]">
                <span title={markTitle(v)} className="inline-flex pt-px">
                  <Mark state={v.state} byHand={v.byHand} />
                </span>
                <div className="min-w-0 flex-1 sm:grid sm:grid-cols-[13rem_minmax(0,1fr)] sm:gap-4">
                  <span className="block text-foreground" title={STEP_MEANS[s]}>
                    {labelOf(s)}
                  </span>
                  <span className="block min-w-0">
                    {blank ? <span className="text-muted-foreground/50">—</span> : <span className={cn('break-words', v.state === 'done' ? 'text-foreground' : 'text-muted-foreground')}>{v.note}</span>}
                    {!blank && v.at && <span className="ml-2 whitespace-nowrap text-[12px] text-muted-foreground/70">{shortDate(v.at)}</span>}
                  </span>
                </div>
                <span className="flex shrink-0 items-center gap-3 pt-px">
                  {v.href && (
                    <Href href={v.href} className="text-[12px]">
                      Open
                    </Href>
                  )}
                  {handControls(s, s === 'qa')}
                </span>
              </div>
            )
          })}
        </div>
      </Section>

      {/* ---- What people marked ---- */}
      {events.length > 0 && (
        <Section title="History">
          <ul className="space-y-1.5 text-[12.5px] text-muted-foreground">
            {events.map((e) => {
              const step = e.stage.replace(/^tracker\./, '')
              const name = (FULFILL_LABEL as Record<string, string>)[step] ?? (STEP_TITLE as Record<string, string>)[step] ?? step
              return (
                <li key={e.id}>
                  <span className="text-foreground/80">{shortDate(e.createdAt)}</span> · {name} {e.toStatus === 'done' ? 'marked done' : 'cleared'}
                  {byWhom(e.actor)}
                  {e.note ? ` — ${e.note}` : ''}
                </li>
              )
            })}
          </ul>
        </Section>
      )}
    </div>
  )
}
