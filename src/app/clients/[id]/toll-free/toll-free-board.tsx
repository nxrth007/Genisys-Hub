'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, ArrowLeft, Check, ChevronRight, Copy, ExternalLink, Loader2, RotateCcw } from 'lucide-react'
import { cn } from '@/lib/utils'
import { PageHeader } from '@/components/ui/page-header'
import { blanksIn, forCopy, segments } from '@/lib/a2p'
import {
  TOLL_FREE_CHECKLIST,
  TOLL_FREE_REJECTIONS,
  isPoBox,
  isYes,
  tollFreeFields,
  type TollFreeField,
  type TollFreeGroup,
  type TollFreeInputs,
} from '@/lib/toll-free'

type Saved = { values: Partial<TollFreeInputs>; checks: string[]; updatedAt: string | null }
type BoardData = {
  client: { id: string; name: string; siteUrl: string | null; hasIntake: boolean; einStatus: string | null }
  prefill: TollFreeInputs
  onboardingAddress: string | null
  /** The geocoder filled part of the address onboarding didn't give. */
  geocoded: boolean
  mainServices: string | null
  saved: Saved
}

const TRACKER_COLUMN = 'Toll-Free Submitted'

const INPUTS: { key: keyof TollFreeInputs; label: string; placeholder?: string; hint?: string; toggle?: boolean; optional?: boolean }[] = [
  { key: 'businessName', label: 'Business name', hint: 'As the website shows it.' },
  { key: 'legalName', label: 'Legal name (EIN letter)', hint: 'Same as the business name when there’s no EIN.' },
  { key: 'ein', label: 'EIN', optional: true, hint: 'Empty: it goes in as a sole proprietor. GHL doesn’t need an EIN for toll-free.' },
  { key: 'trade', label: 'Trade', placeholder: 'fence and deck contractor', hint: 'Reads “[Business] is a … in [City]”.' },
  { key: 'contactFirstName', label: 'Contact first name', hint: 'The owner, or whoever answers for the business.' },
  { key: 'contactLastName', label: 'Contact last name' },
  { key: 'contactEmail', label: 'Contact email' },
  { key: 'contactPhone', label: 'Contact phone' },
  { key: 'street', label: 'Street address', hint: 'Where the business is. Not a PO box.' },
  { key: 'city', label: 'City' },
  { key: 'state', label: 'State' },
  { key: 'zip', label: 'ZIP' },
  { key: 'domain', label: 'Domain', placeholder: 'example.com', hint: 'Use whichever of www / no-www loads itself.' },
  { key: 'phone', label: 'Business phone', hint: 'The number customers call. It goes in the sample texts.' },
  {
    key: 'promos',
    label: 'Sends promotions',
    toggle: true,
    hint: 'The site’s forms have the separate, optional marketing checkbox. Adds Marketing and a promo sample.',
  },
]

const GROUPS: { id: TollFreeGroup; label: string; hint: string; compact?: boolean }[] = [
  { id: 'business', label: 'Business and contact', hint: 'GHL → the number’s “Verification Required” → step 2', compact: true },
  { id: 'location', label: 'Business location', hint: 'Step 3', compact: true },
  { id: 'messaging', label: 'Messaging use case', hint: 'Step 4' },
  { id: 'registration', label: 'If GHL asks for registration details', hint: 'DBA, entity type, registration number', compact: true },
  { id: 'form', label: 'On the site and in GHL', hint: 'Set up before submitting; not part of the form' },
]

