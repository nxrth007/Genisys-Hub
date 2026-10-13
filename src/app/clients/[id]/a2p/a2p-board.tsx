'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { useQuery } from '@tanstack/react-query'
import { AlertTriangle, ArrowLeft, Check, ChevronRight, Copy, ExternalLink, Loader2, RotateCcw } from 'lucide-react'
import { cn } from '@/lib/utils'
import { PageHeader } from '@/components/ui/page-header'
import {
  A2P_CHECKLIST,
  A2P_DEPRECATED,
  A2P_REJECTIONS,
  a2pFields,
  blanksIn,
  forCopy,
  segments,
  type A2pField,
  type A2pGroup,
  type A2pInputs,
} from '@/lib/a2p'

type Saved = { values: Partial<A2pInputs>; checks: string[]; updatedAt: string | null }
type BoardData = {
  client: { id: string; name: string; siteUrl: string | null; hasIntake: boolean }
  prefill: A2pInputs
  mainServices: string | null
  saved: Saved
}

const INPUTS: { key: keyof A2pInputs; label: string; placeholder?: string; hint?: string; long?: boolean }[] = [
  { key: 'businessName', label: 'Business name', hint: 'Exactly as the website and form show it.' },
  { key: 'trade', label: 'Trade', placeholder: 'fence and deck contractor', hint: 'Reads “[Business] is a … in [City]”.' },
  { key: 'ownerFirstName', label: 'Owner first name', placeholder: 'Todd', hint: 'Signs the promotional sample.' },
  { key: 'ownership', label: 'Ownership line', placeholder: 'owned and operated by Todd Smith for 25 years', hint: 'Or “family-owned and operated”. Leave empty to skip.' },
  { key: 'city', label: 'City' },
  { key: 'state', label: 'State' },
  { key: 'address', label: 'Street address' },
  { key: 'serviceArea', label: 'Service area', placeholder: 'New Braunfels, San Marcos and Seguin', long: true, hint: 'Leave empty to skip.' },
  { key: 'domain', label: 'Domain', placeholder: 'example.com', hint: 'Use whichever of www / no-www loads itself, everywhere.' },
  { key: 'phone', label: 'Business phone' },
  { key: 'promoLabel', label: 'Promo headline', placeholder: 'Fall special' },
  { key: 'offer', label: 'Offer', placeholder: '$250 off any new fence or deck' },
  { key: 'offerBy', label: 'Offer deadline', placeholder: 'Nov 30', hint: 'Optional.' },
  { key: 'primaryCities', label: 'Cities for the promo', placeholder: 'New Braunfels and San Marcos' },
  { key: 'legalName', label: 'Legal name (EIN letter)', hint: 'Must match the IRS EIN letter exactly.' },
  { key: 'ein', label: 'EIN' },
  { key: 'contactEmail', label: 'Contact email' },
]

const GROUPS: { id: A2pGroup; label: string; hint: string }[] = [
  { id: 'brand', label: 'Brand registration', hint: 'GHL → Trust Center → A2P → Brand' },
  { id: 'campaign', label: 'Campaign', hint: 'GHL → Trust Center → A2P → Campaign' },
  { id: 'form', label: 'Form checkboxes', hint: 'Put these on every form on the site first' },
  { id: 'workflow', label: 'GHL workflow', hint: 'Set up in GHL; not part of the submission' },
]

export function A2pBoard({ clientId }: { clientId: string }) {
  const q = useQuery({
    queryKey: ['client-a2p', clientId],
    queryFn: async (): Promise<BoardData> => {
      const res = await fetch(`/api/clients/${clientId}/a2p`)
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || 'Failed to load')
      return data
    },
    staleTime: Infinity,
    refetchOnWindowFocus: false,
  })

  return (
    <div className="mx-auto flex max-w-[1280px] flex-col gap-6">
      <PageHeader
        title={q.data ? `A2P — ${q.data.client.name}` : 'A2P registration'}
        subtitle="Everything GHL asks for when registering this client for A2P 10DLC, filled in from their onboarding answers. Copy each box into GHL."
        breadcrumbs={[{ label: 'Genisys' }, { label: 'Clients', href: '/clients' }, { label: 'A2P' }]}
        actions={
          <Link
            href={`/clients?focus=${clientId}`}
            className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-card px-4 py-2 text-sm font-medium text-foreground transition hover:bg-muted"
          >
            <ArrowLeft className="h-4 w-4" /> Back to client
          </Link>
        }
      />
      {q.isLoading ? (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading…
        </p>
      ) : q.error ? (
        <p className="text-sm text-destructive">{(q.error as Error).message}</p>
      ) : q.data ? (
        <Board clientId={clientId} data={q.data} />
      ) : null}
    </div>
  )
}

