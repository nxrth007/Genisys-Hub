'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { AppWindow, ArrowLeft, Check, Copy, ExternalLink, Folder, Hammer, Loader2, Phone, PhoneForwarded, MessageSquareShare, RotateCcw } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { GhlRegistrationView, SiteDetail } from '@/lib/sites'
import { cantTextYet } from '@/lib/ghl-number/census-plan'
import { SITE_STATUS_LABEL, siteHost, siteHref, textingLine } from '@/lib/site-status'
import { StatusBadge } from './sites-grid'
import { BuilderWindow, DomainCodeBox } from './builder-window'
import { ConfirmDialog, postAction } from './confirm-dialog'
import { DomainCard } from './domain-card'

/** "+18556762067" → "(855) 676-2067". */
function pretty(n: string | null | undefined): string {
  const d = (n ?? '').replace(/\D/g, '').replace(/^1(?=\d{10}$)/, '')
  return d.length === 10 ? `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}` : (n ?? '')
}

const STAGE_STYLE: Record<string, string> = {
  done: 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400',
  in_progress: 'bg-sky-500/15 text-sky-600 dark:text-sky-400',
  blocked: 'bg-red-500/15 text-red-600 dark:text-red-400',
  pending: 'bg-muted text-muted-foreground',
  not_needed: 'bg-muted text-muted-foreground',
  none: 'text-muted-foreground/70',
}
const STAGE_WORD: Record<string, string> = { done: 'Done', in_progress: 'In progress', blocked: 'Blocked', pending: 'Not started', not_needed: 'Not needed', none: 'No record' }

function CopyButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <button
      type="button"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value)
          setCopied(true)
          setTimeout(() => setCopied(false), 1500)
        } catch {
          // Clipboard blocked: the value is on screen to copy by hand.
        }
      }}
      className="inline-flex shrink-0 items-center gap-1 rounded-md border border-border px-2 py-1 text-[11.5px] font-medium text-muted-foreground transition hover:bg-muted hover:text-foreground"
      aria-label={`Copy ${label}`}
    >
      {copied ? <Check className="h-3.5 w-3.5 text-emerald-500" /> : <Copy className="h-3.5 w-3.5" />}
      {copied ? 'Copied' : 'Copy'}
    </button>
  )
}

function Card({ title, children, className, id }: { title: string; children: React.ReactNode; className?: string; id?: string }) {
  return (
    <section id={id} className={cn('flex flex-col gap-3 rounded-xl border border-border bg-card p-4', className)}>
      <h2 className="text-[14px] font-semibold text-foreground">{title}</h2>
      {children}
    </section>
  )
}

const REG_WORD: Record<string, string> = {
  none: 'Not started',
  waiting_site: 'Waits for the site',
  queued: 'Queued',
  review: 'Waiting for an OK',
  approved: 'Sending',
  submitted: 'Sent',
  held: 'On hold',
  needs_human: 'Stopped',
}
const REG_STYLE: Record<string, string> = {
  submitted: STAGE_STYLE.done,
  review: 'bg-amber-500/15 text-amber-600 dark:text-amber-400',
  approved: STAGE_STYLE.in_progress,
  queued: STAGE_STYLE.in_progress,
  needs_human: STAGE_STYLE.blocked,
}
const STEP_TITLE: Record<number, string> = { 1: 'Business and contact', 2: 'Business location', 3: 'Messaging use case' }

function registrationLine(r: GhlRegistrationView): string {
  if (r.running) return 'The worker is filling GHL’s toll-free form now.'
  switch (r.state) {
    case 'waiting_site':
      return 'Waits for the site link: GHL’s reviewers check the live site.'
    case 'queued':
      return 'Queued: the worker fills GHL’s form next, then asks in the Office before sending.'
    case 'review':
      return 'Filled and stopped before sending. Echo is asking in the Office: Send it, or Not now.'
    case 'approved':
      return 'Approved: the worker fills the form again and sends it.'
    case 'submitted':
      return 'Sent to GHL. GHL says reviews can take up to 4–6 weeks.'
    case 'held':
      return 'On hold. Fill it again once the details are right.'
    case 'needs_human':
      return 'Stopped. Fix what it says, then fill it again.'
    default:
      return 'Starts by itself once the number is in GHL and the site link is in.'
  }
}