export function TollFreeBoard({ clientId }: { clientId: string }) {
  const q = useQuery({
    queryKey: ['client-toll-free', clientId],
    queryFn: async (): Promise<BoardData> => {
      const res = await fetch(`/api/clients/${clientId}/toll-free`)
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || 'Failed to load')
      return data
    },
    staleTime: Infinity,
    refetchOnWindowFocus: false,
  })
  const qc = useQueryClient()
  const tracker = useQuery({
    queryKey: ['toll-free-tracker', clientId],
    queryFn: async (): Promise<{ ok: boolean; row: number | null; steps: Record<string, string>; detail: string | null }> => {
      const res = await fetch(`/api/clients/${clientId}/toll-free/complete`)
      const out = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(out.error || 'Couldn’t read the tracker')
      return out
    },
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  })
  const [completing, setCompleting] = useState(false)
  const [completeMsg, setCompleteMsg] = useState<{ ok: boolean; text: string } | null>(null)

  async function markComplete() {
    setCompleting(true)
    setCompleteMsg(null)
    try {
      const res = await fetch(`/api/clients/${clientId}/toll-free/complete`, { method: 'POST' })
      const out = (await res.json().catch(() => ({}))) as { error?: string; tracker?: { ok: boolean; action: string; detail: string } }
      if (!res.ok) throw new Error(out.error || 'Couldn’t mark it complete')
      const t = out.tracker
      setCompleteMsg({
        ok: !!t?.ok,
        text: t?.ok
          ? t.action === 'already'
            ? `Onboarding tracker: “${TRACKER_COLUMN}” was already checked.`
            : `Onboarding tracker: “${TRACKER_COLUMN}” checked.`
          : `Onboarding tracker not updated: ${t?.detail ?? 'unknown error'}`,
      })
      qc.invalidateQueries({ queryKey: ['toll-free-tracker', clientId] })
    } catch (err) {
      setCompleteMsg({ ok: false, text: err instanceof Error ? err.message : String(err) })
    } finally {
      setCompleting(false)
    }
  }

  const t = tracker.data
  return (
    <div className="mx-auto flex max-w-[1280px] flex-col gap-6">
      <PageHeader
        title={q.data ? `Toll-Free — ${q.data.client.name}` : 'Toll-free verification'}
        subtitle="Everything GHL asks for when verifying this client’s toll-free number, filled in from their onboarding answers. Copy each box into GHL. Toll-free verification is free and doesn’t need an EIN."
        breadcrumbs={[{ label: 'Genisys' }, { label: 'Clients', href: '/clients' }, { label: 'Toll-Free' }]}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Link
              href={`/clients?focus=${clientId}`}
              className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-card px-4 py-2 text-sm font-medium text-foreground transition hover:bg-muted"
            >
              <ArrowLeft className="h-4 w-4" /> Back to client
            </Link>
            <button
              type="button"
              onClick={markComplete}
              disabled={completing}
              title={`Checks “${TRACKER_COLUMN}” for this client in the onboarding tracker sheet`}
              className="inline-flex items-center gap-1.5 rounded-lg border border-foreground/20 bg-foreground px-4 py-2 text-sm font-medium text-background transition hover:opacity-90 disabled:opacity-50"
            >
              {completing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />} Mark Complete
            </button>
          </div>
        }
      />
      {t && (
        <p className="text-[12px] text-muted-foreground">
          Onboarding tracker sheet:{' '}
          {!t.ok
            ? `can’t read it (${t.detail})`
            : !t.row
              ? t.detail
              : TRACKER_COLUMN in t.steps
                ? `row ${t.row} · ${TRACKER_COLUMN} ${t.steps[TRACKER_COLUMN] || 'blank'}`
                : `row ${t.row} · the sheet has no “${TRACKER_COLUMN}” column yet, so Mark Complete can’t tick it`}
        </p>
      )}
      {completeMsg && (
        <p
          className={cn(
            'rounded-xl border px-4 py-3 text-[13px]',
            completeMsg.ok ? 'border-emerald-500/30 bg-emerald-500/10' : 'border-amber-500/30 bg-amber-500/10',
          )}
        >
          {completeMsg.text}
        </p>
      )}
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
  const [edits, setEditsState] = useState<Partial<TollFreeInputs>>(data.saved.values)
  const [checks, setChecksState] = useState<string[]>(data.saved.checks)
  const [save, setSave] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle')
  const latest = useRef({ edits, checks })
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current)
  }, [])

  function queueSave(next: { edits?: Partial<TollFreeInputs>; checks?: string[] }) {
    latest.current = { ...latest.current, ...next }
    setSave('saving')
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(async () => {
      try {
        const res = await fetch(`/api/clients/${clientId}/toll-free`, {
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
  function setEdits(fn: (e: Partial<TollFreeInputs>) => Partial<TollFreeInputs>) {
    const next = fn(latest.current.edits)
    setEditsState(next)
    queueSave({ edits: next })
  }
  function setChecks(fn: (c: string[]) => string[]) {
    const next = fn(latest.current.checks)
    setChecksState(next)
    queueSave({ checks: next })
  }

  const values = useMemo(() => ({ ...data.prefill, ...edits }) as TollFreeInputs, [data.prefill, edits])
  const fields = useMemo(() => tollFreeFields(values), [values])
  const totalBlanks = useMemo(() => new Set(fields.flatMap((f) => blanksIn(f.text))).size, [fields])
  const site = values.domain ? `https://${values.domain.trim()}` : null
  const poBox = isPoBox(values.street)
  const nameIsBox = isPoBox(values.businessName) || isPoBox(values.legalName)
  const addressEdited = (['street', 'city', 'state', 'zip'] as const).some((k) => k in edits)

  function setValue(key: keyof TollFreeInputs, value: string) {
    setEdits((e) => ({ ...e, [key]: value }))
  }
  function reset(key: keyof TollFreeInputs) {
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
              const value = values[f.key]
              const warn = (!f.optional && !value.trim()) || (f.key === 'street' && poBox) || ((f.key === 'businessName' || f.key === 'legalName') && isPoBox(value))
              const resetButton = edited && (
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
              )
              if (f.toggle) {
                return (
                  <div key={f.key} className="flex flex-col gap-1">
                    <span className="flex items-center justify-between gap-2">
                      <label className="flex cursor-pointer items-center gap-2 text-[13px] font-medium">
                        <input
                          type="checkbox"
                          checked={isYes(value)}
                          onChange={(e) => setValue(f.key, e.target.checked ? 'yes' : 'no')}
                          className="h-4 w-4 shrink-0 accent-foreground"
                        />
                        {f.label}
                      </label>
                      {resetButton}
                    </span>
                    {f.hint && <span className="text-[11px] leading-snug text-muted-foreground/80">{f.hint}</span>}
                  </div>
                )
              }
              // The label names only its input: wrapped round the reset button too, a click on it would reset the field.
              return (
                <div key={f.key} className="flex flex-col gap-1">
                  <span className="flex items-center justify-between gap-2">
                    <label htmlFor={`tf-${f.key}`} className="eyebrow text-muted-foreground/80">
                      {f.label}
                    </label>
                    {resetButton}
                  </span>
                  <input
                    id={`tf-${f.key}`}
                    value={value}
                    onChange={(e) => setValue(f.key, e.target.value)}
                    placeholder={f.placeholder}
                    spellCheck={false}
                    className={cn(inputClass(warn), 'h-9')}
                  />
                  {f.key === 'trade' && data.mainServices && (
                    <span className="text-[11px] leading-snug text-muted-foreground">They listed: {data.mainServices}</span>
                  )}
                  {f.key === 'street' && data.onboardingAddress && (
                    <span className="text-[11px] leading-snug text-muted-foreground">Onboarding said: {data.onboardingAddress}</span>
                  )}
                  {f.hint && <span className="text-[11px] leading-snug text-muted-foreground/80">{f.hint}</span>}
                </div>
              )
            })}
          </div>
        </section>
      </aside>

      <div className="flex min-w-0 flex-col gap-6">
        {poBox && (
          <p className="flex items-start gap-2 rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-[13px]">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" />
            <span>
              <span className="font-semibold">The address is a PO box</span> (“{values.street}”). GHL asks for the physical location of the business, and Twilio
              rejects an address it can’t match to one (30451). Ask the client for the street address the business works from (for a home-based business, the
              owner’s home address), then put it in Street address, City and ZIP on the left.
            </span>
          </p>
        )}
        {nameIsBox && (
          <p className="flex items-start gap-2 rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-[13px]">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" />
            <span>
              <span className="font-semibold">The business name looks like a PO box address.</span> Fix Business name and Legal name on the left: they should be the
              company’s name as the website shows it.
            </span>
          </p>
        )}
        {totalBlanks > 0 ? (
          <p className="flex items-start gap-2 rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-[13px]">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" />
            <span>
              {totalBlanks} detail{totalBlanks === 1 ? '' : 's'} still blank — highlighted below. Fill {totalBlanks === 1 ? 'it' : 'them'} in on the left before
              copying.
            </span>
          </p>
        ) : null}
        {data.geocoded && !addressEdited && !poBox && (
          <p className="rounded-xl border border-border bg-surface px-4 py-3 text-[13px] text-muted-foreground">
            Onboarding didn’t give the whole address, so part of it came from the map. Check the street, city and ZIP on Google Maps before submitting.
          </p>
        )}
        {data.client.einStatus === 'none' && (
          <p className="rounded-xl border border-border bg-surface px-4 py-3 text-[13px] text-muted-foreground">
            No EIN on file. That’s fine for toll-free: if GHL asks for the entity type, pick Sole proprietor and leave the registration number empty.
          </p>
        )}

        <Checklist site={site} checks={checks} setChecks={setChecks} />

        {GROUPS.map((g) => {
          const inGroup = fields.filter((f) => f.group === g.id)
          if (!inGroup.length) return null
          return (
            <section key={g.id} className="flex flex-col gap-3">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <h2 className="eyebrow text-muted-foreground">{g.label}</h2>
                <p className="font-mono text-[11px] text-muted-foreground/70">{g.hint}</p>
              </div>
              <div className={cn('grid gap-3', g.compact && 'sm:grid-cols-2')}>
                {inGroup.map((f) => (
                  <div key={f.id} className="contents">
                    <CopyCard field={f} compact={!!g.compact} />
                    {f.id === 'categories' && <OptInProof site={site} />}
                  </div>
                ))}
              </div>
            </section>
          )
        })}

        <Reference />
      </div>
    </div>
  )
}

function inputClass(warn: boolean) {
  return cn(
    'w-full rounded-md border bg-card px-2.5 py-1.5 text-[13px] outline-none transition focus:border-foreground/30',
    warn ? 'border-amber-500/40' : 'border-border',
  )
}

function CopyCard({ field, compact }: { field: TollFreeField; compact: boolean }) {
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

/** GHL's Opt-In Workflow Image URL: a public link to a screenshot of the whole form, which only a person can take. */
function OptInProof({ site }: { site: string | null }) {
  const pages = site
    ? [
        { label: 'Homepage', href: site },
        { label: '/contact', href: `${site}/contact` },
      ]
    : []
  return (
    <div className="flex min-w-0 flex-col gap-2 rounded-xl border border-border bg-card p-4">
      <p className="text-[13px] font-semibold">Opt-In Workflow Image URL</p>
      <ol className="flex list-decimal flex-col gap-1.5 pl-5 text-[13px] leading-snug">
        <li>Open the quote form on the live site.</li>
        <li>
          Take one screenshot of the whole form: its fields, the checkbox text, the Privacy Policy and Terms links, and the submit button. A cropped checkbox
          isn’t enough.
        </li>
        <li>In the client’s GHL sub-account, upload it to Media Storage, then open the file’s menu → Get Link.</li>
        <li>Open that link in a private window to check it loads without a login, then paste it here.</li>
      </ol>
      {pages.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {pages.map((l) => (
            <a
              key={l.href}
              href={l.href}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 rounded-md border border-border bg-surface px-2 py-1 font-mono text-[11.5px] text-muted-foreground transition hover:text-foreground"
            >
              {l.label} <ExternalLink className="h-3 w-3" />
            </a>
          ))}
        </div>
      )}
    </div>
  )
}

function Checklist({ site, checks, setChecks }: { site: string | null; checks: string[]; setChecks: (fn: (c: string[]) => string[]) => void }) {
  const done = TOLL_FREE_CHECKLIST.filter((c) => checks.includes(c.id)).length
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
        <p className={cn('font-mono text-[11px]', done === TOLL_FREE_CHECKLIST.length ? 'text-emerald-600 dark:text-emerald-400' : 'text-muted-foreground/70')}>
          {done}/{TOLL_FREE_CHECKLIST.length} checked on the live site
        </p>
      </div>
      <p className="mb-3 text-[12px] text-muted-foreground">
        Reviewers compare the submission with the live website. Check the published site, not the builder.
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
        {TOLL_FREE_CHECKLIST.map((c) => {
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
      <div className="flex flex-col gap-3 border-t border-border-soft p-4">
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
              {TOLL_FREE_REJECTIONS.map((r) => (
                <tr key={r.rejection} className="border-t border-border-soft align-top">
                  <td className="py-2 pr-4 font-medium">{r.rejection}</td>
                  <td className="py-2 pr-4 text-muted-foreground">{r.cause}</td>
                  <td className="py-2">{r.fix}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="text-[12px] text-muted-foreground">
          GHL shows the rejection reason on the number in Manage Numbers. Fix what it names and resubmit there, or ask GHL support to appeal.
        </p>
      </div>
    </details>
  )
}