function Board({ clientId, data }: { clientId: string; data: BoardData }) {
  const [edits, setEditsState] = useState<Partial<A2pInputs>>(data.saved.values)
  const [checks, setChecksState] = useState<string[]>(data.saved.checks)
  const [save, setSave] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle')
  const latest = useRef({ edits, checks })
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current)
  }, [])

  function queueSave(next: { edits?: Partial<A2pInputs>; checks?: string[] }) {
    latest.current = { ...latest.current, ...next }
    setSave('saving')
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(async () => {
      try {
        const res = await fetch(`/api/clients/${clientId}/a2p`, {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ values: latest.current.edits, checks: latest.current.checks }),
        })
        setSave(res.ok ? 'saved' : 'error')
      } catch {
        setSave('error')
      }
    }, 700)
  }
  function setEdits(fn: (e: Partial<A2pInputs>) => Partial<A2pInputs>) {
    const next = fn(latest.current.edits)
    setEditsState(next)
    queueSave({ edits: next })
  }
  function setChecks(fn: (c: string[]) => string[]) {
    const next = fn(latest.current.checks)
    setChecksState(next)
    queueSave({ checks: next })
  }

  const values = useMemo(() => ({ ...data.prefill, ...edits }) as A2pInputs, [data.prefill, edits])
  const fields = useMemo(() => a2pFields(values), [values])
  const totalBlanks = useMemo(() => new Set(fields.flatMap((f) => blanksIn(f.text))).size, [fields])
  const site = values.domain ? `https://${values.domain.trim()}` : null

  function setValue(key: keyof A2pInputs, value: string) {
    setEdits((e) => ({ ...e, [key]: value }))
  }
  function reset(key: keyof A2pInputs) {
    setEdits((e) => {
      const next = { ...e }
      delete next[key]
      return next
    })
  }

  return (
    <div className="grid items-start gap-6 lg:grid-cols-[22rem_minmax(0,1fr)]">
      <aside className="flex flex-col gap-4 lg:sticky lg:top-6">
        <section className="rounded-xl border border-border-soft bg-surface p-4">
          <div className="mb-3 flex items-baseline justify-between gap-3">
            <p className="eyebrow text-muted-foreground">Details</p>
            <p className="font-mono text-[11px] text-muted-foreground/70">
              {save === 'saving' ? 'Saving…' : save === 'saved' ? 'Saved' : save === 'error' ? 'Couldn’t save' : 'Saved per client'}
            </p>
          </div>
          {!data.client.hasIntake && (
            <p className="mb-3 rounded-lg border border-border bg-card px-3 py-2 text-[12px] text-muted-foreground">
              This client has no onboarding answers, so most details start empty.
            </p>
          )}
          <div className="flex max-h-[calc(100vh-12rem)] flex-col gap-3 overflow-y-auto pr-1">
            {INPUTS.map((f) => {
              const edited = f.key in edits && edits[f.key] !== data.prefill[f.key]
              return (
                <label key={f.key} className="flex flex-col gap-1">
                  <span className="flex items-center justify-between gap-2">
                    <span className="eyebrow text-muted-foreground/80">{f.label}</span>
                    {edited && (
                      <button
                        type="button"
                        onClick={(e) => {
                          e.preventDefault()
                          reset(f.key)
                        }}
                        className="inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground"
                        title={data.prefill[f.key] ? `Back to “${data.prefill[f.key]}” from onboarding` : 'Clear'}
                      >
                        <RotateCcw className="h-3 w-3" /> {data.prefill[f.key] ? 'Onboarding value' : 'Clear'}
                      </button>
                    )}
                  </span>
                  {f.long ? (
                    <textarea
                      value={values[f.key]}
                      onChange={(e) => setValue(f.key, e.target.value)}
                      placeholder={f.placeholder}
                      rows={2}
                      className={inputClass(!values[f.key].trim())}
                    />
                  ) : (
                    <input
                      value={values[f.key]}
                      onChange={(e) => setValue(f.key, e.target.value)}
                      placeholder={f.placeholder}
                      spellCheck={false}
                      className={cn(inputClass(!values[f.key].trim()), 'h-9')}
                    />
                  )}
                  {f.key === 'trade' && data.mainServices && (
                    <span className="text-[11px] leading-snug text-muted-foreground">They listed: {data.mainServices}</span>
                  )}
                  {f.hint && <span className="text-[11px] leading-snug text-muted-foreground/80">{f.hint}</span>}
                </label>
              )
            })}
          </div>
        </section>
      </aside>

      <div className="flex min-w-0 flex-col gap-6">
        {totalBlanks > 0 ? (
          <p className="flex items-start gap-2 rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-[13px]">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" />
            <span>
              {totalBlanks} detail{totalBlanks === 1 ? '' : 's'} still blank — highlighted below. Fill {totalBlanks === 1 ? 'it' : 'them'} in on the left before
              copying.
            </span>
          </p>
        ) : null}

        <Checklist site={site} checks={checks} setChecks={setChecks} />

        {GROUPS.map((g) => (
          <section key={g.id} className="flex flex-col gap-3">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h2 className="eyebrow text-muted-foreground">{g.label}</h2>
              <p className="font-mono text-[11px] text-muted-foreground/70">{g.hint}</p>
            </div>
            <div className={cn('grid gap-3', g.id === 'brand' && 'sm:grid-cols-2')}>
              {fields
                .filter((f) => f.group === g.id)
                .map((f) => (
                  <CopyCard key={f.id} field={f} compact={g.id === 'brand'} />
                ))}
            </div>
          </section>
        ))}

        <Reference />
      </div>
    </div>
  )
}

