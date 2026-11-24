'use client'

import { useMemo, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, Check, ExternalLink, Loader2, Search, Send } from 'lucide-react'
import { cn } from '@/lib/utils'
import { PageHeader } from '@/components/ui/page-header'
import { GBP_STATUS_LABEL, instructionsText, type GbpInputs } from '@/lib/gbp-kit'
import { listingTown } from '@/lib/gbp-plan'
import type { GbpRow } from '@/lib/gbp-setup'

type View = 'send' | 'waiting' | 'check' | 'done' | 'unknown' | 'all'

const VIEWS: { id: View; label: string; title: string; match: (r: GbpRow) => boolean }[] = [
  { id: 'send', label: 'To send', title: 'No Google profile, and their setup page hasn’t gone out', match: (r) => r.status === 'needed' || r.status === 'existing' },
  { id: 'waiting', label: 'Waiting on client', title: 'Their page went out; the Hub reminds them every 3 days', match: (r) => r.status === 'verifying' },
  { id: 'check', label: 'To check', title: 'They sent their profile link: check it and mark it verified', match: (r) => r.status === 'created' },
  { id: 'done', label: 'Done', title: 'Verified, or they already had one', match: (r) => r.status === 'verified' || r.status === 'has_profile' },
  { id: 'unknown', label: 'No answer', title: 'The onboarding form doesn’t say', match: (r) => !r.status },
  { id: 'all', label: 'All', title: 'Every client', match: () => true },
]

/** One tap may send theirs: nothing stops it, and it isn't out or on its way. */
const canSend = (r: GbpRow) => !r.block && r.status !== 'verifying' && r.status !== 'created' && (r.page === 'not_sent' || r.page === 'asked' || r.page === 'failed' || r.page === 'skipped')

/** Waiting for its first Google Maps check (one Google didn't answer says so in its row and is tried again later). */
const toCheck = (r: GbpRow) => (r.status === 'needed' || r.status === 'existing') && r.listing === 'unchecked' && !r.lookupError

const shortDay = (iso: string) => new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
const SAMPLE = { ownerFirstName: 'Sam', businessName: 'Acme Roofing' } as GbpInputs

