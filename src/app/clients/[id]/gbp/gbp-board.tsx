'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { useQuery } from '@tanstack/react-query'
import { AlertTriangle, ArrowLeft, Check, Copy, ExternalLink, Loader2, MapPin, RotateCcw, Search, Send } from 'lucide-react'
import { cn } from '@/lib/utils'
import { PageHeader } from '@/components/ui/page-header'
import {
  GBP_STATUSES,
  GBP_STATUS_LABEL,
  gbpFields,
  verificationMessage,
  type GbpField,
  type GbpInputs,
  type GbpStatus,
} from '@/lib/gbp-kit'
import type { GbpBoard } from '@/lib/gbp-setup'

const BLANK = /⟦([^⟧]+)⟧/g
const forCopy = (t: string) => t.replace(BLANK, (_m, l: string) => `[${l}]`)
const blanksIn = (t: string) => [...t.matchAll(BLANK)].map((m) => m[1])

type TextInput = Exclude<keyof GbpInputs, 'locationMode'>
const INPUTS: { key: TextInput; label: string; hint?: string; long?: boolean; placeholder?: string }[] = [
  { key: 'businessName', label: 'Business name', hint: 'The real-world name only. No city or service words.' },
  { key: 'primaryCategory', label: 'Primary category', placeholder: 'Roofing contractor', hint: 'Must be one of Google’s categories.' },
  { key: 'extraCategories', label: 'More categories', long: true, hint: 'One per line, up to 9.' },
  { key: 'address', label: 'Address', hint: 'Shown only when the location is public.' },
  { key: 'serviceAreas', label: 'Service areas', long: true, hint: 'Cities or ZIP codes, one per line.' },
  { key: 'phone', label: 'Phone on the profile', hint: 'The number the website shows.' },
  { key: 'website', label: 'Website' },
  { key: 'hours', label: 'Hours', placeholder: 'Mon–Fri 7am–6pm, Sat 8am–2pm' },
  { key: 'services', label: 'Services', long: true, hint: 'One per line.' },
  { key: 'description', label: 'Description', long: true, hint: 'Up to 750 characters. No links, phone numbers or offers.' },
  { key: 'ownerFirstName', label: 'Owner first name' },
  { key: 'ownerEmail', label: 'Owner’s Google email', hint: 'Becomes the primary owner and verifies.' },
  { key: 'ownerPhone', label: 'Owner’s cell', hint: 'Where the verification texts go.' },
]

export function GbpBoardView({ clientId }: { clientId: string }) {
  const q = useQuery({
    queryKey: ['client-gbp', clientId],
    queryFn: async (): Promise<GbpBoard> => {
      const res = await fetch(`/api/clients/${clientId}/gbp`)
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || 'Failed to load')
      return data
    },
    staleTime: Infinity,
    refetchOnWindowFocus: false,
  })
  const [sending, setSending] = useState(false)
  const [sendResult, setSendResult] = useState<{ ok: boolean; sms: string; email: string; link: string | null } | null>(null)

  async function sendInstructions() {
    if (!window.confirm('Text and email this client their Google Business Profile setup link?')) return
    setSending(true)
    setSendResult(null)
    try {
      const res = await fetch(`/api/clients/${clientId}/gbp`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'send_instructions' }),
      })
      const out = (await res.json().catch(() => ({}))) as { ok?: boolean; sms?: string; email?: string; link?: string; error?: string }
      if (!res.ok) throw new Error(out.error || 'Couldn’t send the instructions')
      setSendResult({ ok: !!out.ok, sms: out.sms ?? '', email: out.email ?? '', link: out.link ?? null })
      q.refetch()
    } catch (err) {
      setSendResult({ ok: false, sms: err instanceof Error ? err.message : String(err), email: 'not sent', link: null })
    } finally {
      setSending(false)
    }
  }
  return (
    <div className="mx-auto flex max-w-[1280px] flex-col gap-6">
      <PageHeader
        title={q.data ? `Google profile — ${q.data.client.name}` : 'Google Business Profile'}
        subtitle="Find a listing the business already has, create the profile from the kit, and get the owner through Google’s verification. Filled in from the onboarding answers and the SEO engine’s business facts."
        breadcrumbs={[{ label: 'Genisys' }, { label: 'Google Profiles', href: '/google-profiles' }, { label: q.data?.client.name ?? 'Client' }]}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Link
              href="/google-profiles"
              className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-card px-4 py-2 text-sm font-medium text-foreground transition hover:bg-muted"
            >
              <ArrowLeft className="h-4 w-4" /> All clients
            </Link>
            <button
              type="button"
              onClick={sendInstructions}
              disabled={sending || !q.data}
              title="Texts and emails the owner a link to their own setup page, with every answer ready to copy"
              className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-emerald-700 disabled:opacity-50"
            >
              {sending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />} Send Google Business Profile Instructions
            </button>
          </div>
        }
      />
      {sendResult && (
        <div
          className={cn(
            'flex flex-col gap-1 rounded-xl border px-4 py-3 text-[13px]',
            sendResult.ok ? 'border-emerald-500/30 bg-emerald-500/10' : 'border-amber-500/30 bg-amber-500/10',
          )}
        >
          <p className="font-medium">{sendResult.ok ? 'Instructions sent.' : 'Nothing was sent.'}</p>
          <p className="text-muted-foreground">
            Text: {sendResult.sms}. Email: {sendResult.email}.
          </p>
          {sendResult.link && (
            <p className="break-all text-muted-foreground">
              Their setup page:{' '}
              <a href={sendResult.link} target="_blank" rel="noreferrer" className="underline underline-offset-2">
                {sendResult.link}
              </a>
            </p>
          )}
        </div>
      )}
      {q.isLoading ? (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading…
        </p>
      ) : q.error ? (
        <p className="text-sm text-destructive">{(q.error as Error).message}</p>
      ) : q.data ? (
        <Board clientId={clientId} data={q.data} reload={() => q.refetch()} />
      ) : null}
    </div>
  )
}

