'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { ArrowLeft, Check, Copy, ExternalLink, Folder, Loader2, PhoneForwarded, MessageSquareShare } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { SiteDetail } from '@/lib/sites'
import { SITE_STATUS_LABEL, siteHost, siteHref, textingLine } from '@/lib/site-status'
import { StatusBadge } from './sites-grid'

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
}
const STAGE_WORD: Record<string, string> = { done: 'Done', in_progress: 'In progress', blocked: 'Blocked', pending: 'Not started' }

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

function Card({ title, children, className }: { title: string; children: React.ReactNode; className?: string }) {
  return (
    <section className={cn('flex flex-col gap-3 rounded-xl border border-border bg-card p-4', className)}>
      <h2 className="text-[14px] font-semibold text-foreground">{title}</h2>
      {children}
    </section>
  )
}

/** One client's folder, opened: their status, their site, and what the site build needs. */
export function SiteDetailView({ d, canAsk }: { d: SiteDetail; canAsk: boolean }) {
  const router = useRouter()
  const [asking, setAsking] = useState(false)
  const [askMsg, setAskMsg] = useState<string | null>(null)
  const live = d.status === 'live'
  const req = d.request

  async function ask() {
    setAsking(true)
    setAskMsg(null)
    try {
      const res = await fetch(`/api/clients/${d.client.id}/hl-number`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'ask' }) })
      const out = (await res.json().catch(() => ({}))) as { ok?: boolean; reason?: string; error?: string }
      setAskMsg(out.ok ? 'Asked in the Office. It’s bought once someone answers Yes there.' : out.reason || out.error || 'Couldn’t ask.')
      router.refresh()
    } finally {
      setAsking(false)
    }
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
        {live && d.client.siteUrl ? (
          <a
            href={siteHref(d.client.siteUrl)}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 rounded-lg border border-foreground/20 bg-foreground px-4 py-2 text-[13px] font-medium text-background transition hover:opacity-90"
          >
            <ExternalLink className="h-4 w-4" /> Open website
          </a>
        ) : (
          <Link href={`/clients?focus=${d.client.id}`} className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-card px-4 py-2 text-[13px] font-medium text-foreground transition hover:bg-muted">
            Add the site link on Clients
          </Link>
        )}
      </header>

      <div className="grid gap-5 lg:grid-cols-[1.1fr_1fr]">
        <Card title="Toll-free number for the site">
          {d.number ? (
            <>
              <div className="flex flex-wrap items-center gap-3">
                <span className="text-[26px] font-semibold tabular-nums tracking-tight text-foreground">{pretty(d.number.number)}</span>
                <CopyButton value={pretty(d.number.number)} label="the toll-free number" />
              </div>
              <p className="text-[12.5px] text-muted-foreground">Put this number on their site. Leads who call or text it reach the client, and every lead goes through Hell-level’s automations.</p>
              <ul className="flex flex-col gap-1.5 text-[12.5px] text-foreground/90">
                <li className="flex items-center gap-2">
                  <PhoneForwarded className="h-4 w-4 shrink-0 text-muted-foreground" />
                  {d.number.forwardTo ? `Calls ring ${pretty(d.number.forwardTo)}.` : 'Calls aren’t forwarded: every call counts as missed and gets the text-back.'}
                </li>
                <li className="flex items-center gap-2">
                  <MessageSquareShare className="h-4 w-4 shrink-0 text-muted-foreground" />
                  {d.number.forwardTextsTo ? `Texts are forwarded to ${pretty(d.number.forwardTextsTo)}.` : 'Texts aren’t forwarded (set it in Hell-level → Settings → Phone Numbers).'}
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
          ) : (
            <>
              <p className="text-[13px] text-foreground/90">
                {req?.status === 'awaiting_approval'
                  ? 'Echo asked in the Office; the number is bought once someone answers Yes.'
                  : req?.status === 'declined'
                    ? 'Someone answered No in the Office.'
                    : req?.status === 'failed'
                      ? `The last try failed${req.detail ? `: ${req.detail}` : '.'}`
                      : 'No toll-free number yet.'}
              </p>
              <div className="flex flex-wrap items-center gap-2">
                {req?.status === 'awaiting_approval' ? (
                  <Link href="/office" className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-card px-3 py-1.5 text-[12.5px] font-medium hover:bg-muted">
                    Answer it in the Office
                  </Link>
                ) : canAsk ? (
                  <button
                    type="button"
                    onClick={ask}
                    disabled={asking || !d.account}
                    title={!d.account ? 'This client has no Hell-level sub-account' : undefined}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-foreground/20 bg-foreground px-3 py-1.5 text-[12.5px] font-medium text-background transition hover:opacity-90 disabled:opacity-50"
                  >
                    {asking && <Loader2 className="h-3.5 w-3.5 animate-spin" />} Ask in the Office
                  </button>
                ) : null}
              </div>
              {askMsg && <p className="text-[12px] text-muted-foreground">{askMsg}</p>}
            </>
          )}
        </Card>

        <Card title="Status">
          <ul className="flex flex-col divide-y divide-border">
            {d.journey.map((s) => (
              <li key={s.stage} className="flex items-start justify-between gap-3 py-2 first:pt-0 last:pb-0">
                <span className="min-w-0">
                  <span className="text-[13px] font-medium text-foreground">{s.label}</span>
                  {s.note && <span className="block truncate text-[11.5px] text-muted-foreground" title={s.note}>{s.note}</span>}
                </span>
                <span className={cn('shrink-0 rounded-full px-2 py-0.5 text-[11px] font-semibold', STAGE_STYLE[s.status] ?? STAGE_STYLE.pending)}>{STAGE_WORD[s.status] ?? s.status}</span>
              </li>
            ))}
          </ul>
        </Card>
      </div>

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