/** /google-profiles — every client's Google Business Profile: look over who still needs one, and send their setup pages. */
export default function GoogleProfilesPage() {
  const router = useRouter()
  const qc = useQueryClient()
  const [view, setView] = useState<View>('send')
  const [search, setSearch] = useState('')
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const q = useQuery({
    queryKey: ['gbp-rows'],
    queryFn: async (): Promise<{ clients: GbpRow[] }> => {
      const res = await fetch('/api/gbp', { cache: 'no-store' })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || 'Failed to load')
      return data
    },
    // While pages go out or Google Maps is being checked, keep the list current.
    refetchInterval: (query) => ((query.state.data?.clients ?? []).some((r) => r.page === 'sending' || (r.page === 'queued' && !r.later) || toCheck(r)) ? 20_000 : false),
  })
  const all = useMemo(() => q.data?.clients ?? [], [q.data])
  const counts = useMemo(() => Object.fromEntries(VIEWS.map((v) => [v.id, all.filter(v.match).length])) as Record<View, number>, [all])
  const rows = useMemo(() => {
    const v = VIEWS.find((x) => x.id === view)!
    const s = search.trim().toLowerCase()
    return all.filter((r) => v.match(r) && (!s || `${r.name} ${r.businessName} ${r.owner.first} ${r.owner.email}`.toLowerCase().includes(s)))
  }, [all, view, search])
  const sendable = rows.filter(canSend)
  const chosen = sendable.filter((r) => picked.has(r.id))
  // "Pick all" leaves out Not now and any that didn't go out (one may have): they're picked one by one.
  const bulk = sendable.filter((r) => r.page !== 'skipped' && r.page !== 'failed')
  const allPicked = bulk.length > 0 && bulk.every((r) => picked.has(r.id))
  const unchecked = all.filter(toCheck).length

  const act = useMutation({
    mutationFn: async (a: { action: 'send' | 'skip'; ids: string[] }) => {
      const res = await fetch('/api/gbp', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(a) })
      const out = (await res.json().catch(() => ({}))) as { queued?: string[]; left?: { name: string; why: string }[]; skipped?: string[]; error?: string }
      if (!res.ok) throw new Error(out.error || `HTTP ${res.status}`)
      return out
    },
    onSuccess: (out) => {
      const left = (out.left ?? []).map((l) => `${l.name}: ${l.why}`).join(' ')
      setMsg({
        ok: !left,
        text: out.queued
          ? `${out.queued.length} setup page${out.queued.length === 1 ? '' : 's'} queued. Each goes out between 9 AM and 7 PM where the owner is.${left ? ` Left out: ${left}` : ''}`
          : `${out.skipped?.length ?? 0} set to Not now.`,
      })
      setPicked(new Set())
      void qc.invalidateQueries({ queryKey: ['gbp-rows'] })
    },
    onError: (err) => setMsg({ ok: false, text: err instanceof Error ? err.message : String(err) }),
  })

  function send() {
    const n = chosen.length
    if (!n) return
    const who = n === 1 ? chosen[0].name : `${n} owners`
    if (!window.confirm(`Text and email ${who} their Google profile setup page?\n\nEach goes out between 9 AM and 7 PM where they are. The Hub then reminds them every 3 days, up to 5 times, until they’re done.`)) return
    act.mutate({ action: 'send', ids: chosen.map((r) => r.id) })
  }
  const toggle = (id: string) =>
    setPicked((prev) => {
      const next = new Set(prev)
      if (!next.delete(id)) next.add(id)
      return next
    })

  return (
    <div className="space-y-4 p-6">
      <PageHeader
        title="Google Profiles"
        subtitle="Look over who still needs a Google Business Profile and send their setup page: claim the listing Google already has, or make a new one from our answers."
        breadcrumbs={[{ label: 'Genisys' }, { label: 'Google Profiles' }]}
        actions={
          <a href="https://business.google.com/create" target="_blank" rel="noreferrer" className={btn}>
            Create one ourselves <ExternalLink className="h-3.5 w-3.5" />
          </a>
        }
      />

      <div className="flex flex-wrap items-center gap-1.5">
        {VIEWS.map((v) => (
          <button
            key={v.id}
            type="button"
            title={v.title}
            onClick={() => setView(v.id)}
            className={cn(
              'inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-[12.5px] transition',
              view === v.id ? 'bg-primary-soft font-medium text-foreground' : 'text-muted-foreground hover:bg-muted hover:text-foreground',
            )}
          >
            {v.label}
            <span className="font-mono text-[11px] tabular-nums opacity-70">{counts[v.id] ?? 0}</span>
          </button>
        ))}
        <label className="relative ml-auto">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search client or owner"
            className="h-8 w-60 rounded-md border border-border bg-transparent pl-8 pr-3 text-[12.5px] outline-none transition placeholder:text-muted-foreground/70 hover:bg-card focus:border-foreground/30"
          />
        </label>
      </div>

      {unchecked > 0 && view === 'send' && (
        <p className="flex items-center gap-2 text-[12px] text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin" /> Checking Google Maps: {unchecked} client{unchecked === 1 ? '' : 's'} to go. A page can’t go out until theirs is checked.
        </p>
      )}
      {msg && (
        <p
          className={cn('cursor-pointer rounded-md border px-3 py-2 text-[12.5px]', msg.ok ? 'border-emerald-500/30 bg-emerald-500/10' : 'border-warning/40 bg-warning/10')}
          onClick={() => setMsg(null)}
        >
          {msg.text}
        </p>
      )}

      {q.isLoading ? (
        <p className="flex items-center gap-2 py-8 text-[12.5px] text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading…
        </p>
      ) : q.error ? (
        <p className="text-[12.5px] text-destructive">{(q.error as Error).message}</p>
      ) : (
        <>
          {sendable.length > 0 && (
            <div className="flex min-h-8 flex-wrap items-center gap-2 text-[12.5px]">
              <label className="inline-flex cursor-pointer items-center gap-2 text-muted-foreground">
                <input
                  type="checkbox"
                  checked={allPicked}
                  ref={(el) => {
                    if (el) el.indeterminate = chosen.length > 0 && !allPicked
                  }}
                  onChange={(e) => setPicked(e.target.checked ? new Set(bulk.map((r) => r.id)) : new Set())}
                  className="h-3.5 w-3.5 accent-foreground"
                />
                {chosen.length ? `${chosen.length} picked` : `Pick all ${bulk.length} that can go`}
              </label>
              {chosen.length > 0 && (
                <>
                  <button type="button" onClick={send} disabled={act.isPending} className={btnPrimary}>
                    {act.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />} Send setup page to {chosen.length}
                  </button>
                  <button type="button" onClick={() => act.mutate({ action: 'skip', ids: chosen.map((r) => r.id) })} disabled={act.isPending} className={btn} title="Leave them out for now; they stay in this list">
                    Not now
                  </button>
                </>
              )}
            </div>
          )}
          <div className="overflow-x-auto">
            <table className="w-full min-w-[58rem] text-[13px]">
              <thead>
                <tr className="border-b border-border text-left text-[12px] text-muted-foreground">
                  <th className="w-7 py-2.5" aria-label="Pick" />
                  <th className="py-2.5 pr-3 font-medium">Client</th>
                  <th className="px-2 py-2.5 font-medium">Goes to</th>
                  <th className="px-2 py-2.5 font-medium">On Google Maps</th>
                  <th className="px-2 py-2.5 font-medium">Setup page</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border-soft">
                {rows.length === 0 && (
                  <tr>
                    <td colSpan={5} className="py-10 text-center text-[12.5px] text-muted-foreground">
                      No clients here.
                    </td>
                  </tr>
                )}
                {rows.map((r) => {
                  const href = `/clients/${r.id}/gbp`
                  const renamed = r.businessName && r.businessName.toLowerCase() !== r.name.toLowerCase() ? r.businessName : null
                  return (
                    <tr key={r.id} onClick={() => router.push(href)} className="cursor-pointer align-top transition hover:bg-muted/40">
                      <td className="py-3" onClick={(e) => e.stopPropagation()}>
                        {canSend(r) && <input type="checkbox" checked={picked.has(r.id)} onChange={() => toggle(r.id)} aria-label={`Pick ${r.name}`} className="mt-0.5 h-3.5 w-3.5 accent-foreground" />}
                      </td>
                      <td className="max-w-[18rem] py-3 pr-3">
                        <Link href={href} onClick={(e) => e.stopPropagation()} className="block truncate text-[13.5px] font-semibold text-foreground">
                          {r.name}
                        </Link>
                        <span className="block truncate text-[12px] text-muted-foreground">{[renamed, r.category].filter(Boolean).join(' · ') || 'No category'}</span>
                        {r.block && view !== 'done' ? (
                          <span className="mt-0.5 flex items-start gap-1 text-[12px] leading-snug text-warning">
                            <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" /> {r.block}
                          </span>
                        ) : (
                          r.notes.length > 0 && r.page !== 'done' && <span className="mt-0.5 block text-[12px] text-muted-foreground/80">{r.notes.join(' · ')}</span>
                        )}
                      </td>
                      <td className="px-2 py-3 leading-snug">
                        <span className="block">{r.owner.first || 'No first name'}</span>
                        <span className="block text-[12px] text-muted-foreground">{r.owner.phone || 'no cell'}</span>
                        <span className="block max-w-[15rem] truncate text-[12px] text-muted-foreground">{r.owner.email || 'no email'}</span>
                      </td>
                      <td className="max-w-[15rem] px-2 py-3 leading-snug" onClick={(e) => e.stopPropagation()}>
                        <Maps r={r} />
                      </td>
                      <td className="px-2 py-3 leading-snug">
                        <Page r={r} cancel={() => act.mutate({ action: 'skip', ids: [r.id] })} busy={act.isPending} />
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </>
      )}

      <details className="text-[12px] text-muted-foreground">
        <summary className="cursor-pointer">What the owner gets</summary>
        <div className="mt-2 flex max-w-2xl flex-col gap-2">
          <p>
            A text and an email with a link to their own page: every answer ready to copy into Google, our email to add as a manager, how to verify, and a box to send us their profile link. The text:
          </p>
          <p className="rounded-md border border-border-soft px-3 py-2">{instructionsText(SAMPLE, 'https://…/gbp-setup/…')}</p>
          <p>When Google Maps already lists them:</p>
          <p className="rounded-md border border-border-soft px-3 py-2">{instructionsText(SAMPLE, 'https://…/gbp-setup/…', 'claim')}</p>
          <p>Where a listing only shares their name or number, the page asks them whether it’s theirs before they make a new one. The Hub looks on Google Maps again if its last look is over two weeks old.</p>
        </div>
      </details>
    </div>
  )
}

const btn = 'inline-flex shrink-0 items-center gap-1.5 rounded-md border border-border px-2.5 py-1 text-[12.5px] transition hover:bg-muted disabled:opacity-50'
const btnPrimary = 'inline-flex shrink-0 items-center gap-1.5 rounded-md bg-foreground px-2.5 py-1 text-[12.5px] font-medium text-background transition hover:opacity-90 disabled:opacity-50'

/** What Google Maps shows for them. */
function Maps({ r }: { r: GbpRow }) {
  if (r.listing === 'unchecked') {
    if (r.status === 'verified' || r.status === 'has_profile') return r.profileUrl ? <Out href={r.profileUrl}>Their profile</Out> : <span className="text-muted-foreground">·</span>
    return (
      <span className={cn('text-[12.5px]', r.lookupError ? 'text-warning' : 'text-muted-foreground')} title={r.lookupError ?? undefined}>
        {r.lookupError ? 'Check failed; it tries again' : 'Not checked yet'}
      </span>
    )
  }
  const l = r.listings[0]
  if (!l) return <span className="text-muted-foreground">Nothing there</span>
  return (
    <span className="block" title={r.listings.map((x) => `${x.name}${x.address ? `, ${x.address}` : ''} (${x.why})`).join('\n')}>
      <span className="text-[12px] text-muted-foreground">{r.managed ? 'Set up? ' : r.listing === 'claim' ? 'Claim ' : 'Maybe '}</span>
      {l.mapsUrl ? <Out href={l.mapsUrl}>{l.name}</Out> : <span>{l.name}</span>}
      <span className="block text-[12px] text-muted-foreground">
        {[l.address ? listingTown(l.address) : 'no public address', l.why, r.listings.length > 1 ? `${r.listings.length - 1} more` : null].filter(Boolean).join(' · ')}
      </span>
    </span>
  )
}

/** Where their setup page stands. */
function Page({ r, cancel, busy }: { r: GbpRow; cancel: () => void; busy: boolean }) {
  const quiet = 'text-[12.5px] text-muted-foreground'
  switch (r.page) {
    case 'done':
      return (
        <span className="inline-flex items-center gap-1 text-[12.5px]">
          <Check className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400" strokeWidth={2.5} /> {r.status ? GBP_STATUS_LABEL[r.status] : 'Done'}
        </span>
      )
    case 'queued':
      return (
        <span className="text-[12.5px]">
          {r.later ? `Goes out ${r.later}` : 'Going out now'}
          <button
            type="button"
            disabled={busy}
            onClick={(e) => {
              e.stopPropagation()
              cancel()
            }}
            className="ml-2 text-[12px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline disabled:opacity-50"
          >
            Cancel
          </button>
        </span>
      )
    case 'sending':
      return <span className="text-[12.5px]">Going out now</span>
    case 'failed':
      return (
        <span className="block max-w-[16rem] text-[12.5px] text-destructive">
          Didn’t go out
          {r.pageDetail && <span className="block text-[12px] leading-snug text-muted-foreground">{r.pageDetail}</span>}
        </span>
      )
    case 'sent':
      return (
        <span className={quiet}>
          {r.pageAt ? `Sent ${shortDay(r.pageAt)}` : 'Sent'}
          {r.reminders > 0 && ` · ${r.reminders} reminder${r.reminders === 1 ? '' : 's'}`}
          {!r.reminding && r.status === 'verifying' && ' · reminders off'}
        </span>
      )
    case 'asked':
      return <span className={quiet}>Asked in the Office</span>
    case 'skipped':
      return <span className={quiet}>Not now</span>
    default:
      return <span className={quiet}>{r.status === 'verifying' ? 'Checklist texted' : 'Not sent'}</span>
  }
}

function Out({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noreferrer" className="inline-flex max-w-full items-center gap-1 text-[12.5px] underline-offset-2 hover:underline">
      <span className="truncate">{children}</span> <ExternalLink className="h-3 w-3 shrink-0 text-muted-foreground" />
    </a>
  )
}