function Board({ clientId, data, reload }: { clientId: string; data: GbpBoard; reload: () => void }) {
  const [edits, setEditsState] = useState<Partial<GbpInputs>>(data.state.values)
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle')
  const [busy, setBusy] = useState<string | null>(null)
  const [flash, setFlash] = useState<string | null>(null)
  const [profileUrl, setProfileUrl] = useState(data.state.profileUrl ?? '')
  const [reviewUrl, setReviewUrl] = useState(data.state.reviewUrl ?? '')
  const latest = useRef(edits)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current)
  }, [])

  function put(body: Record<string, unknown>) {
    return fetch(`/api/clients/${clientId}/gbp`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  }
  function setEdits(next: Partial<GbpInputs>) {
    latest.current = next
    setEditsState(next)
    setSaveState('saving')
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(async () => {
      const res = await put({ values: latest.current }).catch(() => null)
      setSaveState(res?.ok ? 'saved' : 'error')
    }, 700)
  }
  async function act(action: string, extra: Record<string, unknown> = {}) {
    setBusy(action)
    setFlash(null)
    try {
      // Flush a pending edit first so the server works from what's on screen.
      if (timer.current) {
        clearTimeout(timer.current)
        await put({ values: latest.current })
      }
      const res = await fetch(`/api/clients/${clientId}/gbp`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action, ...extra }),
      })
      const out = (await res.json().catch(() => ({}))) as { ok?: boolean; detail?: string; results?: string[]; error?: string }
      setFlash(out.error ?? out.results?.join('. ') ?? out.detail ?? null)
      reload()
    } finally {
      setBusy(null)
    }
  }
  async function setStatus(status: GbpStatus) {
    setBusy('status')
    await put({ status })
    setBusy(null)
    reload()
  }

  const values = useMemo(() => ({ ...data.prefill, ...edits }) as GbpInputs, [data.prefill, edits])
  const fields = useMemo(() => gbpFields(values), [values])
  const message = useMemo(() => verificationMessage(values), [values])
  const blanks = new Set(fields.flatMap((f) => blanksIn(f.text))).size
  const status = data.effectiveStatus
  const s = data.state

  return (
    <div className="grid items-start gap-6 lg:grid-cols-[22rem_minmax(0,1fr)]">
      <aside className="flex flex-col gap-4 lg:sticky lg:top-6">
        <section className="rounded-xl border border-border-soft bg-surface p-4">
          <div className="mb-3 flex items-baseline justify-between gap-3">
            <p className="eyebrow text-muted-foreground">Details</p>
            <p className="font-mono text-[11px] text-muted-foreground/70">
              {saveState === 'saving' ? 'Saving…' : saveState === 'saved' ? 'Saved' : saveState === 'error' ? 'Couldn’t save' : 'Saved per client'}
            </p>
          </div>
          <div className="flex max-h-[calc(100vh-12rem)] flex-col gap-3 overflow-y-auto pr-1">
            <div className="flex flex-col gap-1">
              <span className="eyebrow text-muted-foreground/80">Location</span>
              <div className="flex gap-1.5">
                {(['address', 'service_area'] as const).map((m) => (
                  <button
                    key={m}
                    type="button"
                    onClick={() => setEdits({ ...latest.current, locationMode: m })}
                    className={cn(
                      'flex-1 rounded-md border px-2 py-1.5 text-[12px]',
                      values.locationMode === m ? 'border-foreground/40 bg-card font-medium' : 'border-border text-muted-foreground hover:bg-muted',
                    )}
                  >
                    {m === 'address' ? 'Public address' : 'Service area only'}
                  </button>
                ))}
              </div>
            </div>
            {INPUTS.map((f) => {
              const edited = f.key in edits && edits[f.key] !== data.prefill[f.key]
              const empty = !String(values[f.key] ?? '').trim()
              const cls = cn(
                'w-full rounded-md border bg-card px-2.5 py-1.5 text-[13px] outline-none transition focus:border-foreground/30',
                empty ? 'border-amber-500/40' : 'border-border',
              )
              return (
                <label key={f.key} className="flex flex-col gap-1">
                  <span className="flex items-center justify-between gap-2">
                    <span className="eyebrow text-muted-foreground/80">{f.label}</span>
                    {edited && (
                      <button
                        type="button"
                        onClick={(e) => {
                          e.preventDefault()
                          const next = { ...latest.current }
                          delete next[f.key]
                          setEdits(next)
                        }}
                        className="inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground"
                      >
                        <RotateCcw className="h-3 w-3" /> {data.prefill[f.key] ? 'Original' : 'Clear'}
                      </button>
                    )}
                  </span>
                  {f.long ? (
                    <textarea
                      value={values[f.key]}
                      onChange={(e) => setEdits({ ...latest.current, [f.key]: e.target.value })}
                      rows={f.key === 'description' ? 6 : 3}
                      placeholder={f.placeholder}
                      className={cls}
                    />
                  ) : (
                    <input
                      value={values[f.key]}
                      onChange={(e) => setEdits({ ...latest.current, [f.key]: e.target.value })}
                      placeholder={f.placeholder}
                      spellCheck={false}
                      className={cn(cls, 'h-9')}
                    />
                  )}
                  {f.key === 'description' && (
                    <span className={cn('font-mono text-[11px]', values.description.length > 750 ? 'text-destructive' : 'text-muted-foreground')}>
                      {values.description.length}/750
                    </span>
                  )}
                  {f.hint && <span className="text-[11px] leading-snug text-muted-foreground/80">{f.hint}</span>}
                </label>
              )
            })}
          </div>
        </section>
      </aside>

      <div className="flex min-w-0 flex-col gap-6">
        {/* Where it stands */}
        <section className="flex flex-col gap-3 rounded-xl border border-border-soft bg-surface p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="eyebrow text-muted-foreground">Status</p>
            <p className="text-[12px] text-muted-foreground">
              Onboarding form: {data.intake.answer ? `“${data.intake.answer}”` : 'no answer'}
              {data.intake.link ? (
                <>
                  {' · '}
                  <a href={data.intake.link} target="_blank" rel="noreferrer" className="underline underline-offset-2">
                    their link
                  </a>
                </>
              ) : null}
            </p>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {GBP_STATUSES.map((st) => (
              <button
                key={st}
                type="button"
                disabled={busy === 'status'}
                onClick={() => setStatus(st)}
                className={cn(
                  'rounded-md border px-2.5 py-1 text-[12px] transition',
                  status === st
                    ? st === 'verified' || st === 'has_profile'
                      ? 'border-emerald-500/50 bg-emerald-500/10 font-medium text-emerald-700 dark:text-emerald-300'
                      : 'border-foreground/40 bg-card font-medium'
                    : 'border-border text-muted-foreground hover:bg-muted',
                )}
              >
                {GBP_STATUS_LABEL[st]}
              </button>
            ))}
          </div>
          {flash && <p className="text-[12.5px] text-muted-foreground">{flash}</p>}
        </section>

        {blanks > 0 && (
          <p className="flex items-start gap-2 rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-[13px]">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" />
            <span>
              {blanks} detail{blanks === 1 ? '' : 's'} still blank, highlighted below. Fill {blanks === 1 ? 'it' : 'them'} in on the left.
            </span>
          </p>
        )}

        {/* Step 1 */}
        <Step n={1} title="Check for a listing that already exists" hint="Google often makes one on its own. Claim it instead of creating a duplicate.">
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" onClick={() => act('lookup')} disabled={!!busy} className={btn}>
              {busy === 'lookup' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Search className="h-3.5 w-3.5" />} Search Google Maps
            </button>
            {s.lookup && (
              <span className="text-[12px] text-muted-foreground">
                Searched “{s.lookup.query}” {new Date(s.lookup.at).toLocaleString()}
              </span>
            )}
          </div>
          {s.lookup?.error && <p className="text-[12.5px] text-destructive">{s.lookup.error}</p>}
          {s.lookup && !s.lookup.error && s.lookup.candidates.length === 0 && (
            <p className="text-[12.5px] text-muted-foreground">Nothing on Google Maps matches this business by name, phone or website. Create a new profile.</p>
          )}
          {s.lookup && s.lookup.candidates.length > 0 && (
            <ul className="flex flex-col gap-2">
              {s.lookup.candidates.map((c) => (
                <li key={c.placeId} className="flex flex-wrap items-start justify-between gap-2 rounded-lg border border-border-soft bg-card px-3 py-2 text-[12.5px]">
                  <span className="min-w-0">
                    <span className="flex items-center gap-1.5 font-medium">
                      <MapPin className="h-3.5 w-3.5" /> {c.name}
                    </span>
                    <span className="block text-muted-foreground">
                      {c.address}
                      {c.phone ? ` · ${c.phone}` : ''}
                      {c.status && c.status !== 'OPERATIONAL' ? ` · ${c.status.toLowerCase().replace(/_/g, ' ')}` : ''}
                    </span>
                    <span className="block text-emerald-700 dark:text-emerald-300">{c.matches.join(', ')}</span>
                  </span>
                  {c.mapsUrl && (
                    <a href={c.mapsUrl} target="_blank" rel="noreferrer" className={btn}>
                      Open on Maps <ExternalLink className="h-3 w-3" />
                    </a>
                  )}
                </li>
              ))}
              <li className="text-[12px] text-muted-foreground">
                If one of these is theirs: open it, tap “Own this business?” (or “Claim this business”), and use the owner’s Google email below. Then go to step 3.
              </li>
            </ul>
          )}
        </Step>

        {/* Step 2 */}
        <Step
          n={2}
          title="Create the profile"
          hint="At business.google.com/create, signed in to the Genisys Google account. Copy each box in order, then give the client ownership."
          action={
            <a href="https://business.google.com/create" target="_blank" rel="noreferrer" className={btn}>
              Open Google <ExternalLink className="h-3 w-3" />
            </a>
          }
        >
          <div className="grid gap-3 sm:grid-cols-2">
            {fields.map((f) => (
              <CopyCard key={f.id} field={f} wide={!f.mono && f.text.length > 60} />
            ))}
          </div>
          {status !== 'created' && status !== 'verifying' && status !== 'verified' && (
            <button type="button" onClick={() => setStatus('created')} disabled={!!busy} className={btn}>
              <Check className="h-3.5 w-3.5" /> Mark created
            </button>
          )}
        </Step>

        {/* Step 3 */}
        <Step
          n={3}
          title="Get the owner to verify"
          hint="Google sends verification to the owner. This texts them the steps from the Genisys number, then reminds them every 3 days (up to 5 times, 10am–7pm Eastern) until it’s marked verified."
        >
          <CopyCard field={{ id: 'sms', label: `Text to ${values.ownerFirstName || 'the owner'}${values.ownerPhone ? ` at ${values.ownerPhone}` : ''}`, text: message }} wide />
          <div className="flex flex-wrap items-center gap-3">
            <button type="button" onClick={() => act('text')} disabled={!!busy || status === 'verified'} className={btnPrimary}>
              {busy === 'text' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />} Text it now
            </button>
            <label className="inline-flex items-center gap-2 text-[12.5px] text-muted-foreground">
              <input
                type="checkbox"
                checked={s.remind}
                onChange={async (e) => {
                  await put({ remind: e.target.checked })
                  reload()
                }}
                className="h-4 w-4 accent-foreground"
              />
              Send reminders
            </label>
          </div>
          {s.texts.length > 0 && (
            <ul className="flex flex-col gap-0.5 text-[12px] text-muted-foreground">
              {s.texts
                .slice()
                .reverse()
                .map((t, i) => (
                  <li key={i} className={cn(!t.ok && 'text-destructive')}>
                    {new Date(t.at).toLocaleString()}: {t.kind === 'checklist' ? 'checklist' : 'reminder'} to {t.to} {t.ok ? 'sent' : `failed (${t.detail})`}
                  </li>
                ))}
            </ul>
          )}
        </Step>

        {/* Step 4 */}
        <Step
          n={4}
          title="Record it once verified"
          hint="The profile link goes into the SEO engine’s business facts (the site’s schema). The review link fills the GHL sub-account’s “Review Google URL”, which the review workflows send to customers."
        >
          <div className="grid gap-2 sm:grid-cols-2">
            <label className="flex flex-col gap-1">
              <span className="eyebrow text-muted-foreground/80">Profile link (Google Maps)</span>
              <input value={profileUrl} onChange={(e) => setProfileUrl(e.target.value)} placeholder="https://maps.app.goo.gl/…" className={inputCls} />
            </label>
            <label className="flex flex-col gap-1">
              <span className="eyebrow text-muted-foreground/80">Review link</span>
              <input value={reviewUrl} onChange={(e) => setReviewUrl(e.target.value)} placeholder="https://g.page/r/…/review" className={inputCls} />
            </label>
          </div>
          <p className="text-[11.5px] text-muted-foreground">
            Both are on the profile in Google: Share for the profile link, “Ask for reviews” for the review link.
          </p>
          <button type="button" onClick={() => act('verified', { profileUrl, reviewUrl })} disabled={!!busy} className={btnPrimary}>
            {busy === 'verified' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />} Mark verified and save links
          </button>
        </Step>

        {s.history.length > 0 && (
          <details className="rounded-xl border border-border-soft bg-surface px-4 py-3">
            <summary className="cursor-pointer text-[12.5px] text-muted-foreground">History</summary>
            <ul className="mt-2 flex flex-col gap-0.5 text-[12px] text-muted-foreground">
              {s.history
                .slice()
                .reverse()
                .map((h, i) => (
                  <li key={i}>
                    {new Date(h.at).toLocaleString()}: {h.what}
                    {h.by ? ` (${h.by})` : ''}
                  </li>
                ))}
            </ul>
          </details>
        )}
      </div>
    </div>
  )
}