function inputClass(empty: boolean) {
  return cn(
    'w-full rounded-md border bg-card px-2.5 py-1.5 text-[13px] outline-none transition focus:border-foreground/30',
    empty ? 'border-amber-500/40' : 'border-border',
  )
}

function CopyCard({ field, compact }: { field: A2pField; compact: boolean }) {
  const [copied, setCopied] = useState(false)
  const text = forCopy(field.text)
  const blanks = blanksIn(field.text)
  const over = field.limit ? text.length > field.limit : false

  async function copy() {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      setCopied(false)
    }
  }

  return (
    <div className="flex min-w-0 flex-col gap-2 rounded-xl border border-border bg-card p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[13px] font-semibold">{field.label}</p>
          <p className={cn('font-mono text-[11px]', over ? 'text-destructive' : 'text-muted-foreground')}>
            {text.length.toLocaleString()}
            {field.limit ? ` / ${field.limit.toLocaleString()}` : ''} characters
            {blanks.length ? ` · ${blanks.length} blank${blanks.length === 1 ? '' : 's'}` : ''}
          </p>
        </div>
        <button
          type="button"
          onClick={copy}
          className={cn(
            'inline-flex shrink-0 items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-medium transition',
            copied ? 'border-emerald-500/40 text-emerald-600 dark:text-emerald-400' : 'border-border bg-surface hover:bg-muted',
          )}
        >
          {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <div
        className={cn(
          'whitespace-pre-wrap rounded-lg border border-border-soft bg-surface px-3 py-2.5 leading-relaxed',
          compact ? 'font-mono text-[12.5px]' : 'text-[13px]',
        )}
      >
        {segments(field.text).map((s, i) =>
          s.blank ? (
            <mark key={i} className="rounded bg-amber-500/20 px-0.5 font-medium text-amber-700 dark:text-amber-300">
              {s.text}
            </mark>
          ) : (
            <span key={i}>{s.text}</span>
          ),
        )}
      </div>
      {field.note && <p className="text-[11.5px] leading-snug text-muted-foreground">{field.note}</p>}
    </div>
  )
}

