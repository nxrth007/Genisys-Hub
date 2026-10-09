'use client'

import { useEffect, useState, useSyncExternalStore } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  AlertCircle,
  ArrowDown,
  ArrowUp,
  Bot,
  Building2,
  Check,
  CircleCheck,
  Copy,
  ExternalLink,
  Loader2,
  Lock,
  Search,
  User,
  X,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import type { SeoOverviewResponse, SeoRunSummary } from '@/lib/seo/api-types'
import type {
  FindingSeverity,
  FoundationStatus,
  PlanItem,
  RunKind,
  RunStage,
  RunStatus,
  SeoMode,
  SitePlatform,
} from '@/lib/seo/types'

/**
 * Shared pieces for the /seo pages: the fetch helper and query keys, the
 * formatters, and the small presentational parts (status pills, score
 * figures, the sparkline, the repo picker). Kept local to the section so
 * SEO can change its look without touching Payments or Clients.
 *
 * The palette is deliberately white-on-dark: colour only shows up where it
 * carries meaning (failed, needs you, went up/down), never as decoration.
 */

// ---------------------------------------------------------------------------
// Data
// ---------------------------------------------------------------------------

export const seoKeys = {
  overview: ['seo-overview'] as const,
  site: (id: string) => ['seo-site', id] as const,
  run: (id: string) => ['seo-run', id] as const,
  repos: ['seo-github-repos'] as const,
}

/**
 * JSON fetch against /api/seo/*. Errors come back as `{ error }` with a
 * non-2xx status; anything else unexpected (an HTML 404 while a route is
 * missing, a proxy error page) still turns into a readable message.
 */
export async function seoFetch<T>(
  url: string,
  opts: { method?: 'GET' | 'POST' | 'PATCH' | 'DELETE'; body?: unknown; signal?: AbortSignal } = {},
): Promise<T> {
  const hasBody = opts.body !== undefined
  const res = await fetch(url, {
    method: opts.method ?? 'GET',
    headers: hasBody ? { 'Content-Type': 'application/json' } : undefined,
    body: hasBody ? JSON.stringify(opts.body) : undefined,
    cache: 'no-store',
    signal: opts.signal,
  })
  const data: unknown = await res.json().catch(() => null)
  if (!res.ok) {
    const d = (data && typeof data === 'object' ? data : {}) as { error?: unknown; message?: unknown }
    const msg =
      (typeof d.error === 'string' && d.error) ||
      (typeof d.message === 'string' && d.message) ||
      (res.status === 403 ? 'You don’t have access to SEO.' : `Request failed (${res.status}).`)
    throw new Error(msg)
  }
  if (data === null) throw new Error('The server sent an empty response.')
  return data as T
}

export const enc = encodeURIComponent

/** One fetcher for the overview so every page sharing its cache entry agrees on it. */
export function fetchOverview({ signal }: { signal?: AbortSignal }): Promise<SeoOverviewResponse> {
  return seoFetch<SeoOverviewResponse>('/api/seo/overview', { signal })
}

/** Statuses the engine moves on its own — pages poll while a run is in one. */
const MOVING: ReadonlySet<string> = new Set<RunStatus>(['queued', 'running', 'awaiting_ci'])
/** Statuses that wait on a person. */
const NEEDS_YOU: ReadonlySet<string> = new Set<RunStatus>(['awaiting_review', 'awaiting_publish', 'failed'])

export function isMoving(status: string | null | undefined): boolean {
  return !!status && MOVING.has(status)
}

/** Parked on a person. A merge the Hub is publishing in Lovable itself isn't. */
export function needsYou(run: { status: string; hubPublishing?: boolean } | null | undefined): boolean {
  return !!run && NEEDS_YOU.has(run.status) && !run.hubPublishing
}

/**
 * Refetch interval for a page showing runs in these statuses: `movingMs`
 * while the engine is moving one, every 30s while one waits to be
 * published (the engine's live-site check can finish it on its own, and a
 * "Mark as published" may hand it back to waiting), otherwise no polling.
 */
export function pollEvery(statuses: (string | null | undefined)[], movingMs: number): number | false {
  if (statuses.some(isMoving)) return movingMs
  if (statuses.some((s) => s === 'awaiting_publish')) return 30_000
  return false
}

/** Start a weekly or foundation run for a site. Callers handle their own notices. */
export function useStartRun() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ siteId, kind }: { siteId: string; kind: RunKind }) =>
      seoFetch<{ run: SeoRunSummary }>(`/api/seo/sites/${enc(siteId)}/run`, {
        method: 'POST',
        body: { kind },
      }),
    onSuccess: (_d, v) => {
      qc.invalidateQueries({ queryKey: seoKeys.overview })
      qc.invalidateQueries({ queryKey: seoKeys.site(v.siteId) })
    },
  })
}

type RepoRow = { fullName: string; private: boolean; pushedAt: string | null }

/** Repos the GitHub token can see — for the pickers. Cached for five minutes. */
export function useGithubRepos() {
  return useQuery<RepoRow[]>({
    queryKey: seoKeys.repos,
    queryFn: async ({ signal }) => {
      const d = await seoFetch<{ repos?: RepoRow[]; error?: string }>('/api/seo/github/repos', { signal })
      if (typeof d.error === 'string' && d.error) throw new Error(d.error)
      return Array.isArray(d.repos) ? d.repos.filter((r) => r && typeof r.fullName === 'string') : []
    },
    staleTime: 5 * 60_000,
    retry: false,
  })
}

/**
 * The repo a site probably lives in, from its live URL: Lovable publishes
 * a project at <slug>.lovable.app and the GitHub sync names the repo after
 * the same slug (web-craft-wins.lovable.app → nxrth007/web-craft-wins).
 */