/** GHL's toll-free registration for a number in GHL: where it stands, what was filled, and pictures of the form. */
function GhlRegistrationCard({ clientId, r, canAct }: { clientId: string; r: GhlRegistrationView; canAct: boolean }) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  async function fillAgain() {
    setBusy(true)
    setMsg(null)
    try {
      const res = await fetch('/api/office/approvals', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: r.jobId, kind: 'registration', decision: 'retry' }),
      })
      const out = (await res.json().catch(() => ({}))) as { detail?: string; error?: string }
      setMsg(res.ok ? out.detail || 'Queued.' : out.error || `HTTP ${res.status}`)
      router.refresh()
    } finally {
      setBusy(false)
    }
  }
  const steps = [1, 2, 3].map((step) => ({ step, rows: r.rows.filter((x) => x.step === step) })).filter((x) => x.rows.length)
  const showDetail = !!r.detail && (r.state === 'needs_human' || r.state === 'held' || /changed|Dry-run/.test(r.detail))
  return (
    <Card title="Toll-free registration in GHL" id="ghl-registration" className="scroll-mt-6">
      <div className="flex flex-wrap items-center gap-2">
        <span className={cn('rounded-full px-2 py-0.5 text-[11px] font-semibold', r.running ? STAGE_STYLE.in_progress : (REG_STYLE[r.state] ?? STAGE_STYLE.pending))}>
          {r.running ? 'Filling now' : (REG_WORD[r.state] ?? r.state)}
        </span>
        {r.at && (
          <span className="text-[11.5px] text-muted-foreground" suppressHydrationWarning>
            Last run {new Date(r.at).toLocaleString()}
          </span>
        )}
      </div>
      <p className="text-[12.5px] text-foreground/90">{registrationLine(r)}</p>
      {showDetail && <p className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-[12.5px] leading-snug">{r.detail}</p>}
      {steps.length > 0 && (
        <div className="flex flex-col gap-3">
          <p className="text-[11.5px] text-muted-foreground">
            What the Hub put in GHL’s form{r.state === 'submitted' ? '' : '. Send it sends exactly this; if the client’s details change first, Echo asks again'}:
          </p>
          {steps.map(({ step, rows }) => (
            <div key={step}>
              <h3 className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                Step {step} · {STEP_TITLE[step] ?? ''}
              </h3>
              <dl className="grid gap-x-4 gap-y-1.5 sm:grid-cols-[minmax(150px,210px)_1fr]">
                {rows.map((x) => (
                  <div key={x.label} className="contents">
                    <dt className="text-[12px] text-muted-foreground">{x.label}</dt>
                    <dd className="whitespace-pre-wrap break-words text-[12.5px] text-foreground">{x.value}</dd>
                  </div>
                ))}
              </dl>
            </div>
          ))}
        </div>
      )}
      {r.shots.length > 0 && (
        <div className="flex flex-wrap gap-3">
          {r.shots.map((s) => (
            <a key={s.id} href={`/api/clients/${clientId}/ghl-number/shots/${s.id}`} target="_blank" rel="noopener noreferrer" className="group flex w-[176px] flex-col gap-1">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={`/api/clients/${clientId}/ghl-number/shots/${s.id}`}
                alt={s.step}
                loading="lazy"
                className="h-[104px] w-full rounded-md border border-border object-cover object-top transition group-hover:opacity-90"
              />
              <span className="truncate text-[11px] text-muted-foreground" title={s.step}>
                {s.step}
              </span>
            </a>
          ))}
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2">
        {r.state === 'review' && (
          <Link href="/office" className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-card px-3 py-1.5 text-[12.5px] font-medium hover:bg-muted">
            Answer it in the Office
          </Link>
        )}
        {canAct && !r.running && (r.state === 'held' || r.state === 'needs_human') && (
          <button
            type="button"
            onClick={fillAgain}
            disabled={busy}
            className="inline-flex items-center gap-1.5 rounded-lg border border-foreground/20 bg-foreground px-3 py-1.5 text-[12.5px] font-medium text-background transition hover:opacity-90 disabled:opacity-50"
          >
            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RotateCcw className="h-3.5 w-3.5" />} Fill it again
          </button>
        )}
      </div>
      {msg && <p className="text-[12px] text-muted-foreground">{msg}</p>}
    </Card>
  )
}

/** What the folder says when the client has no number the Hub bought: what GHL shows, from the daily read. */
function ghlNumbersLine(d: SiteDetail): string {
  const g = d.ghlNumbers
  if (!g) return 'No toll-free number yet. Echo asks about one in the Office right after onboarding (Hell-level).'
  if (d.phone === 'needs') return 'GHL shows no number on this sub-account yet, so it needs one.'
  if (d.phone === 'no_phone_system') return 'GHL says this sub-account’s phone system requires configuration (GHL support sets that up). A Hell-level number works without it.'
  // The daily GHL read is paused (2026-11-13), so most older clients were never read.
  if (g.state === 'error') return `No toll-free number yet, and the Hub couldn’t read this client’s GHL numbers${g.detail ? ` (${g.detail})` : ''}. Check their GHL sub-account for a number before asking.`
  return 'No toll-free number yet. The Hub hasn’t checked their GHL sub-account for a number, so look there before asking.'
}

/** Numbers already in their GHL sub-account (the daily read): set up, so Echo doesn't ask about one. */
function GhlNumbersList({ g }: { g: NonNullable<SiteDetail['ghlNumbers']> }) {
  const unverified = cantTextYet(g.numbers)
  return (
    <>
      <ul className="flex flex-col gap-2">
        {g.numbers.map((x) => (
          <li key={x.number} className="flex flex-wrap items-center gap-2">
            <span className="text-[22px] font-semibold tabular-nums tracking-tight text-foreground">{pretty(x.number)}</span>
            <CopyButton value={pretty(x.number)} label="the number" />
            <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] font-semibold text-muted-foreground">In GHL · {x.tollFree ? 'Toll-free' : 'Local'}</span>
            {x.isDefault && g.numbers.length > 1 && <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] font-semibold text-muted-foreground">Default</span>}
            {x.verificationRequired && (
              <span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-[11px] font-semibold text-amber-600 dark:text-amber-400">Verification Required</span>
            )}
          </li>
        ))}
      </ul>
      <p className="text-[12.5px] text-muted-foreground">Already set up in GHL, so Echo doesn’t ask about a number for this client. Texts and calls land in GHL’s Conversations.</p>
      {unverified.length > 0 && (
        <p className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-[12.5px] leading-snug">
          Can’t text yet: GHL shows “Verification Required” on {unverified.length === 1 ? pretty(unverified[0].number) : `${unverified.length} of these numbers`}. No texts go out from {unverified.length === 1 ? 'it' : 'them'}, replies and this client’s texting automations included, until the registration is filed in GHL.
        </p>
      )}
      {g.checkedAt && (
        <p className="text-[11.5px] text-muted-foreground" suppressHydrationWarning>
          Read from GHL {new Date(g.checkedAt).toLocaleString()}.
        </p>
      )}
    </>
  )
}