function Checklist({ site, checks, setChecks }: { site: string | null; checks: string[]; setChecks: (fn: (c: string[]) => string[]) => void }) {
  const done = A2P_CHECKLIST.filter((c) => checks.includes(c.id)).length
  const alt = site ? (site.includes('://www.') ? site.replace('://www.', '://') : site.replace('://', '://www.')) : null
  const links = site
    ? [
        { label: 'Homepage', href: site },
        { label: '/contact', href: `${site}/contact` },
        { label: '/privacy-policy', href: `${site}/privacy-policy` },
        { label: '/terms-of-service', href: `${site}/terms-of-service` },
        { label: alt!.replace(/^https:\/\//, ''), href: alt! },
      ]
    : []

  return (
    <section className="rounded-xl border border-border-soft bg-surface p-4">
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-3">
        <p className="eyebrow text-muted-foreground">Before you submit</p>
        <p className={cn('font-mono text-[11px]', done === A2P_CHECKLIST.length ? 'text-emerald-600 dark:text-emerald-400' : 'text-muted-foreground/70')}>
          {done}/{A2P_CHECKLIST.length} checked on the live site
        </p>
      </div>
      <p className="mb-3 text-[12px] text-muted-foreground">
        Every rejection so far traces back to one of these. Check the live site, not the builder: the GHL editor doesn’t run custom code or show the
        published state.
      </p>
      {links.length > 0 && (
        <div className="mb-3 flex flex-wrap gap-1.5">
          {links.map((l) => (
            <a
              key={l.href}
              href={l.href}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 rounded-md border border-border bg-card px-2 py-1 font-mono text-[11.5px] text-muted-foreground transition hover:text-foreground"
            >
              {l.label} <ExternalLink className="h-3 w-3" />
            </a>
          ))}
        </div>
      )}
      <ul className="flex flex-col gap-2">
        {A2P_CHECKLIST.map((c) => {
          const on = checks.includes(c.id)
          return (
            <li key={c.id}>
              <label className="flex cursor-pointer items-start gap-2.5 text-[13px] leading-snug">
                <input
                  type="checkbox"
                  checked={on}
                  onChange={() => setChecks((all) => (on ? all.filter((x) => x !== c.id) : [...all, c.id]))}
                  className="mt-0.5 h-4 w-4 shrink-0 accent-foreground"
                />
                <span className={cn(on && 'text-muted-foreground line-through decoration-muted-foreground/40')}>{c.text}</span>
              </label>
            </li>
          )
        })}
      </ul>
    </section>
  )
}

function Reference() {
  return (
    <details className="group rounded-xl border border-border-soft bg-surface">
      <summary className="flex cursor-pointer list-none items-center gap-2 px-4 py-3 [&::-webkit-details-marker]:hidden">
        <ChevronRight className="h-4 w-4 text-muted-foreground transition group-open:rotate-90" />
        <span className="eyebrow text-muted-foreground">Known rejections and their fixes</span>
      </summary>
      <div className="flex flex-col gap-4 border-t border-border-soft p-4">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-[12.5px]">
            <thead className="text-muted-foreground">
              <tr>
                <th className="py-1.5 pr-4 font-medium">Rejection</th>
                <th className="py-1.5 pr-4 font-medium">Cause</th>
                <th className="py-1.5 font-medium">Fix</th>
              </tr>
            </thead>
            <tbody>
              {A2P_REJECTIONS.map((r) => (
                <tr key={r.rejection} className="border-t border-border-soft align-top">
                  <td className="py-2 pr-4 font-medium">{r.rejection}</td>
                  <td className="py-2 pr-4 text-muted-foreground">{r.cause}</td>
                  <td className="py-2">{r.fix}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div>
          <p className="eyebrow mb-2 text-muted-foreground">Don’t reuse from old templates</p>
          <ul className="flex list-disc flex-col gap-1 pl-5 text-[12.5px] text-muted-foreground">
            {A2P_DEPRECATED.map((d) => (
              <li key={d}>{d}</li>
            ))}
          </ul>
        </div>
      </div>
    </details>
  )
}