export function suggestRepo(liveUrl: string | null | undefined, repos: RepoRow[]): string | null {
  if (!liveUrl) return null
  let host: string
  try {
    host = new URL(/^https?:\/\//i.test(liveUrl) ? liveUrl : `https://${liveUrl}`).hostname.toLowerCase()
  } catch {
    return null
  }
  const label = host.replace(/^www\./, '').split('.')[0]
  if (!label) return null
  const hit = repos.find((r) => r.fullName.split('/')[1]?.toLowerCase() === label)
  return hit?.fullName ?? null
}

// ---------------------------------------------------------------------------
// Time — a shared clock so relative times ("4m ago") stay pure in render
// ---------------------------------------------------------------------------

const NOW_TICK_MS = 15_000
let nowMs = 0
let nowTimer: ReturnType<typeof setInterval> | null = null
const nowListeners = new Set<() => void>()

function subscribeNow(onChange: () => void) {
  nowListeners.add(onChange)
  if (nowTimer === null) {
    nowMs = Date.now()
    nowTimer = setInterval(() => {
      nowMs = Date.now()
      nowListeners.forEach((l) => l())
    }, NOW_TICK_MS)
  }
  return () => {
    nowListeners.delete(onChange)
    if (nowListeners.size === 0 && nowTimer !== null) {
      clearInterval(nowTimer)
      nowTimer = null
    }
  }
}
const readNow = () => nowMs
const serverNow = () => 0

/** Epoch ms, refreshed every 15s. 0 on the server — formatters fall back to dates. */
export function useNow(): number {
  return useSyncExternalStore(subscribeNow, readNow, serverNow)
}

function parseWhen(iso: string | null | undefined): Date | null {
  if (!iso) return null
  // A bare YYYY-MM-DD is a calendar day, not UTC midnight — parsing it as
  // UTC would show Sunday's week as "Sat" everywhere west of London.
  const day = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso)
  const d = day ? new Date(Number(day[1]), Number(day[2]) - 1, Number(day[3])) : new Date(iso)
  return Number.isNaN(d.getTime()) ? null : d
}

export function fromIso(iso: string | null | undefined): string {
  const d = parseWhen(iso)
  return d
    ? d.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
    : '—'
}

export function dayLabel(iso: string | null | undefined, withYear = false): string {
  const d = parseWhen(iso)
  return d
    ? d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', ...(withYear ? { year: 'numeric' } : {}) })
    : '—'
}

const ISO_WEEK = /^(\d{4})-W(\d{1,2})\b/i
const MANUAL_WEEK = /-m[0-9a-z]+$/i

/**
 * A run's week, from its `weekOf` — an ISO week label, not a date:
 * "2026-W40" → "Week 40, 2026". Manual runs carry a "-m<base36>" suffix
 * so several can share a week; they read "Week 40, 2026 · manual" unless
 * `markManual` is off (where the row already says "manual" elsewhere).
 * Never falls back to a dash — an unexpected value is shown as it is.
 */
export function weekLabel(weekOf: string | null | undefined, { markManual = true }: { markManual?: boolean } = {}): string {
  const raw = (weekOf ?? '').trim()
  const m = ISO_WEEK.exec(raw)
  if (m) {
    const label = `Week ${Number(m[2])}, ${m[1]}`
    return markManual && MANUAL_WEEK.test(raw) ? `${label} · manual` : label
  }
  if (/^\d{4}-\d{2}-\d{2}/.test(raw) && parseWhen(raw)) return `Week of ${dayLabel(raw, true)}`
  return raw || 'Unknown week'
}