/** The snapshot's site form, made the client's own in GHL (src/lib/ghl-form), and the button that runs it. */
function SiteFormCard({ clientId, f, canAct }: { clientId: string; f: NonNullable<SiteDetail['siteForm']>; canAct: boolean }) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const working = f.status === 'queued' || f.status === 'running'
  async function fix() {
    setBusy(true)
    setMsg(null)
    try {
      const res = await fetch(`/api/clients/${clientId}/ghl-form`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'fix' }) })
      const out = (await res.json().catch(() => ({}))) as { reason?: string; error?: string }
      setMsg(res.ok ? out.reason || 'Queued.' : out.error || `HTTP ${res.status}`)
      router.refresh()
    } finally {
      setBusy(false)
    }
  }
  const line = working
    ? 'The worker is making the form theirs in GHL: their name in the consent checkboxes, no A Plus logo or links.'
    : f.status === 'succeeded'
      ? 'Theirs: the consent checkboxes name the client, with no A Plus logo or links (checked on the public form).'
      : f.status === 'needs_human' || f.status === 'failed'
        ? 'The last run stopped before saving anything half-done:'
        : 'Not made theirs yet. The Hub does it right after a new sub-account’s snapshot loads; for this one, press Fix the form in GHL.'
  return (
    <Card title="Form for the site" id="site-form">
      <p className="text-[12.5px] text-foreground/90">{line}</p>
      {(f.status === 'needs_human' || f.status === 'failed') && f.detail && (
        <p className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-[12.5px] leading-snug">{f.detail}</p>
      )}
      <div className="flex flex-wrap items-center gap-3 text-[12.5px]">
        {f.formUrl && (
          <a href={f.formUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1.5 text-foreground hover:underline">
            <ExternalLink className="h-3.5 w-3.5 text-muted-foreground" /> Public form
          </a>
        )}
        {f.hasShot && (f.status === 'needs_human' || f.status === 'failed') && (
          <a href={`/api/clients/${clientId}/ghl-form/shot`} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1.5 text-foreground hover:underline">
            <ExternalLink className="h-3.5 w-3.5 text-muted-foreground" /> Where it stopped
          </a>
        )}
        {f.at && (
          <span className="text-[11.5px] text-muted-foreground" suppressHydrationWarning>
            Last run {new Date(f.at).toLocaleString()}
          </span>
        )}
      </div>
      {canAct && !working && (
        <div>
          <button
            type="button"
            onClick={fix}
            disabled={busy}
            className="inline-flex items-center gap-1.5 rounded-lg border border-foreground/20 bg-foreground px-3 py-1.5 text-[12.5px] font-medium text-background transition hover:opacity-90 disabled:opacity-50"
          >
            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RotateCcw className="h-3.5 w-3.5" />} {f.status === 'succeeded' ? 'Check the form again' : 'Fix the form in GHL'}
          </button>
        </div>
      )}
      {msg && <p className="text-[12px] text-muted-foreground">{msg}</p>}
    </Card>
  )
}