const btn =
  'inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-border bg-card px-3 py-1.5 text-xs font-medium transition hover:bg-muted disabled:opacity-50'
const btnPrimary =
  'inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-foreground/20 bg-foreground px-3 py-1.5 text-xs font-medium text-background transition hover:opacity-90 disabled:opacity-50'
const inputCls = 'h-9 w-full rounded-md border border-border bg-card px-2.5 py-1.5 text-[13px] outline-none focus:border-foreground/30'

function Step({ n, title, hint, action, children }: { n: number; title: string; hint: string; action?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-3 rounded-xl border border-border bg-card p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h2 className="text-[14px] font-semibold">
            <span className="mr-2 font-mono text-muted-foreground">{n}</span>
            {title}
          </h2>
          <p className="text-[12px] text-muted-foreground">{hint}</p>
        </div>
        {action}
      </div>
      {children}
    </section>
  )
}

function CopyCard({ field, wide }: { field: GbpField; wide?: boolean }) {
  const [copied, setCopied] = useState(false)
  const text = forCopy(field.text)
  const over = field.limit ? text.length > field.limit : false
  return (
    <div className={cn('flex min-w-0 flex-col gap-2 rounded-lg border border-border-soft bg-surface p-3', wide && 'sm:col-span-2')}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[13px] font-medium">{field.label}</p>
          {field.limit && (
            <p className={cn('font-mono text-[11px]', over ? 'text-destructive' : 'text-muted-foreground')}>
              {text.length}/{field.limit} characters
            </p>
          )}
        </div>
        <button
          type="button"
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(text)
              setCopied(true)
              setTimeout(() => setCopied(false), 1500)
            } catch {
              setCopied(false)
            }
          }}
          className={cn(
            'inline-flex shrink-0 items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-medium transition',
            copied ? 'border-emerald-500/40 text-emerald-600 dark:text-emerald-400' : 'border-border bg-card hover:bg-muted',
          )}
        >
          {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <div className={cn('whitespace-pre-wrap break-words rounded-md border border-border-soft bg-card px-3 py-2 leading-relaxed', field.mono ? 'font-mono text-[12.5px]' : 'text-[13px]')}>
        {field.text.split(BLANK).map((part, i) =>
          i % 2 === 1 ? (
            <mark key={i} className="rounded bg-amber-500/20 px-0.5 font-medium text-amber-700 dark:text-amber-300">
              [{part}]
            </mark>
          ) : (
            <span key={i}>{part}</span>
          ),
        )}
      </div>
      {field.note && <p className="text-[11.5px] leading-snug text-muted-foreground">{field.note}</p>}
    </div>
  )
}