export function timeAgo(iso: string | null | undefined, now: number): string {
  const d = parseWhen(iso)
  if (!d) return '—'
  if (!now) return dayLabel(iso)
  const s = Math.round((now - d.getTime()) / 1000)
  if (s < 45) return 'just now'
  const m = Math.round(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.round(m / 60)
  if (h < 24) return `${h}h ago`
  const days = Math.round(h / 24)
  if (days < 7) return `${days}d ago`
  return dayLabel(iso)
}

export function timeUntil(iso: string | null | undefined, now: number): string | null {
  const d = parseWhen(iso)
  if (!d || !now) return null
  const m = Math.round((d.getTime() - now) / 60_000)
  if (m <= 0) return 'due now'
  if (m < 60) return `in ${m}m`
  const h = Math.floor(m / 60)
  if (h < 48) return `in ${h}h ${m % 60}m`
  return `in ${Math.floor(h / 24)}d ${h % 24}h`
}

/** "4m 12s" between two instants; `end` null means "until now". */
export function elapsed(startIso: string | null | undefined, endIso: string | null | undefined, now: number): string | null {
  const a = parseWhen(startIso)
  const b = endIso ? parseWhen(endIso) : now ? new Date(now) : null
  if (!a || !b) return null
  const s = Math.max(0, Math.round((b.getTime() - a.getTime()) / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${s % 60}s`
  return `${Math.floor(m / 60)}h ${m % 60}m`
}

/** A date-time in a named IANA zone, falling back to local time if the zone is bogus. */
export function inZone(iso: string | null | undefined, timeZone: string): string {
  const d = parseWhen(iso)
  if (!d) return '—'
  const opts: Intl.DateTimeFormatOptions = {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
  }
  try {
    return d.toLocaleString('en-US', { ...opts, timeZone })
  } catch {
    return d.toLocaleString('en-US', opts)
  }
}

// ---------------------------------------------------------------------------
// Numbers and URLs
// ---------------------------------------------------------------------------

const usdFmt = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
})

export function usd(n: number | null | undefined): string {
  return typeof n === 'number' && Number.isFinite(n) ? usdFmt.format(n) : '—'
}

export function num(n: number | null | undefined, digits = 0): string {
  return typeof n === 'number' && Number.isFinite(n)
    ? n.toLocaleString('en-US', { maximumFractionDigits: digits, minimumFractionDigits: 0 })
    : '—'
}

/** Lighthouse scores arrive as 0–1; tolerate an API that already scaled them. */
export function score100(v: number | null | undefined): number | null {
  if (typeof v !== 'number' || !Number.isFinite(v)) return null
  return Math.round(v <= 1 ? v * 100 : v)
}

export function hostOf(url: string | null | undefined): string {
  if (!url) return ''
  try {
    return new URL(url).host.replace(/^www\./, '')
  } catch {
    return url
  }
}

/** Path + query of a URL, for tables where the host is the same on every row. */
export function pathOf(url: string | null | undefined): string {
  if (!url) return ''
  try {
    const u = new URL(url)
    return `${u.pathname}${u.search}` || '/'
  } catch {
    return url
  }
}

/** Normalise what a person pastes as a site address. Null when it isn't one. */
export function normalizeUrl(raw: string): string | null {
  const t = raw.trim()
  if (!t) return null
  try {
    const u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(t) ? t : `https://${t}`)
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null
    if (!u.hostname.includes('.')) return null
    u.hash = ''
    // Same shape the API stores (no trailing slash), so comparisons hold.
    return u.toString().replace(/\/$/, '')
  } catch {
    return null
  }
}

/** Short, stable content hash — used to remount a form when the server copy changes. */
export function hashString(s: string): string {
  let h = 5381
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0
  return (h >>> 0).toString(36)
}

export function githubUrl(fullName: string, ...rest: string[]): string {
  const tail = rest.flatMap((p) => p.split('/')).map(enc).join('/')
  return `https://github.com/${fullName}${tail ? `/${tail}` : ''}`
}

export function lovableUrl(projectId: string): string {
  return `https://lovable.dev/projects/${enc(projectId)}`
}

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

export const MODES: { value: SeoMode; label: string; blurb: string }[] = [
  {
    value: 'audit',
    label: 'Audit',
    blurb: 'Audit, plan and draft only. Nothing is committed — for GoHighLevel sites, or before a repo is linked.',
  },
  {
    value: 'review',
    label: 'Review',
    blurb: 'Commits to a branch and opens a pull request. A person approves it here before anything ships.',
  },
  {
    value: 'autopilot',
    label: 'Autopilot',
    blurb: 'Merges and publishes on its own when every content check and the build pass.',
  },
]

export const PLATFORM_LABEL: Record<SitePlatform, string> = {
  'lovable-tanstack': 'Lovable · TanStack',
  'lovable-spa': 'Lovable · SPA',
  ghl: 'GoHighLevel',
  other: 'Other',
  unknown: 'Unknown',
}

export function platformLabel(p: string | null | undefined): string {
  return (p && PLATFORM_LABEL[p as SitePlatform]) || 'Unknown'
}

export const STAGES: RunStage[] = ['collect', 'research', 'plan', 'write', 'commit', 'ship', 'verify', 'report']

export const STAGE_LABEL: Record<RunStage, string> = {
  collect: 'Collect',
  research: 'Research',
  plan: 'Plan',
  write: 'Write',
  commit: 'Commit',
  ship: 'Ship',
  verify: 'Verify',
  report: 'Report',
  done: 'Done',
}

export const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

export function hourLabel(h: number): string {
  const n = ((Math.round(h) % 24) + 24) % 24
  return `${n % 12 === 0 ? 12 : n % 12} ${n < 12 ? 'AM' : 'PM'}`
}

export const SEVERITY_ORDER: Record<FindingSeverity, number> = { P0: 0, P1: 1, P2: 2 }

export const SEVERITY_LABEL: Record<FindingSeverity, string> = {
  P0: 'Critical',
  P1: 'Important',
  P2: 'Polish',
}

// ---------------------------------------------------------------------------
// Buttons, fields, tables
// ---------------------------------------------------------------------------

export const btnPrimary =
  'inline-flex h-9 items-center justify-center gap-1.5 rounded-lg bg-foreground px-3.5 text-[13px] font-medium text-primary-foreground transition hover:bg-foreground/90 disabled:cursor-not-allowed disabled:opacity-50'

export const btnSecondary =
  'inline-flex h-9 items-center justify-center gap-1.5 rounded-lg border border-border bg-card px-3.5 text-[13px] font-medium text-foreground transition hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50'

export const btnDanger =
  'inline-flex h-9 items-center justify-center gap-1.5 rounded-lg border border-destructive/40 bg-card px-3.5 text-[13px] font-medium text-destructive transition hover:bg-destructive/10 disabled:cursor-not-allowed disabled:opacity-50'

export const btnSmall =
  'inline-flex h-7 items-center justify-center gap-1.5 rounded-md border border-border bg-card px-2.5 text-[12px] font-medium text-muted-foreground transition hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40'

export const btnGhost =
  'inline-flex h-9 items-center justify-center gap-1.5 rounded-lg px-3 text-[13px] font-medium text-muted-foreground transition hover:bg-muted hover:text-foreground disabled:opacity-50'

export const fieldClass =
  'w-full rounded-lg border border-border bg-surface px-3 py-2 text-[13px] text-foreground transition placeholder:text-muted-foreground/60 focus:border-foreground/30 focus:outline-none focus:ring-1 focus:ring-foreground/15 disabled:opacity-60'

export const thClass = 'px-3 py-2.5 font-medium'
export const tdClass = 'px-3 py-2.5'

export function Table({
  head,
  children,
  minWidth,
}: {
  head: React.ReactNode
  children: React.ReactNode
  /** Tailwind min-width class so wide tables scroll instead of crushing. */
  minWidth?: string
}) {
  return (
    <div className="overflow-x-auto rounded-xl border border-border">
      <table className={cn('w-full text-[13px]', minWidth)}>
        <thead className="eyebrow bg-surface-muted text-left text-muted-foreground">
          <tr>{head}</tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  )
}

export function ShowMore({ shown, total, onMore }: { shown: number; total: number; onMore: () => void }) {
  if (shown >= total) return null
  return (
    <button
      type="button"
      onClick={onMore}
      className="mt-2 w-full rounded-lg border border-border py-1.5 text-[12px] font-medium text-muted-foreground transition hover:bg-muted hover:text-foreground"
    >
      Show more ({total - shown} left)
    </button>
  )
}

// ---------------------------------------------------------------------------
// Layout blocks
// ---------------------------------------------------------------------------

export function Card({
  title,
  hint,
  actions,
  children,
  className,
  bodyClassName,
}: {
  title?: React.ReactNode
  hint?: React.ReactNode
  actions?: React.ReactNode
  children: React.ReactNode
  className?: string
  bodyClassName?: string
}) {
  return (
    <section className={cn('rounded-xl border border-border bg-card', className)}>
      {(title || actions) && (
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border-soft px-4 py-3">
          <div className="flex min-w-0 items-baseline gap-3">
            {title && <h2 className="eyebrow text-muted-foreground">{title}</h2>}
            {hint && <span className="truncate font-mono text-[11px] text-muted-foreground/70">{hint}</span>}
          </div>
          {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
        </div>
      )}
      <div className={cn('p-4', bodyClassName)}>{children}</div>
    </section>
  )
}

export function StatTile({
  label,
  value,
  sub,
  extra,
}: {
  label: string
  value: React.ReactNode
  sub?: React.ReactNode
  extra?: React.ReactNode
}) {
  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <p className="eyebrow text-muted-foreground">{label}</p>
      <div className="mt-2.5 flex items-baseline gap-2">
        <span className="font-mono text-[26px] font-medium leading-none tracking-tight tabular-nums">{value}</span>
        {extra}
      </div>
      {sub && <p className="mt-2 text-xs text-muted-foreground">{sub}</p>}
    </div>
  )
}

export function Empty({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={cn('rounded-xl border border-dashed border-border p-6 text-center text-[13px] text-muted-foreground', className)}>
      {children}
    </div>
  )
}

export function LoadingBlock({ label = 'Loading…' }: { label?: string }) {
  return (
    <div className="flex h-40 items-center justify-center text-[13px] text-muted-foreground">
      <Loader2 className="mr-2 h-4 w-4 animate-spin" /> {label}
    </div>
  )
}

export function ErrorBlock({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="flex items-start gap-2 rounded-xl border border-destructive/30 bg-destructive/10 p-4 text-[13px] text-destructive">
      <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
      <span className="flex-1">{message}</span>
      {onRetry && (
        <button type="button" onClick={onRetry} className="text-[12px] font-medium underline underline-offset-2 hover:no-underline">
          Try again
        </button>
      )}
    </div>
  )
}

export type NoticeState = { tone: 'ok' | 'err'; text: React.ReactNode } | null

/** Inline result of an action — the Hub has no toasts. */
export function Notice({ notice, onClose }: { notice: NoticeState; onClose: () => void }) {
  if (!notice) return null
  return (
    <div
      role={notice.tone === 'err' ? 'alert' : 'status'}
      className={cn(
        'flex items-start gap-2 rounded-xl border p-3 text-[13px]',
        notice.tone === 'ok'
          ? 'border-border bg-surface text-foreground'
          : 'border-destructive/30 bg-destructive/10 text-destructive',
      )}
    >
      {notice.tone === 'ok' ? (
        <CircleCheck className="mt-0.5 h-4 w-4 shrink-0 text-success" />
      ) : (
        <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
      )}
      <span className="flex-1">{notice.text}</span>
      <button type="button" onClick={onClose} className="opacity-60 hover:opacity-100" aria-label="Dismiss">
        <X className="h-4 w-4" />
      </button>
    </div>
  )
}

/** Modal shell matching the Clients dialogs. Escape closes unless `busy`. */
export function Modal({
  title,
  subtitle,
  onClose,
  busy,
  children,
  footer,
  width = 'max-w-2xl',
}: {
  title: string
  subtitle?: React.ReactNode
  onClose: () => void
  busy?: boolean
  children: React.ReactNode
  footer?: React.ReactNode
  width?: string
}) {
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape' && !busy) onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [busy, onClose])

  return (
    // Backdrop doesn't close on click: a half-filled form lost to a stray
    // click costs more than the convenience.
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/60 p-4 pt-[6vh] backdrop-blur-sm">
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={cn(
          'flex w-full flex-col gap-5 rounded-xl border border-border bg-popover p-6 text-popover-foreground shadow-pop',
          width,
        )}
      >
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="text-lg font-semibold tracking-tight">{title}</h2>
            {subtitle && <p className="mt-1 text-[13px] text-muted-foreground">{subtitle}</p>}
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="grid h-7 w-7 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-40"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        {children}
        {footer && <div className="flex flex-wrap justify-end gap-2 border-t border-border-soft pt-4">{footer}</div>}
      </div>
    </div>
  )
}

/**
 * Labelled form row. A <label> by default so clicking the caption focuses
 * the input; pass `group` for controls made of several buttons (a label
 * would forward every caption click to the first button).
 */
export function Field({
  label,
  hint,
  children,
  className,
  group,
  badge,
}: {
  label: string
  hint?: React.ReactNode
  children: React.ReactNode
  className?: string
  group?: boolean
  /** Shown beside the label — e.g. where a business fact came from. */
  badge?: React.ReactNode
}) {
  const Tag = group ? 'div' : 'label'
  return (
    <Tag className={cn('flex min-w-0 flex-col gap-1.5', className)}>
      <span className="flex flex-wrap items-center gap-1.5">
        <span className="eyebrow text-muted-foreground">{label}</span>
        {badge}
      </span>
      {children}
      {hint && <span className="text-[11.5px] leading-snug text-muted-foreground/80">{hint}</span>}
    </Tag>
  )
}

/** Small segmented control; the active option is filled white. */
export function Segmented<T extends string | number>({
  value,
  options,
  onChange,
  disabled,
  size = 'md',
}: {
  value: T
  options: { value: T; label: string; disabled?: boolean; title?: string }[]
  onChange: (v: T) => void
  disabled?: boolean
  size?: 'sm' | 'md'
}) {
  return (
    <div
      role="radiogroup"
      className={cn('inline-flex w-fit max-w-full flex-wrap rounded-lg border border-border bg-surface p-0.5', disabled && 'opacity-60')}
    >
      {options.map((o) => {
        const active = o.value === value
        return (
          <button
            key={String(o.value)}
            type="button"
            role="radio"
            aria-checked={active}
            title={o.title}
            disabled={disabled || o.disabled}
            onClick={() => !active && onChange(o.value)}
            className={cn(
              'rounded-md font-medium transition disabled:cursor-not-allowed',
              size === 'sm' ? 'px-2 py-0.5 text-[11.5px]' : 'px-3 py-1 text-[12.5px]',
              active
                ? 'bg-foreground text-background'
                : 'text-muted-foreground hover:text-foreground disabled:hover:text-muted-foreground disabled:opacity-40',
            )}
          >
            {o.label}
          </button>
        )
      })}
    </div>
  )
}

/** Underline tabs, as on Payments, with an optional count per tab. */
export function Tabs<K extends string>({
  tabs,
  value,
  onChange,
}: {
  tabs: { key: K; label: string; icon: React.ComponentType<{ className?: string }>; count?: number | null; alert?: boolean }[]
  value: K
  onChange: (key: K) => void
}) {
  return (
    // The scroller sits inside the bordered wrapper so a narrow screen can
    // swipe the tabs without a stray vertical scrollbar from the underline.
    <div className="border-b border-border">
      <div role="tablist" className="flex gap-1 overflow-x-auto [scrollbar-width:none]">
        {tabs.map((t) => {
          const Icon = t.icon
          const active = t.key === value
          return (
            <button
              key={t.key}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => onChange(t.key)}
              className={cn(
                'flex shrink-0 items-center gap-2 border-b-2 px-4 py-2.5 text-sm font-medium transition',
                active ? 'border-foreground text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground',
              )}
            >
              <Icon className="h-4 w-4" />
              {t.label}
              {typeof t.count === 'number' && t.count > 0 && (
                <span
                  className={cn(
                    'rounded px-1.5 font-mono text-[10.5px] tabular-nums',
                    t.alert ? 'bg-destructive/15 text-destructive' : 'bg-muted text-muted-foreground',
                  )}
                >
                  {t.count}
                </span>
              )}
            </button>
          )
        })}
      </div>
    </div>
  )
}

/** On/off switch — white when on. */
export function Switch({
  on,
  onChange,
  busy,
  label,
}: {
  on: boolean
  onChange: (next: boolean) => void
  busy?: boolean
  label: string
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      disabled={busy}
      onClick={() => onChange(!on)}
      className={cn(
        'relative inline-flex h-5 w-9 shrink-0 items-center rounded-full border transition disabled:opacity-50',
        on ? 'border-foreground bg-foreground' : 'border-border bg-surface-muted',
      )}
    >
      <span
        className={cn(
          'inline-block h-3.5 w-3.5 rounded-full transition-transform',
          on ? 'translate-x-[18px] bg-background' : 'translate-x-[2px] bg-muted-foreground',
        )}
      />
    </button>
  )
}

// ---------------------------------------------------------------------------
// Pills and chips
// ---------------------------------------------------------------------------

type Tone = 'neutral' | 'active' | 'good' | 'attention' | 'bad' | 'muted'

const DOT: Record<Tone, string> = {
  neutral: 'bg-foreground/70',
  active: 'bg-foreground',
  good: 'bg-success',
  attention: 'bg-warning',
  bad: 'bg-destructive',
  muted: 'bg-muted-foreground/50',
}

/** A mono label with a status dot — the colour is the dot, never the text. */
export function DotPill({
  label,
  tone = 'neutral',
  pulse,
  title,
}: {
  label: string
  tone?: Tone
  pulse?: boolean
  title?: string
}) {
  return (
    <span
      title={title}
      className="eyebrow inline-flex items-center gap-1.5 whitespace-nowrap rounded-md border border-border bg-surface px-2 py-0.5 text-foreground/85"
    >
      <span className={cn('h-1.5 w-1.5 shrink-0 rounded-full', DOT[tone], pulse && 'animate-pulse')} />
      {label}
    </span>
  )
}

const RUN_STATUS: Record<RunStatus, { label: string; tone: Tone; pulse?: boolean }> = {
  queued: { label: 'Queued', tone: 'muted' },
  running: { label: 'Running', tone: 'active', pulse: true },
  awaiting_review: { label: 'Needs review', tone: 'attention' },
  awaiting_ci: { label: 'Checking build', tone: 'active', pulse: true },
  awaiting_publish: { label: 'Ready to publish', tone: 'attention' },
  done: { label: 'Done', tone: 'good' },
  failed: { label: 'Failed', tone: 'bad' },
  canceled: { label: 'Canceled', tone: 'muted' },
}

export function runStatusLabel(status: string | null | undefined): string {
  if (!status) return '—'
  return RUN_STATUS[status as RunStatus]?.label ?? status.replace(/_/g, ' ')
}

/** `hubPublishing`: merged, and the Hub is publishing it in Lovable — not waiting on anyone. */
export function RunStatusPill({ status, hubPublishing }: { status: string | null | undefined; hubPublishing?: boolean }) {
  if (!status) return <span className="text-muted-foreground">—</span>
  if (status === 'awaiting_publish' && hubPublishing) return <DotPill label="Publishing" tone="active" pulse />
  const s = RUN_STATUS[status as RunStatus]
  return <DotPill label={s?.label ?? status.replace(/_/g, ' ')} tone={s?.tone ?? 'muted'} pulse={s?.pulse} />
}

export function PostStatusPill({ status }: { status: string }) {
  const tone: Tone = status === 'live' ? 'good' : status === 'rejected' ? 'bad' : status === 'committed' ? 'active' : 'muted'
  return <DotPill label={status} tone={tone} />
}

/** CI / check status as GitHub reports it (success, failure, in_progress, …). */
export function CiPill({ status }: { status: string | null | undefined }) {
  if (!status) return <span className="text-muted-foreground">—</span>
  const s = status.toLowerCase()
  const tone: Tone =
    s.includes('success') || s === 'passed' || s === 'completed'
      ? 'good'
      : s.includes('fail') || s.includes('error') || s.includes('cancel') || s === 'timed_out'
        ? 'bad'
        : s === 'none' || s === 'skipped' || s === 'neutral'
          ? 'muted'
          : 'active'
  return <DotPill label={status.replace(/_/g, ' ')} tone={tone} pulse={tone === 'active'} />
}

export function ModeChip({ mode }: { mode: string }) {
  const m = MODES.find((x) => x.value === mode)
  return (
    <span
      title={m?.blurb}
      className={cn(
        'eyebrow inline-flex items-center rounded-md px-2 py-0.5',
        mode === 'autopilot'
          ? 'bg-foreground text-background'
          : mode === 'review'
            ? 'border border-foreground/30 text-foreground'
            : 'bg-muted text-muted-foreground',
      )}
    >
      {m?.label ?? mode}
    </span>
  )
}

export function FoundationBadge({ status }: { status: FoundationStatus | string }) {
  if (status === 'installed') {
    return (
      <span className="inline-flex items-center gap-1 text-[12px] text-foreground/85">
        <Check className="h-3.5 w-3.5" /> Installed
      </span>
    )
  }
  if (status === 'proposed') return <DotPill label="PR open" tone="attention" />
  return <span className="text-[12px] text-muted-foreground">Not installed</span>
}

export function SeverityChip({ severity }: { severity: FindingSeverity | string }) {
  return (
    <span
      title={SEVERITY_LABEL[severity as FindingSeverity]}
      className={cn(
        'eyebrow inline-flex shrink-0 items-center rounded-md px-1.5 py-0.5',
        severity === 'P0'
          ? 'bg-destructive/15 text-destructive'
          : severity === 'P1'
            ? 'bg-warning/15 text-warning'
            : 'bg-muted text-muted-foreground',
      )}
    >
      {severity}
    </span>
  )
}

const OWNER: Record<PlanItem['owner'], { label: string; icon: React.ComponentType<{ className?: string }>; title: string }> = {
  engine: { label: 'Engine', icon: Bot, title: 'The SEO engine does this itself' },
  genisys: { label: 'Genisys', icon: Building2, title: 'Someone at Genisys does this' },
  client: { label: 'Client', icon: User, title: 'Needs the client — their input or their accounts' },
}

export function OwnerChip({ owner }: { owner: PlanItem['owner'] | string }) {
  const o = OWNER[owner as PlanItem['owner']]
  if (!o) return <span className="eyebrow text-muted-foreground">{owner}</span>
  const Icon = o.icon
  return (
    <span
      title={o.title}
      className={cn(
        'eyebrow inline-flex shrink-0 items-center gap-1 rounded-md border px-1.5 py-0.5',
        owner === 'client' ? 'border-foreground/30 text-foreground' : 'border-border text-muted-foreground',
      )}
    >
      <Icon className="h-3 w-3" />
      {o.label}
    </span>
  )
}

// ---------------------------------------------------------------------------
// Scores
// ---------------------------------------------------------------------------

/** Signed change; the arrow carries direction so it never rests on colour alone. */
export function Delta({
  value,
  higherIsBetter = true,
  digits = 0,
  suffix = '',
}: {
  value: number | null | undefined
  higherIsBetter?: boolean
  digits?: number
  suffix?: string
}) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  const factor = 10 ** digits
  const r = Math.round(value * factor) / factor
  if (r === 0) return <span className="font-mono text-[11px] text-muted-foreground">±0{suffix}</span>
  const good = r > 0 === higherIsBetter
  const Icon = r > 0 ? ArrowUp : ArrowDown
  return (
    <span
      className={cn(
        'inline-flex items-center gap-0.5 font-mono text-[11px] tabular-nums',
        good ? 'text-success' : 'text-destructive',
      )}
    >
      <Icon className="h-3 w-3" />
      {Math.abs(r).toFixed(digits)}
      {suffix}
    </span>
  )
}