/** A build Forge is under way on (Lovable building, publishing, connecting): nothing to press meanwhile. */
const BUILD_WORKING = ['filling', 'copying', 'sending', 'building', 'waiting_on_lovable', 'publishing', 'connecting']
/** Built, not published: Publish it can be pressed here as well as in the Office. */
const BUILD_PUBLISHABLE = ['built', 'held']

/** Connecting their domain waits for what Lovable shows for it (Settings → Domains → Connect domain → manual). */
function wantsLovableCode(d: SiteDetail): boolean {
  const b = d.build
  return !!b && b.status === 'connecting' && ['records', 'asking', 'lovable'].includes(b.domainStep ?? '') && !b.hasCode
}

/** Forge's website build: where it stands, the copy in Lovable, the one-shot it sent, and Build site (the Office's question answered here). */
function SiteBuildCard({ d, canAct, onOpenBuilder }: { d: SiteDetail; canAct: boolean; onOpenBuilder: (() => void) | null }) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const [prompt, setPrompt] = useState<string | null>(null)
  const b = d.build
  const working = !!b && BUILD_WORKING.includes(b.status)
  const publishable = !!b && BUILD_PUBLISHABLE.includes(b.status) && !!b.editorUrl
  const ready = d.siteDomain && 'name' in d.siteDomain ? d.siteDomain : null
  const moving = d.siteDomain && 'waiting' in d.siteDomain ? d.siteDomain.waiting : null
  const connectable = !!b && b.status === 'published' && !!ready
  const domainAsked = d.domainQuestion?.status === 'awaiting_approval' || d.domainQuestion?.status === 'buying'
  const wantsCode = wantsLovableCode(d)
  const build = d.actions.build
  const [buildOpen, setBuildOpen] = useState(false)
  // What the build would use, read when its confirmation opens (no cost): photos, domain, phone, and what stops it.
  const [pre, setPre] = useState<{ text: string; missing: string[] } | null>(null)

  async function openBuild() {
    setPre(null)
    setBuildOpen(true)
    try {
      const res = await fetch(`/api/clients/${d.client.id}/hl-site?preflight=1`, { cache: 'no-store' })
      const out = (await res.json().catch(() => ({}))) as { preflight?: { text: string; missing: string[] } }
      setPre(out.preflight ?? { text: 'Couldn’t read what the build would use; the Hub checks again when you press Build it.', missing: [] })
    } catch {
      setPre({ text: 'Couldn’t read what the build would use; the Hub checks again when you press Build it.', missing: [] })
    }
  }

  /** Build site: Forge's Build it, from here (Claude and Lovable credits; nothing is published). */
  async function startBuild(): Promise<string | null> {
    if (build.kind !== 'build') return null
    const r = await postAction(`/api/clients/${d.client.id}/hl-site`, { action: 'build', overrideGhl: build.overrideGhl })
    router.refresh()
    if (!r.ok) return r.reason
    setMsg(typeof r.data.detail === 'string' && r.data.detail ? r.data.detail : 'Started.')
    return null
  }

  async function act(action: 'publish' | 'connect') {
    setBusy(true)
    setMsg(null)
    try {
      const res = await fetch(`/api/clients/${d.client.id}/hl-site`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action }) })
      const out = (await res.json().catch(() => ({}))) as { ok?: boolean; reason?: string; detail?: string | null; error?: string }
      setMsg(out.ok ? out.detail || 'Started.' : out.reason || out.error || (action === 'publish' ? 'Couldn’t publish.' : 'Couldn’t connect it.'))
      router.refresh()
    } finally {
      setBusy(false)
    }
  }

  async function showPrompt() {
    if (prompt) return setPrompt(null)
    const res = await fetch(`/api/clients/${d.client.id}/hl-site`, { cache: 'no-store' })
    const out = (await res.json().catch(() => ({}))) as { request?: { prompt?: string | null } | null }
    setPrompt(out.request?.prompt ?? 'No one-shot saved.')
  }

  return (
    <Card title="Website build">
      <p className="text-[13px] text-foreground/90">
        {b ? b.label : d.ghlLinked ? 'Set up in GHL: their site is built by hand, with GHL’s form.' : 'Forge hasn’t asked about their website yet.'}
      </p>
      {b?.detail && <p className="text-[12.5px] leading-snug text-muted-foreground">{b.detail}</p>}
      <p className="text-[12.5px] leading-snug text-muted-foreground">
        {ready
          ? `Domain: ${ready.name}${ready.managed ? '' : ' (its DNS is managed outside the Hub)'}${
              b?.status === 'connected'
                ? ', connected.'
                : b?.status === 'connecting'
                  ? ', being connected.'
                  : b?.status === 'published'
                    ? b.domainStep === 'held'
                      ? '. Not connected (Not now): connect it from here.'
                      : '. Forge asks in the Office to connect it.'
                    : '. Forge connects it once the site is published.'
            }`
          : moving
            ? `Domain: ${moving} is still moving into their Hell-level Domains. Forge connects it once it has.`
            : domainAsked
              ? 'Domain: pick one of Forge’s suggestions above (Domain for the site).'
              : 'Domain: none yet. Pick one above (Domain for the site), or add theirs in Hell-level → Domains.'}
      </p>
      {(onOpenBuilder || b?.hasPrompt || b?.liveUrl) && (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[12.5px]">
          {onOpenBuilder && (
            <button type="button" onClick={onOpenBuilder} className="inline-flex items-center gap-1.5 text-foreground hover:underline">
              <AppWindow className="h-3.5 w-3.5 text-muted-foreground" /> Open website in builder
            </button>
          )}
          {b?.liveUrl && (
            <a href={b.liveUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1.5 text-foreground hover:underline">
              <ExternalLink className="h-3.5 w-3.5 text-muted-foreground" /> {b.liveUrl.replace(/^https?:\/\//, '')}
            </a>
          )}
          {b?.hasPrompt && (
            <button type="button" onClick={showPrompt} className="text-foreground hover:underline">
              {prompt ? 'Hide the one-shot' : 'See the one-shot'}
            </button>
          )}
        </div>
      )}
      {wantsCode && <DomainCodeBox clientId={d.client.id} domain={b?.domain ?? null} inputId="lovable-code" />}
      {canAct && !working && d.account && (publishable || (connectable && ready) || build.kind === 'build') && (
        <div className="flex flex-wrap items-center gap-2">
          {publishable && (
            <button
              type="button"
              onClick={() => act('publish')}
              disabled={busy}
              className="inline-flex items-center gap-1.5 rounded-lg border border-foreground/20 bg-foreground px-3 py-1.5 text-[12.5px] font-medium text-background transition hover:opacity-90 disabled:opacity-50"
            >
              {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />} Publish it
            </button>
          )}
          {connectable && ready && (
            <button
              type="button"
              onClick={() => act('connect')}
              disabled={busy}
              className="inline-flex items-center gap-1.5 rounded-lg border border-foreground/20 bg-foreground px-3 py-1.5 text-[12.5px] font-medium text-background transition hover:opacity-90 disabled:opacity-50"
            >
              {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />} Connect {ready.name}
            </button>
          )}
          {build.kind === 'build' && (
            <button
              type="button"
              onClick={openBuild}
              disabled={busy}
              className={
                publishable
                  ? 'inline-flex items-center gap-1.5 rounded-lg border border-border bg-card px-3 py-1.5 text-[12.5px] font-medium text-foreground transition hover:bg-muted disabled:opacity-50'
                  : 'inline-flex items-center gap-1.5 rounded-lg border border-foreground/20 bg-foreground px-3 py-1.5 text-[12.5px] font-medium text-background transition hover:opacity-90 disabled:opacity-50'
              }
            >
              <Hammer className="h-3.5 w-3.5" /> {build.again ? 'Build it again' : build.overrideGhl ? 'Build site (Hell-level form and chat)' : 'Build site'}
            </button>
          )}
        </div>
      )}
      {canAct && build.kind === 'none' && !b && <p className="text-[12.5px] text-muted-foreground">{build.reason}</p>}
      {msg && <p className="text-[12px] text-muted-foreground">{msg}</p>}
      {prompt && <pre className="max-h-[420px] overflow-auto whitespace-pre-wrap rounded-lg bg-background px-3 py-2.5 font-mono text-[11.5px] leading-relaxed text-muted-foreground">{prompt}</pre>}
      <ConfirmDialog
        open={buildOpen}
        title={`Build ${d.client.name}’s website?`}
        confirmLabel="Build it"
        disabled={!pre || pre.missing.length > 0}
        onConfirm={startBuild}
        onClose={() => setBuildOpen(false)}
      >
        <p>
          Claude fills Ethan’s one-shot from their onboarding answers and photos (about $0.50), with their Hell-level quote form and chat widget. Then the Hub copies Robert Taylor’s site in
          Lovable (free) and sends it the one-shot: Lovable credits (the last build used about 19) and about 20 minutes.
        </p>
        <p className={pre?.missing.length ? 'rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2' : 'text-muted-foreground'}>
          {pre ? pre.text : 'Checking what it would use…'}
        </p>
        {build.kind === 'build' && build.overrideGhl && <p>They’re set up in GHL: this site gets Hell-level’s quote form and chat, not GHL’s.</p>}
        {build.kind === 'build' && build.again && <p>The earlier copy stays in Lovable; Forge works on the new one.</p>}
        <p className="text-muted-foreground">
          Nothing is published: Forge asks before it publishes.{build.kind === 'build' && build.answersOffice ? ' This answers Forge’s question in the Office.' : ''}
        </p>
      </ConfirmDialog>
    </Card>
  )
}

/** One client's folder, opened: their status, their site, and what the site build needs. `openBuilder` opens the builder window straight away (?builder=1, the Office's link). */
export function SiteDetailView({ d, canAsk, openBuilder = false }: { d: SiteDetail; canAsk: boolean; openBuilder?: boolean }) {
  const router = useRouter()
  const [askMsg, setAskMsg] = useState<string | null>(null)
  const [buyOpen, setBuyOpen] = useState(false)
  const [builderOpen, setBuilderOpen] = useState(openBuilder && !!d.builder)
  const live = d.status === 'live'
  const req = d.request
  const ready = d.siteDomain && 'name' in d.siteDomain ? d.siteDomain : null
  const connectDomain = wantsLovableCode(d) ? (d.build?.domain ?? null) : null
  // Buy toll-free number: Echo's question answered here (src/lib/hl/folder-plan.ts says when it applies;
  // never when their GHL sub-account has a number: Alex's rule, set up already).
  const numberAction = d.actions.number

  async function buyNumber(): Promise<string | null> {
    const r = await postAction(`/api/clients/${d.client.id}/hl-number`, { action: 'buy' })
    router.refresh()
    if (!r.ok) return r.reason
    setAskMsg(typeof r.data.detail === 'string' && r.data.detail ? r.data.detail : 'Bought.')
    return null
  }

  const details: { label: string; value: string | null }[] = [
    { label: 'Business name', value: d.account?.businessName ?? null },
    { label: 'Business phone', value: d.account?.businessPhone ?? null },
    { label: 'Email', value: d.account?.notifyEmail ?? null },
    { label: 'Address', value: d.account?.address ?? null },
  ]

  return (
    <div className="mx-auto flex max-w-[1080px] flex-col gap-5">
      <Link href="/sites" className="inline-flex w-fit items-center gap-1.5 text-[12.5px] text-muted-foreground hover:text-foreground">
        <ArrowLeft className="h-4 w-4" /> All sites
      </Link>

      <header className="flex flex-wrap items-center gap-4">
        <span className="relative">
          <Folder className="h-16 w-16" style={{ color: d.client.color, fill: `${d.client.color}2e` }} strokeWidth={1.25} aria-hidden />
          <StatusBadge status={d.status} size="lg" className="absolute -right-2 top-0" />
        </span>
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-[24px] font-semibold tracking-tight text-foreground">{d.client.name}</h1>
          <p className={cn('text-[13px]', live ? 'text-muted-foreground' : 'text-amber-600 dark:text-amber-400')}>
            {SITE_STATUS_LABEL[d.status]}
            {live && d.client.siteUrl ? ` · ${siteHost(d.client.siteUrl)}` : ''}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {d.builder && (
            <button
              type="button"
              onClick={() => setBuilderOpen(true)}
              className="inline-flex items-center gap-1.5 rounded-lg border border-foreground/20 bg-foreground px-4 py-2 text-[13px] font-medium text-background transition hover:opacity-90"
            >
              <AppWindow className="h-4 w-4" /> Open website in builder
            </button>
          )}
          {live && d.client.siteUrl ? (
            <a
              href={siteHref(d.client.siteUrl)}
              target="_blank"
              rel="noopener noreferrer"
              className={cn(
                'inline-flex items-center gap-1.5 rounded-lg px-4 py-2 text-[13px] font-medium transition',
                d.builder ? 'border border-border bg-card text-foreground hover:bg-muted' : 'border border-foreground/20 bg-foreground text-background hover:opacity-90',
              )}
            >
              <ExternalLink className="h-4 w-4" /> Open website
            </a>
          ) : (
            <Link href={`/clients?focus=${d.client.id}`} className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-card px-4 py-2 text-[13px] font-medium text-foreground transition hover:bg-muted">
              Add the site link on Clients
            </Link>
          )}
        </div>
      </header>

      {d.builder && (
        <BuilderWindow
          open={builderOpen}
          onClose={() => setBuilderOpen(false)}
          clientId={d.client.id}
          clientName={d.client.name}
          site={d.builder}
          connect={connectDomain ? { domain: connectDomain, managed: ready && ready.name === connectDomain ? ready.managed : true } : null}
          detail={d.build?.detail ?? null}
        />
      )}

      <div className="grid gap-5 lg:grid-cols-[1.1fr_1fr]">
        <Card title="Toll-free number for the site">
          {d.number ? (
            <>
              <div className="flex flex-wrap items-center gap-3">
                <span className="text-[26px] font-semibold tabular-nums tracking-tight text-foreground">{pretty(d.number.number)}</span>
                <CopyButton value={pretty(d.number.number)} label="the toll-free number" />
                <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] font-semibold text-muted-foreground">{d.number.where === 'ghl' ? 'In GHL' : 'Hell-level'}</span>
              </div>
              <p className="text-[12.5px] text-muted-foreground">Put this number on their site. Leads who call or text it reach the client, and every lead goes through Hell-level’s automations.</p>
              <ul className="flex flex-col gap-1.5 text-[12.5px] text-foreground/90">
                <li className="flex items-center gap-2">
                  <PhoneForwarded className="h-4 w-4 shrink-0 text-muted-foreground" />
                  {d.number.forwardTo ? `Calls ring ${pretty(d.number.forwardTo)}.` : 'Calls aren’t forwarded: every call counts as missed and gets the text-back.'}
                </li>
                <li className="flex items-center gap-2">
                  <MessageSquareShare className="h-4 w-4 shrink-0 text-muted-foreground" />
                  {d.number.where === 'ghl'
                    ? 'Texts land in GHL’s Conversations for the sub-account.'
                    : d.number.forwardTextsTo
                      ? `Texts are forwarded to ${pretty(d.number.forwardTextsTo)}.`
                      : 'Texts aren’t forwarded (set it in Hell-level → Settings → Phone Numbers).'}
                </li>
              </ul>
              <p
                className={cn(
                  'rounded-lg border px-3 py-2 text-[12.5px] leading-snug',
                  d.number.verificationStatus === 'approved'
                    ? 'border-emerald-500/30 bg-emerald-500/10'
                    : d.number.verificationStatus === 'rejected'
                      ? 'border-red-500/30 bg-red-500/10'
                      : 'border-border bg-surface',
                )}
              >
                {textingLine({ verificationStatus: d.number.verificationStatus, verificationNote: d.number.verificationNote, siteLive: live })}
                {req?.verifyNote && d.number.verificationStatus !== 'rejected' ? ` Waiting on: ${req.verifyNote}` : ''}
              </p>
            </>
          ) : d.phone === 'ghl' && d.ghlNumbers?.numbers.length ? (
            <GhlNumbersList g={d.ghlNumbers} />
          ) : (
            <>
              <p className="text-[13px] text-foreground/90">
                {req?.status === 'awaiting_approval'
                  ? 'Echo asked in the Office whether to buy a Hell-level toll-free number.'
                  : req?.status === 'awaiting_identity'
                    ? 'GHL chosen: waiting for the ID check, then Identification complete in the Office.'
                    : req?.status === 'ghl_working' || req?.status === 'buying'
                      ? 'Getting the number now.'
                  : req?.status === 'declined'
                    ? 'Someone answered No in the Office.'
                    : req?.status === 'failed'
                      ? `The last try failed${req.detail ? `: ${req.detail}` : '.'}`
                      : ghlNumbersLine(d)}
              </p>
              {(req?.status === 'declined' || req?.status === 'failed') && <p className="text-[12.5px] text-muted-foreground">{ghlNumbersLine(d)}</p>}
              <div className="flex flex-wrap items-center gap-2">
                {canAsk && numberAction.kind === 'buy' ? (
                  <button
                    type="button"
                    onClick={() => setBuyOpen(true)}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-foreground/20 bg-foreground px-3 py-1.5 text-[12.5px] font-medium text-background transition hover:opacity-90 disabled:opacity-50"
                  >
                    <Phone className="h-3.5 w-3.5" /> Buy toll-free number
                  </button>
                ) : req?.status === 'awaiting_approval' || req?.status === 'awaiting_identity' ? (
                  <Link href="/office" className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-card px-3 py-1.5 text-[12.5px] font-medium hover:bg-muted">
                    Answer it in the Office
                  </Link>
                ) : null}
              </div>
              {canAsk && numberAction.kind === 'none' && (!req || req.status === 'declined' || req.status === 'failed') && (
                <p className="text-[12.5px] text-muted-foreground">{numberAction.reason}</p>
              )}
              {askMsg && <p className="text-[12px] text-muted-foreground">{askMsg}</p>}
              <ConfirmDialog open={buyOpen} title={`Buy a toll-free number for ${d.client.name}?`} confirmLabel="Buy it" onConfirm={buyNumber} onClose={() => setBuyOpen(false)}>
                <p>About $2.15/month on Genisys’s Twilio (Hell-level), no ID check. Twilio picks an available toll-free number.</p>
                <p>
                  {d.numberTo.ring
                    ? `Calls ring ${pretty(d.numberTo.ring)}; whoever answers presses a key to take the call.`
                    : 'No business phone is on file, so every call to it counts as missed and gets the text-back.'}
                  {d.numberTo.texts ? ` Texts to it are forwarded to ${pretty(d.numberTo.texts)}.` : ''}
                </p>
                <p className="text-muted-foreground">
                  Its texting verification is filed once their site link is in (free; Twilio reviews it in about 3 business days).
                  {numberAction.kind === 'buy' && numberAction.answersOffice ? ' This answers Echo’s question in the Office.' : ''}
                </p>
              </ConfirmDialog>
            </>
          )}
        </Card>

        <Card title="Status">
          <ul className="flex flex-col divide-y divide-border">
            {d.journey.map((s) => (
              <li key={s.stage} className="flex items-start justify-between gap-3 py-2 first:pt-0 last:pb-0">
                <span className="min-w-0">
                  {s.href ? (
                    <Link href={s.href} className="text-[13px] font-medium text-foreground underline-offset-2 hover:text-primary hover:underline">
                      {s.label}
                    </Link>
                  ) : (
                    <span className="text-[13px] font-medium text-foreground">{s.label}</span>
                  )}
                  {s.note && <span className="block truncate text-[11.5px] text-muted-foreground" title={s.note}>{s.note}</span>}
                </span>
                <span className={cn('shrink-0 rounded-full px-2 py-0.5 text-[11px] font-semibold', STAGE_STYLE[s.status] ?? STAGE_STYLE.pending)}>{STAGE_WORD[s.status] ?? s.status}</span>
              </li>
            ))}
          </ul>
        </Card>
      </div>

      {d.ghlRegistration && <GhlRegistrationCard clientId={d.client.id} r={d.ghlRegistration} canAct={canAsk} />}

      {d.siteForm && <SiteFormCard clientId={d.client.id} f={d.siteForm} canAct={canAsk} />}

      <DomainCard d={d} canAct={canAsk} />

      <SiteBuildCard d={d} canAct={canAsk} onOpenBuilder={d.builder ? () => setBuilderOpen(true) : null} />

      <div className="grid gap-5 lg:grid-cols-[1.1fr_1fr]">
        <Card title="Details for the site">
          <dl className="flex flex-col gap-2">
            {details.map((x) => (
              <div key={x.label} className="flex items-center justify-between gap-3">
                <span className="min-w-0">
                  <dt className="text-[11.5px] text-muted-foreground">{x.label}</dt>
                  <dd className="truncate text-[13px] text-foreground">{x.value || '—'}</dd>
                </span>
                {x.value && <CopyButton value={x.value} label={x.label.toLowerCase()} />}
              </div>
            ))}
          </dl>
        </Card>

        <Card title="Links">
          <ul className="flex flex-col gap-1.5 text-[13px]">
            {d.client.siteUrl && (
              <li>
                <a href={siteHref(d.client.siteUrl)} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1.5 text-foreground hover:underline">
                  <ExternalLink className="h-3.5 w-3.5 text-muted-foreground" /> Website · {siteHost(d.client.siteUrl)}
                </a>
              </li>
            )}
            {d.seo?.lovableProjectId && (
              <li>
                <a href={`https://lovable.dev/projects/${d.seo.lovableProjectId}`} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1.5 text-foreground hover:underline">
                  <ExternalLink className="h-3.5 w-3.5 text-muted-foreground" /> Lovable project
                </a>
              </li>
            )}
            {d.seo?.repo && (
              <li>
                <a href={`https://github.com/${d.seo.repo}`} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1.5 text-foreground hover:underline">
                  <ExternalLink className="h-3.5 w-3.5 text-muted-foreground" /> GitHub · {d.seo.repo}
                </a>
              </li>
            )}
            {d.account && (
              <li>
                <Link href={`/hell-level/${d.account.id}/settings?tab=phone-numbers`} className="text-foreground hover:underline">
                  Hell-level sub-account · Phone Numbers
                </Link>
              </li>
            )}
            <li>
              <Link href={`/automation-copy/${d.client.id}`} className="text-foreground hover:underline">
                Automation Copy
              </Link>
            </li>
            <li>
              <Link href={`/clients?focus=${d.client.id}`} className="text-foreground hover:underline">
                Client record
              </Link>
            </li>
          </ul>
        </Card>
      </div>
    </div>
  )
}