export function ScoreNumber({
  score,
  className,
}: {
  score: number | null | undefined
  className?: string
}) {
  const has = typeof score === 'number' && Number.isFinite(score)
  return (
    <span
      className={cn(
        'font-mono font-medium leading-none tracking-tight tabular-nums',
        has ? 'text-foreground' : 'text-muted-foreground/60',
        className,
      )}
    >
      {has ? Math.round(score as number) : '—'}
    </span>
  )
}

/** A thin 0–100 track; the fill carries severity. */
export function Meter({ value }: { value: number | null }) {
  const v = value === null ? 0 : Math.max(0, Math.min(100, value))
  return (
    <div className="h-1 w-full overflow-hidden rounded-full bg-muted">
      <div
        className={cn(
          'h-full rounded-full',
          value === null ? 'bg-transparent' : v >= 90 ? 'bg-success' : v >= 50 ? 'bg-warning' : 'bg-destructive',
        )}
        style={{ width: `${v}%` }}
      />
    </div>
  )
}

/**
 * Score trend: one series, so no legend — the card title names it. The
 * y-window is at least 20 points wide so a one-point wobble doesn't read
 * as a cliff. The line is drawn in SVG (non-scaling stroke, stretches to
 * any width); dots and the hover readout are HTML so they stay round.
 */
export function Sparkline({
  points,
  height = 64,
}: {
  points: { value: number; label: string }[]
  height?: number
}) {
  const [hover, setHover] = useState<number | null>(null)
  if (points.length === 0) return null

  const W = 300
  const H = height
  const padY = 8
  const vals = points.map((p) => p.value)
  const lo0 = Math.min(...vals)
  const hi0 = Math.max(...vals)
  const span = Math.min(100, Math.max(20, hi0 - lo0 + 8))
  const lo = Math.max(0, Math.min(100 - span, (lo0 + hi0) / 2 - span / 2))
  const hi = lo + span
  const xAt = (i: number) => (points.length === 1 ? W / 2 : (i / (points.length - 1)) * W)
  const yAt = (v: number) => padY + ((hi - v) / (hi - lo)) * (H - 2 * padY)
  const line = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${xAt(i).toFixed(2)},${yAt(p.value).toFixed(2)}`).join(' ')
  const area = `${line} L${xAt(points.length - 1).toFixed(2)},${H} L${xAt(0).toFixed(2)},${H} Z`
  const last = points.length - 1
  const shown = hover ?? last
  const pct = (i: number) => (xAt(i) / W) * 100
  const topPct = (v: number) => (yAt(v) / H) * 100

  return (
    <div
      className="relative w-full select-none"
      style={{ height: H }}
      role="img"
      aria-label={`Score trend over ${points.length} run${points.length === 1 ? '' : 's'}: ${points
        .map((p) => Math.round(p.value))
        .join(', ')}`}
      onPointerMove={(e) => {
        if (points.length < 2) return
        const r = e.currentTarget.getBoundingClientRect()
        const f = r.width > 0 ? (e.clientX - r.left) / r.width : 0
        setHover(Math.max(0, Math.min(last, Math.round(f * last))))
      }}
      onPointerLeave={() => setHover(null)}
    >
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="absolute inset-0 h-full w-full overflow-visible">
        <path d={area} className="fill-foreground/[0.05]" />
        <path
          d={line}
          fill="none"
          stroke="currentColor"
          strokeWidth={2}
          strokeLinejoin="round"
          strokeLinecap="round"
          vectorEffect="non-scaling-stroke"
          className="text-foreground/45"
        />
      </svg>
      {hover !== null && (
        <div className="pointer-events-none absolute inset-y-0 w-px bg-foreground/20" style={{ left: `${pct(hover)}%` }} />
      )}
      <span
        className={cn(
          'pointer-events-none absolute h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full ring-2 ring-card',
          hover === null || hover === last ? 'bg-foreground' : 'bg-foreground/80',
        )}
        style={{ left: `${pct(shown)}%`, top: `${topPct(points[shown].value)}%` }}
      />
      {hover !== null && (
        <div
          className="pointer-events-none absolute top-0 z-10 whitespace-nowrap rounded-md border border-border bg-popover px-2 py-1 shadow-pop"
          style={{
            left: `${pct(hover)}%`,
            // Pinned inside the card at the edges instead of hanging off it.
            transform: `translate(${pct(hover) < 15 ? '0' : pct(hover) > 85 ? '-100%' : '-50%'}, calc(-100% - 6px))`,
          }}
        >
          <span className="font-mono text-[12px] font-medium tabular-nums text-foreground">
            {Math.round(points[hover].value)}
          </span>
          <span className="ml-1.5 text-[11px] text-muted-foreground">{points[hover].label}</span>
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Links, copy, inline text
// ---------------------------------------------------------------------------

export function ExtLink({
  href,
  children,
  className,
  title,
}: {
  href: string
  children: React.ReactNode
  className?: string
  title?: string
}) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      title={title}
      onClick={(e) => e.stopPropagation()}
      className={cn(
        'inline-flex min-w-0 items-center gap-1 text-foreground/90 underline decoration-foreground/25 underline-offset-2 transition hover:decoration-foreground',
        className,
      )}
    >
      <span className="truncate">{children}</span>
      <ExternalLink className="h-3 w-3 shrink-0 text-muted-foreground" />
    </a>
  )
}

/** Bordered mono link chip, as the Clients page shows a site link. */
export function LinkChip({
  href,
  icon: Icon,
  children,
  title,
}: {
  href: string
  icon: React.ComponentType<{ className?: string }>
  children: React.ReactNode
  title?: string
}) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      title={title ?? href}
      className="inline-flex max-w-full items-center gap-1.5 rounded-md border border-border bg-surface px-2.5 py-1.5 font-mono text-[12px] text-foreground transition hover:border-foreground/30"
    >
      <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
      <span className="truncate">{children}</span>
      <ExternalLink className="h-3 w-3 shrink-0 text-muted-foreground/70" />
    </a>
  )
}

export async function copyText(value: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value)
      return true
    }
  } catch {
    // Permission denied or an insecure context — try the old way.
  }
  try {
    const ta = document.createElement('textarea')
    ta.value = value
    ta.setAttribute('readonly', '')
    ta.style.position = 'fixed'
    ta.style.opacity = '0'
    document.body.appendChild(ta)
    ta.select()
    const ok = document.execCommand('copy')
    document.body.removeChild(ta)
    return ok
  } catch {
    return false
  }
}

export function CopyButton({ value, label, className }: { value: string; label: string; className?: string }) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle')
  return (
    <button
      type="button"
      disabled={!value}
      onClick={async (e) => {
        e.stopPropagation()
        const ok = await copyText(value)
        setState(ok ? 'copied' : 'failed')
        setTimeout(() => setState('idle'), 1600)
      }}
      className={cn(btnSmall, className)}
    >
      {state === 'copied' ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
      {state === 'copied' ? 'Copied' : state === 'failed' ? 'Copy failed' : label}
    </button>
  )
}

const INLINE_LINK = /\[([^\]\n]{1,300})\]\(([^()\s]{1,2000})(?:\s+"[^"\n]*")?\)/g

/**
 * Where a link in generated copy may point. Site-relative paths resolve
 * against the client's live site (they are links on *their* site, not
 * the Hub); anything that isn't http(s), mailto or tel is dropped.
 */
export function safeLink(raw: string | null | undefined, base?: string | null): string | null {
  if (!raw) return null
  const href = raw.trim()
  if (/^(https?:|mailto:|tel:)/i.test(href)) {
    try {
      const u = new URL(href)
      return ['http:', 'https:', 'mailto:', 'tel:'].includes(u.protocol) ? u.toString() : null
    } catch {
      return null
    }
  }
  if ((href.startsWith('/') && !href.startsWith('//')) || href.startsWith('#')) {
    if (!base) return null
    try {
      return new URL(href, base).toString()
    } catch {
      return null
    }
  }
  return null
}

/**
 * Plain text with `[anchor](href)` links rendered as real anchors. No HTML
 * is ever interpreted — everything else stays text.
 */
export function InlineText({ text, base }: { text: string | null | undefined; base?: string | null }) {
  if (!text) return null
  const out: React.ReactNode[] = []
  let last = 0
  for (const m of text.matchAll(INLINE_LINK)) {
    const at = m.index ?? 0
    if (at > last) out.push(text.slice(last, at))
    const href = safeLink(m[2], base)
    out.push(
      href ? (
        <a
          key={at}
          href={href}
          target="_blank"
          rel="noopener noreferrer nofollow"
          title={m[2]}
          className="text-foreground underline decoration-foreground/35 underline-offset-2 hover:decoration-foreground"
        >
          {m[1]}
        </a>
      ) : (
        <span key={at} title={m[2]} className="underline decoration-dotted decoration-foreground/40 underline-offset-2">
          {m[1]}
        </span>
      ),
    )
    last = at + m[0].length
  }
  if (last < text.length) out.push(text.slice(last))
  return <>{out}</>
}

// ---------------------------------------------------------------------------
// Repo picker
// ---------------------------------------------------------------------------

const FULL_NAME = /^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/

/**
 * Searchable list of the token's repos. Optional by design: "No repo"
 * is always the first row, and if GitHub can't be reached a typed
 * owner/name still works so a missing token never blocks adding a site.
 */
export function RepoPicker({
  value,
  onChange,
  suggested,
  now,
}: {
  value: string | null
  onChange: (fullName: string | null) => void
  suggested?: string | null
  now: number
}) {
  const [query, setQuery] = useState('')
  const repos = useGithubRepos()
  const all = repos.data ?? []
  const needle = query.trim().toLowerCase()
  const matches = all.filter((r) => !needle || r.fullName.toLowerCase().includes(needle))
  // Suggested first, then the API's order (most recently pushed).
  const ordered = suggested
    ? [...matches.filter((r) => r.fullName === suggested), ...matches.filter((r) => r.fullName !== suggested)]
    : matches
  const typed = FULL_NAME.test(query.trim()) && !all.some((r) => r.fullName.toLowerCase() === needle) ? query.trim() : null
  // The current value stays visible even when the list doesn't have it.
  const orphan = value && !all.some((r) => r.fullName === value) && value !== typed ? value : null

  // Enter picks what was typed (an exact name, a typed owner/name, or the
  // only match) instead of submitting whatever form the picker sits in.
  function pickFromQuery() {
    if (!needle) return
    const exact = all.find((r) => r.fullName.toLowerCase() === needle)
    const pick = exact?.fullName ?? typed ?? (ordered.length === 1 ? ordered[0].fullName : null)
    if (pick) onChange(pick)
  }

  const row = (key: string, selected: boolean, onPick: () => void, body: React.ReactNode) => (
    <button
      key={key}
      type="button"
      role="option"
      aria-selected={selected}
      onClick={onPick}
      className={cn(
        'flex w-full items-center gap-2 border-t border-border-soft px-3 py-2 text-left text-[13px] transition first:border-t-0',
        selected ? 'bg-white/[0.06] text-foreground' : 'text-foreground/85 hover:bg-surface-muted',
      )}
    >
      <span className="grid h-4 w-4 shrink-0 place-items-center">{selected && <Check className="h-3.5 w-3.5" />}</span>
      {body}
    </button>
  )

  return (
    <div className="flex flex-col gap-2">
      <label className="relative">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key !== 'Enter' || e.nativeEvent.isComposing) return
            e.preventDefault()
            pickFromQuery()
          }}
          placeholder={repos.isError ? 'Type owner/name' : 'Search repos, or type owner/name'}
          spellCheck={false}
          aria-label="Search repositories"
          className={cn(fieldClass, 'pl-8 font-mono text-[12.5px]')}
        />
      </label>
      <div role="listbox" className="max-h-60 overflow-y-auto rounded-lg border border-border bg-surface">
        {row(
          'none',
          value === null,
          () => onChange(null),
          <span className="text-muted-foreground">No repo — audit only</span>,
        )}
        {typed &&
          row(
            `typed:${typed}`,
            value === typed,
            () => onChange(typed),
            <span className="min-w-0 flex-1 truncate font-mono text-[12.5px]">
              Use <span className="text-foreground">{typed}</span>
            </span>,
          )}
        {orphan &&
          row(
            `orphan:${orphan}`,
            true,
            () => onChange(orphan),
            <span className="min-w-0 flex-1 truncate font-mono text-[12.5px]">{orphan}</span>,
          )}
        {ordered.map((r) =>
          row(
            r.fullName,
            value === r.fullName,
            () => onChange(r.fullName),
            <>
              <span className="min-w-0 flex-1 truncate font-mono text-[12.5px]">
                <span className="text-muted-foreground">{r.fullName.split('/')[0]}/</span>
                {r.fullName.split('/').slice(1).join('/')}
              </span>
              {r.fullName === suggested && (
                <span className="eyebrow shrink-0 rounded border border-foreground/30 px-1.5 py-px text-foreground">
                  Matches site
                </span>
              )}
              {r.private && <Lock className="h-3 w-3 shrink-0 text-muted-foreground" aria-label="Private" />}
              <span className="w-16 shrink-0 text-right font-mono text-[11px] text-muted-foreground">
                {r.pushedAt ? timeAgo(r.pushedAt, now) : ''}
              </span>
            </>,
          ),
        )}
        {repos.isLoading && (
          <p className="flex items-center gap-2 border-t border-border-soft px-3 py-2 text-[12px] text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading repos…
          </p>
        )}
        {repos.isSuccess && ordered.length === 0 && !typed && (
          <p className="border-t border-border-soft px-3 py-2 text-[12px] text-muted-foreground">
            {all.length === 0 ? 'The token can’t see any repos.' : 'No repos match.'}
          </p>
        )}
      </div>
      {repos.isError && (
        <p className="text-[11.5px] text-muted-foreground">
          Couldn’t list repos: {repos.error instanceof Error ? repos.error.message : 'unknown error'}. Type the
          full name above, or link the repo later.
        </p>
      )}
    </div>
  )
}
