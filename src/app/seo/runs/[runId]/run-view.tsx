'use client'

import { useState, useSyncExternalStore } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  Ban,
  Bot,
  Check,
  ChevronRight,
  CircleX,
  FilePen,
  FilePlus,
  FileText,
  Gauge,
  GitPullRequest,
  Heart,
  ListChecks,
  Loader2,
  Minus,
  RotateCcw,
  ScrollText,
  Telescope,
  ThumbsDown,
  ThumbsUp,
  TriangleAlert,
  Upload,
  X,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { PageHeader } from '@/components/ui/page-header'
import type {
  CrawlView,
  RunActionBody,
  SeoRunDetail,
  SeoRunDetailResponse,
  SeoRunSummary,
  SeoSiteDetail,
  SeoSiteDetailResponse,
} from '@/lib/seo/api-types'
import type {
  ChangeFile,
  ClaudeUsage,
  ContentBrief,
  Draft,
  Finding,
  FindingSeverity,
  GateResult,
  GscRow,
  GscSummary,
  PlanItem,
  PsiResult,
  RunLogEntry,
  SeoPlan,
  SeoPostFile,
} from '@/lib/seo/types'
import {
  btnDanger,
  btnGhost,
  btnPrimary,
  btnSecondary,
  Card,
  CiPill,
  CopyButton,
  dayLabel,
  Delta,
  DotPill,
  elapsed,
  Empty,
  enc,
  ErrorBlock,
  ExtLink,
  fieldClass,
  fromIso,
  githubUrl,
  hashString,
  hostOf,
  isMoving,
  LoadingBlock,
  lovableUrl,
  Meter,
  Notice,
  type NoticeState,
  num,
  OwnerChip,
  pathOf,
  pollEvery,
  RunStatusPill,
  safeLink,
  score100,
  Segmented,
  seoFetch,
  seoKeys,
  SEVERITY_LABEL,
  SEVERITY_ORDER,
  SeverityChip,
  ShowMore,
  STAGE_LABEL,
  STAGES,
  StatTile,
  Table,
  Tabs,
  tdClass,
  thClass,
  timeAgo,
  usd,
  useNow,
  InlineText,
  weekLabel,
} from '../../ui'

/**
 * SEO → one run.
 *
 * The banner answers "where is it and what do I do": status, the stage
 * stepper, and the one or two actions the status allows. Below it, tabs
 * for everything the run produced. While the engine is moving the page
 * polls every 5s, and every 30s while it waits to be published (the
 * engine's live-site check can move it on); once it parks for review or
 * finishes it stops.
 *
 * Generated text is only ever rendered as text. Inline [anchor](href)
 * links in drafts become real anchors through InlineText, which drops any
 * scheme but http(s)/mailto/tel and resolves site-relative paths against
 * the client's live site.
 */

type TabKey = 'plan' | 'content' | 'audit' | 'changes' | 'research' | 'log'

function asArray<T>(v: T[] | null | undefined | unknown): T[] {
  return Array.isArray(v) ? (v as T[]) : []
}

function defaultTab(run: SeoRunDetail, drafts: Draft[], changes: ChangeFile[]): TabKey {
  if (run.status === 'awaiting_review') return drafts.length ? 'content' : changes.length ? 'changes' : 'plan'
  if (run.status === 'failed') return 'log'
  if (run.plan) return 'plan'
  if (run.audit || run.crawl) return 'audit'
  return 'log'
}

export function RunView({ runId }: { runId: string }) {
  const now = useNow()
  const [tab, setTab] = useState<TabKey | null>(null)
  const [notice, setNotice] = useState<NoticeState>(null)

  const q = useQuery<SeoRunDetailResponse>({
    queryKey: seoKeys.run(runId),
    queryFn: ({ signal }) => seoFetch<SeoRunDetailResponse>(`/api/seo/runs/${enc(runId)}`, { signal }),
    refetchInterval: (query) => pollEvery([query.state.data?.run?.status], 5_000),
  })
  const run = q.data?.run
  const siteId = run?.siteId ?? ''
  // The site gives the live URL (to resolve links in drafts) and the Lovable project.
  const siteQ = useQuery<SeoSiteDetailResponse>({
    queryKey: seoKeys.site(siteId),
    queryFn: ({ signal }) => seoFetch<SeoSiteDetailResponse>(`/api/seo/sites/${enc(siteId)}`, { signal }),
    enabled: !!siteId,
    staleTime: 60_000,
  })
  const site = siteQ.data?.site ?? null

  const crumbs = [{ label: 'Genisys' }, { label: 'SEO', href: '/seo' }]
  if (q.isLoading) {
    return (
      <div className="mx-auto flex max-w-[1280px] flex-col gap-6">
        <PageHeader title="Run" breadcrumbs={[...crumbs, { label: '…' }]} />
        <LoadingBlock />
      </div>
    )
  }
  if (q.isError || !run) {
    return (
      <div className="mx-auto flex max-w-[1280px] flex-col gap-6">
        <PageHeader title="Run" breadcrumbs={crumbs} />
        <ErrorBlock message={q.error instanceof Error ? q.error.message : 'Couldn’t load this run.'} onRetry={() => q.refetch()} />
      </div>
    )
  }

  const drafts = asArray<Draft>(run.drafts)
  const changes = asArray<ChangeFile>(run.changes)
  const log = asArray<RunLogEntry>(run.log)
  const findings = asArray<Finding>(run.audit?.findings)
  const failingFindings = findings.filter((f) => f.status === 'fail')
  const blockingDrafts = drafts.filter((d) => asArray<GateResult>(d.gates).some((g) => !g.ok && g.blocking)).length
  const base = site?.liveUrl ?? null
  const active = tab ?? defaultTab(run, drafts, changes)

  // The subtitle already says whether it was started manually.
  const title = run.kind === 'foundation' ? 'Foundation install' : weekLabel(run.weekOf, { markManual: false })
  const subtitle = [
    run.siteName,
    run.kind === 'foundation' ? 'one-time pull request' : 'weekly run',
    run.trigger === 'schedule' ? 'scheduled' : 'started manually',
    `created ${fromIso(run.createdAt)}`,
  ].join(' · ')

  return (
    <div className="mx-auto flex max-w-[1280px] flex-col gap-6">
      <PageHeader
        title={title}
        subtitle={subtitle}
        breadcrumbs={[...crumbs, { label: run.siteName, href: `/seo/${run.siteId}` }, { label: 'Run' }]}
      />

      <StatusBanner run={run} site={site} drafts={drafts} changes={changes} now={now} onNotice={setNotice} />
      <Notice notice={notice} onClose={() => setNotice(null)} />

      <Tabs<TabKey>
        value={active}
        onChange={setTab}
        tabs={[
          { key: 'plan', label: 'Plan', icon: ListChecks, count: asArray(run.plan?.quickWins).length },
          { key: 'content', label: 'Content', icon: FileText, count: drafts.length, alert: blockingDrafts > 0 },
          {
            key: 'audit',
            label: 'Audit',
            icon: Gauge,
            count: failingFindings.length,
            alert: failingFindings.some((f) => f.severity === 'P0'),
          },
          { key: 'changes', label: 'Changes', icon: GitPullRequest, count: changes.length },
          { key: 'research', label: 'Research', icon: Telescope, count: asArray(run.research?.sources).length },
          { key: 'log', label: 'Log', icon: ScrollText, count: log.length, alert: log.some((e) => e.level === 'error') },
        ]}
      />

      {active === 'plan' && <PlanTab run={run} base={base} />}
      {active === 'content' && <ContentTab run={run} drafts={drafts} base={base} />}
      {active === 'audit' && <AuditTab run={run} findings={findings} base={base} />}
      {active === 'changes' && <ChangesTab run={run} changes={changes} site={site} />}
      {active === 'research' && <ResearchTab run={run} base={base} />}
      {active === 'log' && <LogTab run={run} log={log} drafts={drafts} />}
    </div>
  )
}

/* -------------------------------------------------------------------------- */
/*  Status banner, stepper, actions                                           */
/* -------------------------------------------------------------------------- */

function statusSentence(run: SeoRunDetail, now: number): string {
  const stage = (STAGE_LABEL[run.stage] ?? run.stage).toLowerCase()
  switch (run.status) {
    case 'queued':
      return run.startedAt || run.stage !== 'collect'
        ? `Queued to carry on from ${stage}. The engine checks every minute.`
        : 'Waiting for the engine to pick it up. It checks every minute.'
    case 'running': {
      const t = elapsed(run.startedAt, null, now)
      return `Working on ${stage}${t ? ` · ${t} in` : ''}.`
    }
    case 'awaiting_review':
      return 'Ready for review. Read the drafts and changes, then approve to merge and ship, or reject.'
    case 'awaiting_ci':
      return 'Waiting for the site’s build check on GitHub.'
    case 'awaiting_publish':
      if (run.hubPublishing) return 'Merged. The Hub is publishing it in Lovable and checking the live site.'
      return run.publishing?.channel
        ? 'Merged. The Hub stopped publishing on its own — see why below.'
        : 'Merged. Waiting for someone to publish the site in Lovable.'
    case 'done': {
      const took = elapsed(run.startedAt, run.finishedAt, now)
      return `Finished ${timeAgo(run.finishedAt, now)}${took ? ` · took ${took}` : ''}.`
    }
    case 'failed':
      return `Stopped at ${stage}.`
    case 'canceled':
      return run.reviewedBy ? `Stopped by ${run.reviewedBy}.` : 'Canceled.'
    default:
      return ''
  }
}

type StepState = 'done' | 'current' | 'next' | 'waiting' | 'failed' | 'stopped' | 'pending' | 'skipped'

function stepStates(run: SeoRunDetail, changes: ChangeFile[]): StepState[] {
  // An audit-mode run finishes without committing anything.
  const shipless = run.status === 'done' && !run.commitSha && !run.prUrl && changes.length === 0
  const idx = run.stage === 'done' ? STAGES.length : STAGES.indexOf(run.stage)
  return STAGES.map((s, i): StepState => {
    if (run.status === 'done') return shipless && (s === 'commit' || s === 'ship' || s === 'verify') ? 'skipped' : 'done'
    if (idx === -1 || i > idx) return 'pending'
    if (i < idx) return 'done'
    switch (run.status) {
      case 'running':
        return 'current'
      case 'queued':
        return 'next'
      case 'failed':
        return 'failed'
      case 'canceled':
        return 'stopped'
      default:
        return 'waiting'
    }
  })
}

const STEP_TITLE: Record<StepState, string> = {
  done: 'Done',
  current: 'Working on it',
  next: 'Up next',
  waiting: 'Waiting on a person or a check',
  failed: 'Failed here',
  stopped: 'Stopped here',
  pending: 'Not started',
  skipped: 'Skipped — nothing to commit',
}

function StepDot({ state }: { state: StepState }) {
  return (
    <span
      className={cn(
        'relative z-10 grid h-[18px] w-[18px] place-items-center rounded-full',
        state === 'done' && 'bg-foreground text-background',
        state === 'current' && 'border-2 border-foreground bg-card',
        state === 'next' && 'border border-foreground/50 bg-card',
        state === 'waiting' && 'border-2 border-warning bg-card',
        state === 'failed' && 'border border-destructive bg-card text-destructive',
        state === 'stopped' && 'border border-border bg-card text-muted-foreground',
        state === 'pending' && 'border border-border bg-card',
        state === 'skipped' && 'border border-dashed border-border bg-card',
      )}
    >
      {state === 'done' && <Check className="h-3 w-3" strokeWidth={3} />}
      {state === 'current' && <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-foreground" />}
      {state === 'next' && <span className="h-1 w-1 rounded-full bg-foreground/50" />}
      {state === 'waiting' && <span className="h-1.5 w-1.5 rounded-full bg-warning" />}
      {state === 'failed' && <X className="h-3 w-3" strokeWidth={3} />}
      {state === 'stopped' && <Minus className="h-3 w-3" />}
    </span>
  )
}

function Stepper({ run, changes }: { run: SeoRunDetail; changes: ChangeFile[] }) {
  const states = stepStates(run, changes)
  return (
    <ol className="grid grid-cols-4 gap-y-4 sm:grid-cols-8">
      {STAGES.map((s, i) => {
        const state = states[i]
        const lit = state === 'current' || state === 'waiting' || state === 'failed'
        return (
          <li key={s} className="relative flex flex-col items-center gap-2 text-center" title={`${STAGE_LABEL[s]}: ${STEP_TITLE[state]}`}>
            {i > 0 && (
              <span
                aria-hidden
                className={cn(
                  'absolute right-1/2 top-[9px] hidden h-px w-full sm:block',
                  states[i - 1] === 'done' && state !== 'pending' && state !== 'skipped' ? 'bg-foreground/50' : 'bg-border',
                )}
              />
            )}
            <StepDot state={state} />
            <span
              className={cn(
                'eyebrow',
                lit ? 'text-foreground' : state === 'done' ? 'text-muted-foreground' : 'text-muted-foreground/50',
                state === 'failed' && 'text-destructive',
              )}
            >
              {STAGE_LABEL[s]}
            </span>
            <span className="sr-only">{STEP_TITLE[state]}</span>
          </li>
        )
      })}
    </ol>
  )
}

function StatusBanner({
  run,
  site,
  drafts,
  changes,
  now,
  onNotice,
}: {
  run: SeoRunDetail
  site: SeoSiteDetail | null
  drafts: Draft[]
  changes: ChangeFile[]
  now: number
  onNotice: (n: NoticeState) => void
}) {
  const meta: [string, React.ReactNode][] = [['Started', run.startedAt ? fromIso(run.startedAt) : 'not yet']]
  if (run.finishedAt) meta.push(['Finished', fromIso(run.finishedAt)])
  else if (run.status === 'running' && run.startedAt) meta.push(['Running for', elapsed(run.startedAt, null, now) ?? '—'])
  meta.push(
    ['Cost', <span key="c" className="font-mono">{usd(run.costUsd)}</span>],
    ['Score', <span key="s" className="font-mono">{typeof run.score === 'number' ? Math.round(run.score) : '—'}</span>],
    ['Drafts', <span key="d" className="font-mono">{drafts.length}</span>],
  )
  if (run.prUrl) {
    meta.push([
      'Pull request',
      <span key="pr" className="inline-flex items-center gap-2">
        <ExtLink href={run.prUrl} className="font-mono">
          {run.prNumber ? `#${run.prNumber}` : 'Open'}
        </ExtLink>
        {run.ciStatus && <CiPill status={run.ciStatus} />}
      </span>,
    ])
  }
  if (run.mergedAt) meta.push(['Merged', fromIso(run.mergedAt)])
  if (run.publishedAt) meta.push(['Published', fromIso(run.publishedAt)])
  if (run.reviewedBy) meta.push(['Reviewed by', run.reviewedBy])

  return (
    <section className="rounded-xl border border-border bg-card">
      <div className="flex flex-wrap items-start justify-between gap-4 p-5">
        <div className="min-w-0 flex-1 basis-[20rem]">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
            <RunStatusPill status={run.status} hubPublishing={run.hubPublishing} />
            <span className="text-[13px] text-muted-foreground">{statusSentence(run, now)}</span>
          </div>
          {run.headline && (
            <p className="mt-3 max-w-3xl text-[17px] font-medium leading-snug tracking-tight">{run.headline}</p>
          )}
        </div>
        <RunActions run={run} site={site} drafts={drafts} onNotice={onNotice} />
      </div>

      <div className="border-t border-border-soft px-5 py-4">
        <Stepper run={run} changes={changes} />
      </div>

      <dl className="flex flex-wrap gap-x-7 gap-y-2 border-t border-border-soft px-5 py-3">
        {meta.map(([label, value]) => (
          <div key={label} className="flex items-baseline gap-2 text-[12.5px]">
            <dt className="eyebrow text-muted-foreground/80">{label}</dt>
            <dd className="text-foreground/85">{value}</dd>
          </div>
        ))}
      </dl>

      {run.error && (
        <div
          className={cn(
            'mx-5 mb-5 flex items-start gap-2 rounded-lg border p-3 text-[13px]',
            run.status === 'failed'
              ? 'border-destructive/30 bg-destructive/10 text-destructive'
              : 'border-border bg-surface text-muted-foreground',
          )}
        >
          {run.status === 'failed' ? <CircleX className="mt-0.5 h-4 w-4 shrink-0" /> : <Ban className="mt-0.5 h-4 w-4 shrink-0" />}
          <span className="whitespace-pre-wrap break-words">{run.error}</span>
        </div>
      )}

      {run.status === 'awaiting_publish' && (
        <div className="mx-5 mb-5 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border border-border bg-surface px-3 py-2.5 text-[12.5px] text-muted-foreground">
          <Upload className="h-3.5 w-3.5 shrink-0" />
          <span className="min-w-0 flex-1">{publishNote(run, site, now)}</span>
        </div>
      )}
    </section>
  )
}

/** What the publish step is doing, in a sentence or two. */
function publishNote(run: SeoRunDetail, site: SeoSiteDetail | null, now: number): string {
  const p = run.publishing
  const waiting = p?.waitingFor.length ? ` It\u2019s looking for ${p.waitingFor.join(', ')}.` : ''
  if (run.hubPublishing) {
    const asked = p?.attempts
      ? `Published in Lovable ${p.attempts === 1 ? 'once' : `${p.attempts} times`}${p.lastRequestedAt ? `, last ${timeAgo(p.lastRequestedAt, now)}` : ''}.`
      : 'Waiting for Lovable to pick the merge up from GitHub, then publishing.'
    return `Nothing to do here: the Hub publishes this in Lovable and checks the live site every few minutes. ${asked}${waiting}`
  }
  if (p?.channel) {
    return `The Hub handed this back (the reason is above). Fix that, then use Publish now \u2014 or publish in Lovable yourself and mark it published.${waiting}`
  }
  return `Lovable isn\u2019t connected, so someone publishes this by hand: open the project, click Publish \u2192 Update, then mark it published here. Connect Lovable on the SEO dashboard to skip this step.${
    site?.lovableProjectId ? '' : ' Set the Lovable project in the site\u2019s settings to get a direct link.'
  }`
}

const DONE_TEXT: Record<RunActionBody['action'], string> = {
  approve: 'Approved. The engine merges and ships it next — this page follows along.',
  reject: 'Rejected. Nothing from this run ships.',
  mark_published: 'Marked as published. The engine now checks the live site.',
  publish_now: 'Published in Lovable. The engine checks the live site within a few minutes.',
  cancel: 'Run canceled.',
  retry: 'Retrying from where it stopped.',
}

function RunActions({
  run,
  site,
  drafts,
  onNotice,
}: {
  run: SeoRunDetail
  site: SeoSiteDetail | null
  drafts: Draft[]
  onNotice: (n: NoticeState) => void
}) {
  const qc = useQueryClient()
  const [rejecting, setRejecting] = useState(false)
  const [reason, setReason] = useState('')

  const act = useMutation({
    mutationFn: (body: RunActionBody) =>
      seoFetch<{ run: SeoRunSummary }>(`/api/seo/runs/${enc(run.id)}`, { method: 'POST', body }),
    onMutate: () => onNotice(null),
    onSuccess: ({ run: next }, body) => {
      if (next) {
        // The summary's `drafts` is a count; keep the detail's array.
        qc.setQueryData<SeoRunDetailResponse>(seoKeys.run(run.id), (old) =>
          old ? { run: { ...old.run, ...next, drafts: old.run.drafts } } : old,
        )
      }
      qc.invalidateQueries({ queryKey: seoKeys.run(run.id) })
      qc.invalidateQueries({ queryKey: seoKeys.site(run.siteId) })
      qc.invalidateQueries({ queryKey: seoKeys.overview })
      setRejecting(false)
      setReason('')
      onNotice({ tone: 'ok', text: DONE_TEXT[body.action] })
    },
    onError: (e: Error) => {
      onNotice({ tone: 'err', text: e.message })
      // The run may have moved on under this page (the engine noticed a
      // publish, someone else acted) — re-read it so the buttons match.
      qc.invalidateQueries({ queryKey: seoKeys.run(run.id) })
    },
  })

  /** `doneText` replaces the usual DONE_TEXT notice for this one call. */
  function go(body: RunActionBody, confirmText?: string, doneText?: string) {
    if (confirmText && !window.confirm(confirmText)) return
    act.mutate(body, doneText ? { onSuccess: () => onNotice({ tone: 'ok', text: doneText }) } : undefined)
  }

  const busy = act.isPending
  const spin = (a: RunActionBody['action']) => busy && act.variables?.action === a
  const blocking = drafts.reduce((n, d) => n + asArray<GateResult>(d.gates).filter((g) => !g.ok && g.blocking).length, 0)
  const ciFailed = (run.ciStatus ?? '').toLowerCase() === 'failure'
  const branch = site?.defaultBranch ?? 'main'
  const ciNote = 'The last build check failed. Approving re-checks the latest build first and only merges if it passes.'

  if (run.status === 'awaiting_review') {
    const approveText = [
      'Approve and ship this run?',
      run.prNumber && run.repoFullName
        ? `PR #${run.prNumber} is squash-merged into ${branch} on ${run.repoFullName}, then published.`
        : 'Its changes are merged and published.',
      ciFailed ? ciNote : null,
      blocking > 0
        ? `${blocking} blocking content check${blocking === 1 ? '' : 's'} failed. Only approve if you’ve read the drafts and they’re right anyway.`
        : null,
    ]
      .filter(Boolean)
      .join('\n\n')
    return (
      <div className="flex flex-col items-end gap-2">
        <div className="flex flex-wrap items-center gap-2">
          {!rejecting && (
            <button type="button" onClick={() => setRejecting(true)} disabled={busy} className={btnSecondary}>
              <ThumbsDown className="h-4 w-4" /> Reject
            </button>
          )}
          <button
            type="button"
            onClick={() =>
              go(
                { action: 'approve' },
                approveText,
                ciFailed
                  ? 'Approved. The engine re-checks the latest build and merges only if it passes — this page follows along.'
                  : undefined,
              )
            }
            disabled={busy}
            title={ciFailed ? ciNote : undefined}
            className={btnPrimary}
          >
            {spin('approve') ? <Loader2 className="h-4 w-4 animate-spin" /> : <ThumbsUp className="h-4 w-4" />}
            Approve &amp; ship
          </button>
        </div>
        {ciFailed && <p className="max-w-sm text-right text-[12px] text-warning">{ciNote}</p>}
        {rejecting && (
          <form
            onSubmit={(e) => {
              e.preventDefault()
              const r = reason.trim()
              go(
                r ? { action: 'reject', reason: r } : { action: 'reject' },
                'Reject this run? Its pull request is closed and nothing from it ships.',
              )
            }}
            className="flex w-full max-w-md flex-col gap-2 rounded-lg border border-border bg-surface p-3"
          >
            <label className="eyebrow text-muted-foreground" htmlFor="seo-reject-reason">
              Why? (optional — saved on the run)
            </label>
            <input
              id="seo-reject-reason"
              autoFocus
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="e.g. Pricing in the cost guide is wrong"
              className={fieldClass}
            />
            <div className="flex justify-end gap-2">
              <button type="button" onClick={() => setRejecting(false)} className={cn(btnGhost, 'h-8 text-[12.5px]')}>
                Keep it
              </button>
              <button type="submit" disabled={busy} className={cn(btnDanger, 'h-8')}>
                {spin('reject') ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ThumbsDown className="h-3.5 w-3.5" />}
                Reject run
              </button>
            </div>
          </form>
        )}
      </div>
    )
  }

  if (run.status === 'awaiting_publish') {
    const connected = !!run.publishing?.channel
    return (
      <div className="flex flex-wrap items-center gap-2">
        {site?.lovableProjectId && (
          <a href={lovableUrl(site.lovableProjectId)} target="_blank" rel="noopener noreferrer" className={btnSecondary}>
            <Heart className="h-4 w-4" /> Open in Lovable
          </a>
        )}
        {connected && (
          <button
            type="button"
            onClick={() =>
              go(
                { action: 'publish_now' },
                `Publish ${site?.name ?? 'this site'} in Lovable now?\n\nWhatever is in the Lovable project goes live — including edits made in Lovable since its last publish.`,
              )
            }
            disabled={busy}
            className={run.hubPublishing ? btnSecondary : btnPrimary}
          >
            {spin('publish_now') ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
            Publish now
          </button>
        )}
        {!run.hubPublishing && (
        <button
          type="button"
          onClick={() =>
            go(
              { action: 'mark_published' },
              'Mark as published? Only do this once Lovable says the update is live — the engine then checks the live site for the new content.',
            )
          }
          disabled={busy}
          className={connected ? btnSecondary : btnPrimary}
        >
          {spin('mark_published') ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
          Mark as published
        </button>
        )}
      </div>
    )
  }

  if (run.status === 'failed') {
    return (
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() =>
            go(
              { action: 'cancel' },
              run.prUrl && !run.mergedAt
                ? 'Dismiss this failed run? Its pull request is closed, nothing more from it ships, and it stops showing as needing you.'
                : 'Dismiss this failed run? It stays in the history as canceled and stops showing as needing you.',
              'Dismissed. The run stays in the history as canceled.',
            )
          }
          disabled={busy}
          title="Stop tracking this failure without retrying it"
          className={btnSecondary}
        >
          {spin('cancel') ? <Loader2 className="h-4 w-4 animate-spin" /> : <Ban className="h-4 w-4" />}
          Dismiss
        </button>
        <button type="button" onClick={() => go({ action: 'retry' })} disabled={busy} className={btnPrimary}>
          {spin('retry') ? <Loader2 className="h-4 w-4 animate-spin" /> : <RotateCcw className="h-4 w-4" />}
          Retry
        </button>
      </div>
    )
  }

  if (isMoving(run.status)) {
    return (
      <button
        type="button"
        onClick={() =>
          go(
            { action: 'cancel' },
            run.prUrl
              ? 'Cancel this run? Its pull request is closed and nothing from it ships.'
              : 'Cancel this run? It stops after the step it’s on.',
          )
        }
        disabled={busy}
        className={btnSecondary}
      >
        {spin('cancel') ? <Loader2 className="h-4 w-4 animate-spin" /> : <Ban className="h-4 w-4" />}
        Cancel
      </button>
    )
  }

  return null
}

/* -------------------------------------------------------------------------- */
/*  Plan                                                                      */
/* -------------------------------------------------------------------------- */

const CATEGORY_LABEL: Record<PlanItem['category'], string> = {
  technical: 'Technical',
  on_page: 'On-page',
  content: 'Content',
  internal_links: 'Internal links',
  schema: 'Schema',
  local_seo: 'Local SEO',
  gbp: 'Google profile',
  reviews: 'Reviews',
  citations: 'Citations',
  geo_ai: 'AI search',
}

const CONTENT_TYPE_LABEL: Record<ContentBrief['contentType'], string> = {
  cost_guide: 'Cost guide',
  permit_guide: 'Permit guide',
  case_study: 'Case study',
  comparison: 'Comparison',
  seasonal: 'Seasonal',
  how_to_choose: 'How to choose',
  faq: 'FAQ',
  other: 'Post',
}

function byPriority(a: PlanItem, b: PlanItem): number {
  return (
    (SEVERITY_ORDER[a.priority] ?? 9) - (SEVERITY_ORDER[b.priority] ?? 9) ||
    (b.impact ?? 0) - (a.impact ?? 0) ||
    (b.confidence ?? 0) - (a.confidence ?? 0) ||
    (a.effort ?? 0) - (b.effort ?? 0)
  )
}

function PlanTab({ run, base }: { run: SeoRunDetail; base: string | null }) {
  const plan: SeoPlan | null = run.plan
  if (!plan) {
    return (
      <Empty>
        {isMoving(run.status)
          ? 'The plan shows up once the run reaches the plan stage.'
          : 'This run didn’t get as far as a plan. The log says why.'}
      </Empty>
    )
  }
  return (
    <div className="flex flex-col gap-6">
      <Card title="This week">
        {plan.headline && <h2 className="text-[18px] font-semibold leading-snug tracking-tight">{plan.headline}</h2>}
        {plan.summary && (
          <p className="mt-2 max-w-3xl whitespace-pre-wrap text-[13.5px] leading-relaxed text-foreground/85">{plan.summary}</p>
        )}
        {plan.scorecard && (
          <div className="mt-4 rounded-lg border border-border-soft bg-surface p-3">
            <p className="eyebrow mb-1.5 text-muted-foreground">Scorecard</p>
            <p className="whitespace-pre-wrap font-mono text-[12px] leading-relaxed text-foreground/85">{plan.scorecard}</p>
          </div>
        )}
      </Card>
      <QuickWins items={asArray<PlanItem>(plan.quickWins)} base={base} />
      <Briefs briefs={asArray<ContentBrief>(plan.content)} />
      <div className="grid gap-4 lg:grid-cols-2">
        <HumanTasks runId={run.id} tasks={asArray<SeoPlan['humanTasks'][number]>(plan.humanTasks)} />
        <ClientInputs inputs={asArray<string>(plan.clientInputs)} />
      </div>
    </div>
  )
}

type OwnerFilter = 'all' | PlanItem['owner']

function QuickWins({ items, base }: { items: PlanItem[]; base: string | null }) {
  const [owner, setOwner] = useState<OwnerFilter>('all')
  const sorted = [...items].sort(byPriority)
  const count = (o: OwnerFilter) => (o === 'all' ? items.length : items.filter((i) => i.owner === o).length)
  const shown = owner === 'all' ? sorted : sorted.filter((i) => i.owner === owner)

  return (
    <Card
      title="Quick wins"
      hint="P0 first"
      bodyClassName="p-0"
      actions={
        items.length > 0 && (
          <Segmented<OwnerFilter>
            size="sm"
            value={owner}
            onChange={setOwner}
            options={(['all', 'engine', 'genisys', 'client'] as const).map((o) => ({
              value: o,
              label: `${o === 'all' ? 'All' : o === 'engine' ? 'Engine' : o === 'genisys' ? 'Genisys' : 'Client'} ${count(o)}`,
              disabled: count(o) === 0,
            }))}
          />
        )
      }
    >
      {shown.length === 0 ? (
        <p className="p-4 text-[13px] text-muted-foreground">{items.length ? 'Nothing for this owner.' : 'No quick wins this week.'}</p>
      ) : (
        <div>
          {shown.map((w, i) => {
            const target = safeLink(w.targetUrl, base)
            return (
              <details key={w.id || i} className="group border-t border-border-soft first:border-t-0">
                <summary className="flex cursor-pointer list-none items-start gap-3 px-4 py-3 transition hover:bg-surface-muted [&::-webkit-details-marker]:hidden">
                  <ChevronRight className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground transition group-open:rotate-90" />
                  <SeverityChip severity={w.priority} />
                  <div className="min-w-0 flex-1">
                    <p className="text-[13px] font-medium">{w.title}</p>
                    <p className="mt-0.5 line-clamp-1 text-[12px] text-muted-foreground group-open:hidden">{w.action}</p>
                  </div>
                  <span className="eyebrow hidden shrink-0 text-muted-foreground/80 md:inline">
                    {CATEGORY_LABEL[w.category] ?? w.category}
                  </span>
                  <OwnerChip owner={w.owner} />
                </summary>
                <div className="grid gap-4 px-4 pb-4 pl-11 text-[13px] md:grid-cols-[minmax(0,1fr)_15rem]">
                  <div className="flex min-w-0 flex-col gap-2.5">
                    <p className="whitespace-pre-wrap leading-relaxed">
                      <span className="eyebrow mr-2 text-muted-foreground">Do</span>
                      <InlineText text={w.action} base={base} />
                    </p>
                    {w.evidence && (
                      <p className="whitespace-pre-wrap leading-relaxed text-muted-foreground">
                        <span className="eyebrow mr-2 text-muted-foreground/80">Why</span>
                        {w.evidence}
                      </p>
                    )}
                    {w.owner === 'genisys' && typeof w.lovablePrompt === 'string' && w.lovablePrompt.trim() && (
                      <div className="rounded-lg border border-border-soft bg-surface">
                        <div className="flex items-center justify-between gap-2 border-b border-border-soft px-3 py-1.5">
                          <span className="eyebrow text-muted-foreground">Paste into Lovable</span>
                          <CopyButton value={w.lovablePrompt} label="Copy prompt" />
                        </div>
                        <p className="whitespace-pre-wrap px-3 py-2 font-mono text-[12px] leading-relaxed text-foreground/85">
                          {w.lovablePrompt}
                        </p>
                      </div>
                    )}
                    {w.targetUrl &&
                      (target ? (
                        <ExtLink href={target} className="self-start font-mono text-[12px]">
                          {pathOf(target)}
                        </ExtLink>
                      ) : (
                        <span className="font-mono text-[12px] text-muted-foreground">{w.targetUrl}</span>
                      ))}
                  </div>
                  <dl className="grid h-fit grid-cols-3 gap-2 rounded-lg border border-border-soft bg-surface p-2.5 text-center">
                    <Score5 label="Impact" value={`${w.impact ?? '—'}/5`} />
                    <Score5 label="Confidence" value={typeof w.confidence === 'number' ? `${Math.round(w.confidence * 100)}%` : '—'} />
                    <Score5 label="Effort" value={`${w.effort ?? '—'}/5`} />
                  </dl>
                </div>
              </details>
            )
          })}
        </div>
      )}
    </Card>
  )
}

function Score5({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="eyebrow text-[9.5px] text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 font-mono text-[13px] tabular-nums">{value}</dd>
    </div>
  )
}

function Briefs({ briefs }: { briefs: ContentBrief[] }) {
  if (briefs.length === 0) return null
  return (
    <Card title="Content planned" hint={`${briefs.length} brief${briefs.length === 1 ? '' : 's'}`} bodyClassName="p-0">
      {briefs.map((b, i) => (
        <details key={b.slug || i} className="group border-t border-border-soft first:border-t-0">
          <summary className="flex cursor-pointer list-none flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3 transition hover:bg-surface-muted [&::-webkit-details-marker]:hidden">
            <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground transition group-open:rotate-90" />
            <span className="min-w-0 flex-1 basis-[14rem] text-[13px] font-medium">{b.title}</span>
            <span className="rounded-md border border-border px-1.5 py-0.5 font-mono text-[11px] text-foreground/85">{b.primaryKeyword}</span>
            <span className="eyebrow text-muted-foreground/80">{CONTENT_TYPE_LABEL[b.contentType] ?? b.contentType}</span>
          </summary>
          <div className="grid gap-4 px-4 pb-4 pl-11 text-[13px] md:grid-cols-2">
            <div className="flex flex-col gap-2.5">
              {b.angle && <Labeled label="Angle">{b.angle}</Labeled>}
              {b.whyNow && <Labeled label="Why now">{b.whyNow}</Labeled>}
              <Labeled label="Targets">
                {[b.intent, b.targetCity, b.serviceSlug && `/services/${b.serviceSlug}`].filter(Boolean).join(' · ') || '—'}
              </Labeled>
              {asArray<string>(b.secondaryKeywords).length > 0 && (
                <Labeled label="Also covers">{asArray<string>(b.secondaryKeywords).join(', ')}</Labeled>
              )}
            </div>
            <div className="flex flex-col gap-2.5">
              {asArray<string>(b.outline).length > 0 && (
                <Labeled label="Outline">
                  <ol className="mt-1 list-decimal space-y-0.5 pl-5">
                    {asArray<string>(b.outline).map((o, j) => (
                      <li key={j}>{o}</li>
                    ))}
                  </ol>
                </Labeled>
              )}
              {asArray<string>(b.factsToUse).length > 0 && (
                <Labeled label="First-hand facts">
                  <ul className="mt-1 list-disc space-y-0.5 pl-5">
                    {asArray<string>(b.factsToUse).map((f, j) => (
                      <li key={j}>{f}</li>
                    ))}
                  </ul>
                </Labeled>
              )}
              <SourceList sources={asArray<{ title: string; url: string }>(b.sources)} />
            </div>
          </div>
        </details>
      ))}
    </Card>
  )
}

function Labeled({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="leading-relaxed">
      <p className="eyebrow text-muted-foreground/80">{label}</p>
      <div className="mt-0.5 text-foreground/85">{children}</div>
    </div>
  )
}

function SourceList({ sources }: { sources: { title: string; url: string }[] }) {
  if (sources.length === 0) return null
  return (
    <Labeled label="Sources">
      <ol className="mt-1 flex list-decimal flex-col gap-1 pl-5">
        {sources.map((s, j) => {
          const href = safeLink(s.url)
          return (
            <li key={`${s.url}-${j}`} className="min-w-0">
              {href ? (
                <ExtLink href={href} className="max-w-full" title={s.url}>
                  {s.title || hostOf(href)}
                </ExtLink>
              ) : (
                <span className="text-muted-foreground">{s.title || s.url}</span>
              )}
              {href && s.title && <span className="ml-2 font-mono text-[11px] text-muted-foreground">{hostOf(href)}</span>}
            </li>
          )
        })}
      </ol>
    </Labeled>
  )
}

// Human-task ticks live in this browser only: they're a to-do aid for the
// person reading the plan, not run state the engine acts on.
const CHECK_EVENT = 'seo-checklist-change'

function subscribeChecklist(onChange: () => void) {
  window.addEventListener(CHECK_EVENT, onChange)
  window.addEventListener('storage', onChange)
  return () => {
    window.removeEventListener(CHECK_EVENT, onChange)
    window.removeEventListener('storage', onChange)
  }
}

function readChecklist(key: string): string {
  try {
    return localStorage.getItem(key) ?? ''
  } catch {
    return ''
  }
}

function parseChecklist(raw: string): Set<string> {
  try {
    const v: unknown = JSON.parse(raw || '[]')
    return new Set(Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])
  } catch {
    return new Set()
  }
}

function useChecklist(key: string): [Set<string>, (id: string) => void] {
  const raw = useSyncExternalStore(subscribeChecklist, () => readChecklist(key), () => '')
  const done = parseChecklist(raw)
  function toggle(id: string) {
    const next = parseChecklist(readChecklist(key))
    if (next.has(id)) next.delete(id)
    else next.add(id)
    try {
      localStorage.setItem(key, JSON.stringify([...next]))
    } catch {
      // Private mode or storage full — the tick just won't stick.
    }
    window.dispatchEvent(new Event(CHECK_EVENT))
  }
  return [done, toggle]
}

function HumanTasks({ runId, tasks }: { runId: string; tasks: SeoPlan['humanTasks'] }) {
  const [done, toggle] = useChecklist(`seo-run-tasks:${runId}`)
  // Keyed by content, so a retried run with a new plan doesn't inherit old ticks.
  const ids = tasks.map((t, i) => `${i}:${hashString(`${t.title}|${t.detail}`)}`)
  const ticked = ids.filter((id) => done.has(id)).length

  return (
    <Card title="For a person" hint={tasks.length ? `${ticked} of ${tasks.length} done` : undefined}>
      {tasks.length === 0 ? (
        <p className="text-[13px] text-muted-foreground">Nothing needs a person this week.</p>
      ) : (
        <>
          <ul className="flex flex-col gap-3">
            {tasks.map((t, i) => {
              const checked = done.has(ids[i])
              return (
                <li key={ids[i]}>
                  <label className="flex cursor-pointer items-start gap-3">
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => toggle(ids[i])}
                      className="mt-0.5 h-4 w-4 shrink-0 accent-foreground"
                    />
                    <span className="min-w-0 flex-1">
                      <span className={cn('block text-[13px] font-medium', checked && 'text-muted-foreground line-through')}>
                        {t.title}
                      </span>
                      {t.detail && <span className="mt-0.5 block whitespace-pre-wrap text-[12px] leading-relaxed text-muted-foreground">{t.detail}</span>}
                    </span>
                    <span className="eyebrow shrink-0 text-muted-foreground/70">{t.category === 'gbp' ? 'Google profile' : t.category}</span>
                  </label>
                </li>
              )
            })}
          </ul>
          <p className="mt-4 text-[11px] text-muted-foreground/70">Ticks are saved in this browser.</p>
        </>
      )}
    </Card>
  )
}

function ClientInputs({ inputs }: { inputs: string[] }) {
  return (
    <Card
      title="Ask the client"
      hint={inputs.length ? `${inputs.length}` : undefined}
      actions={inputs.length > 0 && <CopyButton value={inputs.map((q) => `- ${q}`).join('\n')} label="Copy list" />}
    >
      {inputs.length === 0 ? (
        <p className="text-[13px] text-muted-foreground">Nothing to ask the client this week.</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {inputs.map((q, i) => (
            <li key={i} className="flex items-start gap-2.5 text-[13px] leading-relaxed">
              <span className="mt-2 h-1 w-1 shrink-0 rounded-full bg-foreground/60" />
              <span>{q}</span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  )
}

/* -------------------------------------------------------------------------- */
/*  Content                                                                   */
/* -------------------------------------------------------------------------- */

function ContentTab({ run, drafts, base }: { run: SeoRunDetail; drafts: Draft[]; base: string | null }) {
  if (drafts.length === 0) {
    return (
      <Empty>
        {isMoving(run.status)
          ? 'Drafts show up once the run reaches the write stage.'
          : run.kind === 'foundation'
            ? 'Foundation installs don’t write posts — see Changes.'
            : 'No drafts this run. Posts per week may be set to 0, or the plan had no new content.'}
      </Empty>
    )
  }
  return (
    <div className="flex flex-col gap-4">
      {drafts.map((d, i) => (
        <DraftCard key={d.post?.slug || i} draft={d} defaultOpen={i === 0} base={base} />
      ))}
    </div>
  )
}

function DraftCard({ draft, defaultOpen, base }: { draft: Draft; defaultOpen: boolean; base: string | null }) {
  const p: Partial<SeoPostFile> = draft.post ?? {}
  const gates = asArray<GateResult>(draft.gates)
  const passed = gates.filter((g) => g.ok).length
  const blocking = gates.filter((g) => !g.ok && g.blocking).length
  const warnings = gates.filter((g) => !g.ok && !g.blocking).length

  return (
    <details open={defaultOpen} className="group rounded-xl border border-border bg-card">
      <summary className="flex cursor-pointer list-none flex-wrap items-center gap-x-3 gap-y-1.5 px-4 py-3 [&::-webkit-details-marker]:hidden">
        <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground transition group-open:rotate-90" />
        <div className="min-w-0 flex-1 basis-[16rem]">
          <p className="truncate text-[14px] font-semibold">{p.title || 'Untitled draft'}</p>
          <p className="truncate font-mono text-[11px] text-muted-foreground">
            /blog/{p.slug ?? '—'}
            {p.primaryKeyword ? ` · ${p.primaryKeyword}` : ''}
          </p>
        </div>
        {blocking > 0 ? (
          <DotPill tone="bad" label={`${blocking} blocking`} />
        ) : warnings > 0 ? (
          <DotPill tone="attention" label={`${warnings} warning${warnings === 1 ? '' : 's'}`} />
        ) : (
          <DotPill tone="good" label="Checks pass" />
        )}
        <span className="font-mono text-[11px] text-muted-foreground">
          {passed}/{gates.length} · {usd(draft.costUsd)}
        </span>
      </summary>
      <div className="grid gap-5 border-t border-border-soft p-4 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <PostPreview post={p} base={base} />
        <aside className="flex min-w-0 flex-col gap-4">
          <div className="flex flex-wrap gap-2">
            <CopyButton value={draft.html ?? ''} label="Copy HTML" />
            <CopyButton value={draft.plainText ?? ''} label="Copy text" />
          </div>
          <p className="-mt-2 text-[11px] leading-snug text-muted-foreground/80">For GoHighLevel’s blog editor: paste the HTML into its code view, or the text as-is.</p>
          <SnippetPreview post={p} base={base} />
          <GateList gates={gates} />
          <PostMeta post={p} />
        </aside>
      </div>
    </details>
  )
}

function PostPreview({ post: p, base }: { post: Partial<SeoPostFile>; base: string | null }) {
  const sections = asArray<SeoPostFile['sections'][number]>(p.sections)
  const faqs = asArray<SeoPostFile['faqs'][number]>(p.faqs)
  const sources = asArray<SeoPostFile['sources'][number]>(p.sources)
  const byline = [p.author, p.date && `Published ${dayLabel(p.date, true)}`, p.updated && p.updated !== p.date && `updated ${dayLabel(p.updated, true)}`, p.readTime]
    .filter(Boolean)
    .join(' · ')

  return (
    <article className="min-w-0 rounded-lg border border-border-soft bg-surface px-5 py-6 sm:px-8">
      {p.eyebrow && <p className="eyebrow text-muted-foreground">{p.eyebrow}</p>}
      <h1 className="mt-2 text-[24px] font-semibold leading-tight tracking-tight">{p.title}</h1>
      {byline && <p className="mt-2 font-mono text-[11px] text-muted-foreground">{byline}</p>}
      {p.imageKey && (
        <div className="mt-4 flex min-h-20 flex-col items-center justify-center gap-1 rounded-md border border-dashed border-border px-4 py-3 text-center text-[12px] text-muted-foreground">
          <span>
            Photo <span className="font-mono text-foreground/85">{p.imageKey}</span> from the site
          </span>
          {p.imageAlt && <span className="italic">“{p.imageAlt}”</span>}
        </div>
      )}
      {p.answer && (
        <div className="mt-5 rounded-md border-l-2 border-foreground/50 bg-white/[0.03] px-4 py-3 text-[14px] leading-relaxed">
          <p className="eyebrow mb-1 text-muted-foreground">Short answer</p>
          <InlineText text={p.answer} base={base} />
        </div>
      )}
      {sections.map((s, i) => (
        <section key={i} className="mt-6">
          {s.heading && <h2 className="text-[17px] font-semibold tracking-tight">{s.heading}</h2>}
          {asArray<string>(s.paragraphs).map((para, j) => (
            <p key={j} className="mt-2.5 whitespace-pre-wrap text-[13.5px] leading-[1.7] text-foreground/85">
              <InlineText text={para} base={base} />
            </p>
          ))}
        </section>
      ))}
      {faqs.length > 0 && (
        <section className="mt-8">
          <h2 className="text-[17px] font-semibold tracking-tight">Frequently asked questions</h2>
          <dl className="mt-1">
            {faqs.map((f, i) => (
              <div key={i} className="mt-3">
                <dt className="text-[13.5px] font-medium">{f.q}</dt>
                <dd className="mt-1 whitespace-pre-wrap text-[13.5px] leading-relaxed text-foreground/80">
                  <InlineText text={f.a} base={base} />
                </dd>
              </div>
            ))}
          </dl>
        </section>
      )}
      {sources.length > 0 && (
        <section className="mt-8 border-t border-border-soft pt-4">
          <SourceList sources={sources} />
        </section>
      )}
    </article>
  )
}

function LengthNote({ label, n, min, max }: { label: string; n: number; min: number; max: number }) {
  const ok = n >= min && n <= max
  return (
    <span
      className={cn('inline-flex items-center gap-1', ok ? 'text-muted-foreground' : 'text-warning')}
      title={`${min}–${max} characters reads best in search results`}
    >
      {!ok && <TriangleAlert className="h-3 w-3" />}
      {label} {n}/{max}
    </span>
  )
}

function SnippetPreview({ post: p, base }: { post: Partial<SeoPostFile>; base: string | null }) {
  const title = p.metaTitle || p.title || ''
  const desc = p.description || ''
  return (
    <div className="rounded-lg border border-border-soft bg-surface p-3">
      <p className="eyebrow mb-2 text-muted-foreground">In search results</p>
      <p className="truncate font-mono text-[11px] text-muted-foreground">
        {base ? hostOf(base) : 'site'} › blog › {p.slug ?? ''}
      </p>
      <p className="mt-0.5 text-[14px] leading-snug text-foreground">{title}</p>
      <p className="mt-1 text-[12px] leading-snug text-muted-foreground">{desc}</p>
      <p className="mt-2 flex flex-wrap gap-3 font-mono text-[10.5px]">
        <LengthNote label="title" n={title.length} min={30} max={65} />
        <LengthNote label="description" n={desc.length} min={70} max={160} />
      </p>
    </div>
  )
}

function GateList({ gates }: { gates: GateResult[] }) {
  if (gates.length === 0) return null
  const rank = (g: GateResult) => (g.ok ? 2 : g.blocking ? 0 : 1)
  const sorted = [...gates].sort((a, b) => rank(a) - rank(b))
  return (
    <div>
      <p className="eyebrow mb-2 text-muted-foreground">Content checks</p>
      <ul className="flex flex-col gap-2">
        {sorted.map((g, i) => (
          <li key={`${g.id}-${i}`} className="flex items-start gap-2">
            {g.ok ? (
              <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-label="Passed" />
            ) : g.blocking ? (
              <CircleX className="mt-0.5 h-3.5 w-3.5 shrink-0 text-destructive" aria-label="Failed, blocking" />
            ) : (
              <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warning" aria-label="Warning" />
            )}
            <span className="min-w-0">
              <span className={cn('font-mono text-[11.5px]', g.ok ? 'text-muted-foreground' : 'text-foreground')}>
                {g.id}
                {!g.ok && g.blocking && <span className="eyebrow ml-1.5 text-destructive">blocking</span>}
              </span>
              {g.detail && <span className="block break-words text-[12px] leading-snug text-muted-foreground">{g.detail}</span>}
            </span>
          </li>
        ))}
      </ul>
    </div>
  )
}

function PostMeta({ post: p }: { post: Partial<SeoPostFile> }) {
  const rows: [string, string | null | undefined][] = [
    ['Keyword', p.primaryKeyword],
    ['Service', p.serviceSlug ? `/services/${p.serviceSlug}` : null],
    ['Author', p.author],
    ['Date', p.date ? dayLabel(p.date, true) : null],
    ['Read time', p.readTime],
  ]
  return (
    <dl className="grid grid-cols-2 gap-x-4 gap-y-2.5 border-t border-border-soft pt-3">
      {rows.map(([label, value]) => (
        <div key={label} className="min-w-0">
          <dt className="eyebrow text-muted-foreground/80">{label}</dt>
          <dd className="mt-0.5 truncate text-[12.5px] text-foreground/85" title={value ?? undefined}>
            {value || '—'}
          </dd>
        </div>
      ))}
    </dl>
  )
}

/* -------------------------------------------------------------------------- */
/*  Audit                                                                     */
/* -------------------------------------------------------------------------- */

function AuditTab({ run, findings, base }: { run: SeoRunDetail; findings: Finding[]; base: string | null }) {
  const audit = run.audit
  if (!audit && !run.crawl && !run.psi && !run.gsc) {
    return (
      <Empty>
        {isMoving(run.status) ? 'The audit shows up once the site has been crawled.' : 'This run has no audit.'}
      </Empty>
    )
  }
  const counts = audit?.counts
  return (
    <div className="flex flex-col gap-6">
      {audit && (
        <div className="grid grid-cols-2 gap-4 md:grid-cols-3 lg:grid-cols-5">
          <StatTile label="Score" value={Math.round(audit.score)} sub={`${audit.pagesCrawled ?? 0} pages crawled`} />
          <StatTile label="P0 · critical" value={counts?.P0 ?? 0} sub="fix first" />
          <StatTile label="P1 · important" value={counts?.P1 ?? 0} sub="fix this month" />
          <StatTile label="P2 · polish" value={counts?.P2 ?? 0} sub="when there’s time" />
          <StatTile label="Passing" value={counts?.pass ?? 0} sub={`of ${findings.length} checks`} />
        </div>
      )}
      {run.psi && <PsiCard psi={run.psi} />}
      {audit && <FindingsCard findings={findings} base={base} />}
      <GscCard gsc={run.gsc} base={base} />
      {run.crawl && <CrawlCard crawl={run.crawl} />}
    </div>
  )
}

type FindingFilter = 'issues' | 'fail' | 'warn' | 'pass' | 'all'

function FindingsCard({ findings, base }: { findings: Finding[]; base: string | null }) {
  const [filter, setFilter] = useState<FindingFilter>('issues')
  const n = {
    issues: findings.filter((f) => f.status !== 'pass').length,
    fail: findings.filter((f) => f.status === 'fail').length,
    warn: findings.filter((f) => f.status === 'warn').length,
    pass: findings.filter((f) => f.status === 'pass').length,
    all: findings.length,
  }
  const shown = findings.filter((f) =>
    filter === 'all' ? true : filter === 'issues' ? f.status !== 'pass' : f.status === filter,
  )
  const statusRank = { fail: 0, warn: 1, pass: 2 } as Record<string, number>
  const groups = (['P0', 'P1', 'P2'] as FindingSeverity[])
    .map((sev) => ({
      sev,
      items: shown.filter((f) => f.severity === sev).sort((a, b) => (statusRank[a.status] ?? 3) - (statusRank[b.status] ?? 3)),
    }))
    .filter((g) => g.items.length > 0)

  return (
    <Card
      title="Findings"
      hint={`${findings.length} checks`}
      bodyClassName="p-0"
      actions={
        <Segmented<FindingFilter>
          size="sm"
          value={filter}
          onChange={setFilter}
          options={[
            { value: 'issues', label: `Issues ${n.issues}` },
            { value: 'fail', label: `Failing ${n.fail}` },
            { value: 'warn', label: `Warnings ${n.warn}` },
            { value: 'pass', label: `Passing ${n.pass}` },
            { value: 'all', label: 'All' },
          ]}
        />
      }
    >
      {groups.length === 0 ? (
        <p className="p-6 text-center text-[13px] text-muted-foreground">
          {filter === 'issues' || filter === 'fail' ? 'Nothing failing.' : 'Nothing here.'}
        </p>
      ) : (
        groups.map((g) => (
          <div key={g.sev}>
            <p className="eyebrow flex items-center gap-2 border-b border-t border-border-soft bg-surface-muted/60 px-4 py-2 text-muted-foreground first:border-t-0">
              <SeverityChip severity={g.sev} /> {SEVERITY_LABEL[g.sev]} · {g.items.length}
            </p>
            {g.items.map((f, i) => (
              <FindingRow key={`${f.id}-${i}`} finding={f} base={base} />
            ))}
          </div>
        ))
      )}
    </Card>
  )
}

function FindingRow({ finding: f, base }: { finding: Finding; base: string | null }) {
  const urls = asArray<string>(f.urls)
  return (
    <details className="group border-b border-border-soft last:border-b-0">
      <summary className="flex cursor-pointer list-none items-start gap-3 px-4 py-2.5 transition hover:bg-surface-muted [&::-webkit-details-marker]:hidden">
        {f.status === 'fail' ? (
          <CircleX className="mt-0.5 h-4 w-4 shrink-0 text-destructive" aria-label="Failing" />
        ) : f.status === 'warn' ? (
          <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0 text-warning" aria-label="Warning" />
        ) : (
          <Check className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-label="Passing" />
        )}
        <div className="min-w-0 flex-1">
          <p className={cn('text-[13px]', f.status === 'pass' ? 'text-muted-foreground' : 'font-medium')}>{f.title}</p>
          <p className="font-mono text-[10.5px] text-muted-foreground/70">{f.id}</p>
        </div>
        {f.fixableByBot && f.status !== 'pass' && (
          <span
            className="eyebrow hidden shrink-0 items-center gap-1 rounded border border-border px-1.5 py-0.5 text-muted-foreground sm:inline-flex"
            title="The engine fixes this itself once the SEO foundation is installed"
          >
            <Bot className="h-3 w-3" /> Engine can fix
          </span>
        )}
        {urls.length > 0 && (
          <span className="shrink-0 font-mono text-[11px] text-muted-foreground">
            {urls.length} URL{urls.length === 1 ? '' : 's'}
          </span>
        )}
        <ChevronRight className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground transition group-open:rotate-90" />
      </summary>
      <div className="flex flex-col gap-2 px-4 pb-3.5 pl-11 text-[13px] leading-relaxed">
        {f.detail && <p className="whitespace-pre-wrap text-foreground/85">{f.detail}</p>}
        {f.fix && (
          <p className="whitespace-pre-wrap text-muted-foreground">
            <span className="eyebrow mr-2 text-foreground/70">Fix</span>
            {f.fix}
          </p>
        )}
        {urls.length > 0 && <UrlList urls={urls} base={base} />}
      </div>
    </details>
  )
}

function UrlItem({ url, base }: { url: string; base: string | null }) {
  const href = safeLink(url, base)
  if (!href || !/^https?:/i.test(href)) return <span className="break-all font-mono text-[12px] text-muted-foreground">{url}</span>
  // Same-host URLs read better as paths; anything else keeps its host.
  const sameHost = base && hostOf(href) === hostOf(base)
  return (
    <ExtLink href={href} className="max-w-full font-mono text-[12px]" title={href}>
      {sameHost ? pathOf(href) : href.replace(/^https?:\/\//, '')}
    </ExtLink>
  )
}

function UrlList({ urls, base }: { urls: string[]; base: string | null }) {
  const head = urls.slice(0, 8)
  const rest = urls.slice(8)
  return (
    <div>
      <ul className="flex flex-col gap-1">
        {head.map((u, i) => (
          <li key={`${u}-${i}`} className="min-w-0">
            <UrlItem url={u} base={base} />
          </li>
        ))}
      </ul>
      {rest.length > 0 && (
        <details className="mt-1">
          <summary className="cursor-pointer text-[12px] text-muted-foreground hover:text-foreground">
            {rest.length} more
          </summary>
          <ul className="mt-1 flex flex-col gap-1">
            {rest.map((u, i) => (
              <li key={`${u}-${i}`} className="min-w-0">
                <UrlItem url={u} base={base} />
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  )
}

type Band = 'good' | 'ok' | 'poor'

/** Core Web Vitals-style bands: [good ≤ a, needs work ≤ b, else poor]. */
function band(v: number | null | undefined, a: number, b: number): Band | null {
  if (typeof v !== 'number' || !Number.isFinite(v)) return null
  return v <= a ? 'good' : v <= b ? 'ok' : 'poor'
}

function Metric({ label, value, b }: { label: string; value: string; b: Band | null }) {
  return (
    <div className="flex items-center gap-2">
      <span
        className={cn(
          'h-1.5 w-1.5 shrink-0 rounded-full',
          b === 'good' ? 'bg-success' : b === 'ok' ? 'bg-warning' : b === 'poor' ? 'bg-destructive' : 'bg-muted-foreground/40',
        )}
        aria-hidden
      />
      <span className="eyebrow text-muted-foreground">{label}</span>
      <span className="font-mono text-[12.5px] tabular-nums text-foreground/90">{value}</span>
      {b && <span className="sr-only">{b === 'good' ? 'good' : b === 'ok' ? 'needs improvement' : 'poor'}</span>}
    </div>
  )
}

const secs = (ms: number | null | undefined) => (typeof ms === 'number' && Number.isFinite(ms) ? `${(ms / 1000).toFixed(1)} s` : '—')
const millis = (ms: number | null | undefined) => (typeof ms === 'number' && Number.isFinite(ms) ? `${Math.round(ms)} ms` : '—')
const cls = (v: number | null | undefined) => (typeof v === 'number' && Number.isFinite(v) ? v.toFixed(3) : '—')

function PsiCard({ psi }: { psi: PsiResult }) {
  const scores: [string, number | null][] = [
    ['Performance', score100(psi.scores?.performance)],
    ['SEO', score100(psi.scores?.seo)],
    ['Accessibility', score100(psi.scores?.accessibility)],
    ['Best practices', score100(psi.scores?.bestPractices)],
  ]
  const lab = psi.lab
  const field = psi.field
  return (
    <Card title="PageSpeed · mobile" hint={[hostOf(psi.url), psi.fetchedAt && fromIso(psi.fetchedAt)].filter(Boolean).join(' · ')}>
      {psi.error && <p className="mb-4 text-[12.5px] text-warning">PageSpeed Insights: {psi.error}</p>}
      <div className="grid grid-cols-2 gap-5 md:grid-cols-4">
        {scores.map(([label, v]) => (
          <div key={label}>
            <p className="eyebrow text-muted-foreground">{label}</p>
            <p className="mt-1.5 font-mono text-[26px] font-medium leading-none tabular-nums">{v ?? '—'}</p>
            <div className="mt-2.5">
              <Meter value={v} />
            </div>
          </div>
        ))}
      </div>
      {lab && (
        <div className="mt-5 flex flex-wrap gap-x-6 gap-y-2 border-t border-border-soft pt-3">
          <span className="eyebrow text-muted-foreground/70">Lab</span>
          <Metric label="LCP" value={secs(lab.lcpMs)} b={band(lab.lcpMs, 2500, 4000)} />
          <Metric label="CLS" value={cls(lab.cls)} b={band(lab.cls, 0.1, 0.25)} />
          <Metric label="TBT" value={millis(lab.tbtMs)} b={band(lab.tbtMs, 200, 600)} />
          <Metric label="FCP" value={secs(lab.fcpMs)} b={band(lab.fcpMs, 1800, 3000)} />
          <Metric label="Speed index" value={secs(lab.speedIndexMs)} b={band(lab.speedIndexMs, 3400, 5800)} />
        </div>
      )}
      {field && (
        <div className="mt-3 flex flex-wrap gap-x-6 gap-y-2 border-t border-border-soft pt-3">
          <span className="eyebrow text-muted-foreground/70">Real users</span>
          <Metric label="LCP" value={secs(field.lcpMs)} b={band(field.lcpMs, 2500, 4000)} />
          <Metric label="INP" value={millis(field.inpMs)} b={band(field.inpMs, 200, 500)} />
          <Metric label="CLS" value={cls(field.cls)} b={band(field.cls, 0.1, 0.25)} />
          {field.category && <span className="font-mono text-[12px] text-muted-foreground">{field.category.toLowerCase()}</span>}
        </div>
      )}
    </Card>
  )
}

const pct = (v: number | null | undefined) => (typeof v === 'number' && Number.isFinite(v) ? `${(v * 100).toFixed(1)}%` : '—')

function GscCard({ gsc, base }: { gsc: GscSummary | null; base: string | null }) {
  if (!gsc) {
    return (
      <Card title="Search Console">
        <p className="text-[13px] text-muted-foreground">
          No Search Console data on this run. Connect the service account in SEO → Setup, add it as a user on the site’s
          property, and set the property in the site’s settings. Queries, clicks and striking-distance keywords then show
          up here.
        </p>
      </Card>
    )
  }
  if (gsc.error) {
    return (
      <Card title="Search Console" hint={gsc.property}>
        <p className="text-[13px] text-warning">{gsc.error}</p>
      </Card>
    )
  }
  const t = gsc.totals
  const p = gsc.prior
  return (
    <Card
      title="Search Console"
      hint={`${gsc.property} · ${dayLabel(gsc.range?.start)} – ${dayLabel(gsc.range?.end)} vs the 28 days before`}
    >
      <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
        <StatTile label="Clicks" value={num(t?.clicks)} extra={<Delta value={(t?.clicks ?? 0) - (p?.clicks ?? 0)} />} />
        <StatTile label="Impressions" value={num(t?.impressions)} extra={<Delta value={(t?.impressions ?? 0) - (p?.impressions ?? 0)} />} />
        <StatTile label="CTR" value={pct(t?.ctr)} extra={<Delta value={((t?.ctr ?? 0) - (p?.ctr ?? 0)) * 100} digits={1} suffix=" pt" />} />
        <StatTile
          label="Avg position"
          value={num(t?.position, 1)}
          extra={<Delta value={(t?.position ?? 0) - (p?.position ?? 0)} higherIsBetter={false} digits={1} />}
        />
      </div>
      <div className="mt-5 grid gap-5 xl:grid-cols-2">
        <GscTable title="Top queries" rows={asArray<GscRow>(gsc.topQueries)} base={base} />
        <GscTable title="Striking distance" rows={asArray<GscRow & { opportunity: number }>(gsc.striking)} base={base} striking />
      </div>
    </Card>
  )
}

function GscTable({
  title,
  rows,
  base,
  striking,
}: {
  title: string
  rows: (GscRow & { opportunity?: number })[]
  base: string | null
  striking?: boolean
}) {
  const [limit, setLimit] = useState(10)
  return (
    <div className="min-w-0">
      <p className="eyebrow mb-2 text-muted-foreground">
        {title}
        {striking && <span className="ml-2 normal-case tracking-normal text-muted-foreground/70">positions 4–20, most to gain first</span>}
      </p>
      {rows.length === 0 ? (
        <p className="text-[12.5px] text-muted-foreground">No rows.</p>
      ) : (
        <>
          <Table
            head={
              <>
                <th className={thClass}>Query</th>
                <th className={cn(thClass, 'text-right')}>{striking ? 'Pos.' : 'Clicks'}</th>
                <th className={cn(thClass, 'text-right')}>Impr.</th>
                <th className={cn(thClass, 'text-right')}>{striking ? 'Gain' : 'Pos.'}</th>
              </>
            }
          >
            {rows.slice(0, limit).map((r, i) => (
              <tr key={`${r.query}-${r.page}-${i}`} className="border-t border-border-soft">
                <td className={cn(tdClass, 'max-w-[18rem]')}>
                  <p className="truncate" title={r.query ?? undefined}>
                    {r.query ?? '—'}
                  </p>
                  {r.page && (
                    <p className="truncate font-mono text-[11px] text-muted-foreground" title={r.page}>
                      {base && hostOf(r.page) === hostOf(base) ? pathOf(r.page) : r.page}
                    </p>
                  )}
                </td>
                <td className={cn(tdClass, 'text-right font-mono tabular-nums')}>
                  {striking ? num(r.position, 1) : num(r.clicks)}
                </td>
                <td className={cn(tdClass, 'text-right font-mono tabular-nums text-muted-foreground')}>{num(r.impressions)}</td>
                <td className={cn(tdClass, 'text-right font-mono tabular-nums')} title={striking ? 'Estimated extra clicks per 28 days at a better position' : undefined}>
                  {striking ? `+${num(r.opportunity, 0)}` : num(r.position, 1)}
                </td>
              </tr>
            ))}
          </Table>
          <ShowMore shown={Math.min(limit, rows.length)} total={rows.length} onMore={() => setLimit((l) => l + 15)} />
        </>
      )}
    </div>
  )
}

/** Host with its www — hostOf() drops it, which would hide the whole point of the twin check. */
function exactHost(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

function CrawlCard({ crawl }: { crawl: CrawlView }) {
  const [limit, setLimit] = useState(25)
  const pages = asArray<CrawlView['pages'][number]>(crawl.pages)
  const rootAllowed = crawl.robots?.rootAllowed ?? {}
  const blocked = Object.entries(rootAllowed)
    .filter(([, ok]) => !ok)
    .map(([bot]) => bot)
  const sm = crawl.sitemap
  const smUrls = asArray<string>(sm?.urls)
  const redirectOk = (s: number | null | undefined) => typeof s === 'number' && s >= 300 && s < 400
  const httpsOk =
    !!crawl.httpToHttps && redirectOk(crawl.httpToHttps.status) && /^https:/i.test(crawl.httpToHttps.location ?? '')

  const checks: { label: string; ok: boolean | null; value: React.ReactNode }[] = [
    {
      label: 'robots.txt',
      ok: crawl.robots?.status === 200 ? blocked.length === 0 : false,
      value:
        crawl.robots?.status == null
          ? 'no response'
          : `${crawl.robots.status}${
              Object.keys(rootAllowed).length === 0
                ? ''
                : blocked.length
                  ? ` · blocks ${blocked.join(', ')}`
                  : ' · every key crawler allowed'
            }`,
    },
    {
      label: 'Sitemap',
      ok: sm?.status === 200 && smUrls.length > 0 && !sm?.error,
      value: sm?.url ? `${pathOf(sm.url)} · ${sm.status ?? 'no response'} · ${smUrls.length} URLs${sm.error ? ` · ${sm.error}` : ''}` : sm?.error || 'not found',
    },
    {
      label: 'llms.txt',
      ok: crawl.llmsTxt?.status === 200 ? true : null,
      value: crawl.llmsTxt?.status === 200 ? 'present' : crawl.llmsTxt?.status ? `missing (${crawl.llmsTxt.status})` : 'missing',
    },
    {
      label: 'Unknown page',
      ok: crawl.soft404?.status === 404 || crawl.soft404?.status === 410,
      value: crawl.soft404
        ? `${crawl.soft404.status ?? 'no response'}${crawl.soft404.status === 200 ? ' — a soft 404: missing pages look real to Google' : ''}`
        : '—',
    },
    {
      label: 'http → https',
      ok: crawl.httpToHttps ? httpsOk : null,
      value: crawl.httpToHttps
        ? `${crawl.httpToHttps.status ?? 'no response'}${crawl.httpToHttps.location ? ` → ${crawl.httpToHttps.location}` : ''}`
        : 'not checked',
    },
    {
      label: 'www twin',
      ok: crawl.hostTwin ? redirectOk(crawl.hostTwin.status) || crawl.hostTwin.status === null : null,
      value: crawl.hostTwin
        ? `${exactHost(crawl.hostTwin.url)} → ${crawl.hostTwin.location ? exactHost(crawl.hostTwin.location) : (crawl.hostTwin.status ?? 'no response')}`
        : 'not checked',
    },
  ]

  return (
    <Card title="Crawl" hint={`${pages.length} pages · ${fromIso(crawl.fetchedAt)}`}>
      <dl className="grid gap-x-8 gap-y-3 sm:grid-cols-2 lg:grid-cols-3">
        {checks.map((c) => (
          <div key={c.label} className="flex min-w-0 items-start gap-2">
            {c.ok === true ? (
              <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-label="OK" />
            ) : c.ok === false ? (
              <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warning" aria-label="Problem" />
            ) : (
              <Minus className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground/50" aria-label="Info" />
            )}
            <div className="min-w-0">
              <dt className="eyebrow text-muted-foreground/80">{c.label}</dt>
              <dd className="mt-0.5 break-words font-mono text-[12px] text-foreground/85">{c.value}</dd>
            </div>
          </div>
        ))}
      </dl>

      {asArray<string>(crawl.errors).length > 0 && (
        <div className="mt-4 rounded-lg border border-warning/30 bg-warning/10 p-3">
          <p className="eyebrow mb-1 text-warning">Crawl errors</p>
          <ul className="flex flex-col gap-0.5 font-mono text-[12px] text-warning">
            {asArray<string>(crawl.errors).map((e, i) => (
              <li key={i} className="break-words">
                {e}
              </li>
            ))}
          </ul>
        </div>
      )}

      {pages.length > 0 && (
        <div className="mt-5">
          <Table
            minWidth="min-w-[56rem]"
            head={
              <>
                <th className={thClass}>Page</th>
                <th className={cn(thClass, 'text-right')}>Status</th>
                <th className={cn(thClass, 'text-right')}>Words</th>
                <th className={cn(thClass, 'text-right')}>Time</th>
                <th className={thClass}>Title · H1</th>
                <th className={thClass}>Schema</th>
              </>
            }
          >
            {pages.slice(0, limit).map((pg, i) => (
              <tr key={`${pg.url}-${i}`} className="border-t border-border-soft align-top">
                <td className={cn(tdClass, 'max-w-[16rem]')}>
                  <UrlItem url={pg.url} base={crawl.origin} />
                </td>
                <td className={cn(tdClass, 'text-right font-mono tabular-nums', pg.status >= 400 || pg.status === 0 ? 'text-destructive' : 'text-muted-foreground')}>
                  {pg.status || 'err'}
                </td>
                <td className={cn(tdClass, 'text-right font-mono tabular-nums', pg.wordCount < 300 ? 'text-warning' : 'text-foreground/85')}>
                  {num(pg.wordCount)}
                </td>
                <td className={cn(tdClass, 'text-right font-mono tabular-nums text-muted-foreground')}>{num(pg.ms)} ms</td>
                <td className={cn(tdClass, 'max-w-[22rem]')}>
                  <p className="truncate" title={pg.title ?? undefined}>
                    {pg.title ?? <span className="text-destructive/90">no title</span>}
                  </p>
                  <p className="truncate text-[11.5px] text-muted-foreground" title={pg.h1 ?? undefined}>
                    {pg.h1 ?? 'no H1'}
                  </p>
                </td>
                <td className={cn(tdClass, 'max-w-[14rem]')}>
                  <p className="truncate font-mono text-[11px] text-muted-foreground" title={asArray<string>(pg.jsonLdTypes).join(', ')}>
                    {asArray<string>(pg.jsonLdTypes).join(', ') || '—'}
                  </p>
                </td>
              </tr>
            ))}
          </Table>
          <ShowMore shown={Math.min(limit, pages.length)} total={pages.length} onMore={() => setLimit((l) => l + 25)} />
        </div>
      )}
    </Card>
  )
}

/* -------------------------------------------------------------------------- */
/*  Changes                                                                   */
/* -------------------------------------------------------------------------- */

function ChangesTab({ run, changes, site }: { run: SeoRunDetail; changes: ChangeFile[]; site: SeoSiteDetail | null }) {
  const repo = run.repoFullName
  const rows: [string, React.ReactNode][] = [
    ['Repo', repo ? <ExtLink href={githubUrl(repo)} className="font-mono">{repo}</ExtLink> : 'none — audit only'],
    [
      'Branch',
      run.branch && repo ? (
        <ExtLink href={githubUrl(repo, 'tree', run.branch)} className="font-mono">
          {run.branch}
        </ExtLink>
      ) : (
        (run.branch ?? '—')
      ),
    ],
    [
      'Commit',
      run.commitSha && repo ? (
        <ExtLink href={githubUrl(repo, 'commit', run.commitSha)} className="font-mono">
          {run.commitSha.slice(0, 7)}
        </ExtLink>
      ) : (
        '—'
      ),
    ],
    [
      'Pull request',
      run.prUrl ? (
        <ExtLink href={run.prUrl} className="font-mono">
          {run.prNumber ? `#${run.prNumber}` : 'Open'}
        </ExtLink>
      ) : (
        '—'
      ),
    ],
    ['Build check', <CiPill key="ci" status={run.ciStatus} />],
    ['Merged', run.mergedAt ? fromIso(run.mergedAt) : '—'],
    ['Published', run.publishedAt ? fromIso(run.publishedAt) : '—'],
  ]
  const created = changes.filter((c) => !c.existed).length

  return (
    <div className="flex flex-col gap-6">
      <Card title="Repository">
        <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-2 lg:grid-cols-4">
          {rows.map(([label, value]) => (
            <div key={label} className="min-w-0">
              <dt className="eyebrow text-muted-foreground/80">{label}</dt>
              <dd className="mt-1 truncate text-[13px] text-foreground/90">{value}</dd>
            </div>
          ))}
        </dl>
      </Card>

      {changes.length === 0 ? (
        <Empty>
          {!repo
            ? 'No repo linked, so this run only audits, plans and drafts.'
            : isMoving(run.status)
              ? 'File changes show up once the run reaches the commit stage.'
              : 'No file changes this run.'}
        </Empty>
      ) : (
        <section className="flex flex-col gap-3">
          <h2 className="eyebrow text-muted-foreground">
            Files · {changes.length} · {created} new, {changes.length - created} updated
          </h2>
          <div className="flex flex-col gap-2">
            {changes.map((c, i) => (
              <ChangeRow key={`${c.path}-${i}`} change={c} repo={repo} branch={run.branch ?? site?.defaultBranch ?? null} />
            ))}
          </div>
        </section>
      )}
    </div>
  )
}

function ChangeRow({ change: c, repo, branch }: { change: ChangeFile; repo: string | null; branch: string | null }) {
  // Content renders only while open — a foundation PR can carry dozens of files.
  const [open, setOpen] = useState(false)
  const content = typeof c.content === 'string' ? c.content : ''
  const lineCount = content ? content.split('\n').length : 0
  const Icon = c.existed ? FilePen : FilePlus
  return (
    <details
      onToggle={(e) => setOpen(e.currentTarget.open)}
      className="group rounded-xl border border-border bg-card"
    >
      <summary className="flex cursor-pointer list-none flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5 [&::-webkit-details-marker]:hidden">
        <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground transition group-open:rotate-90" />
        <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 break-all font-mono text-[12.5px]">{c.path}</span>
        <span className={cn('eyebrow rounded px-1.5 py-0.5', c.existed ? 'bg-muted text-muted-foreground' : 'border border-foreground/30 text-foreground')}>
          {c.existed ? 'Updated' : 'New'}
        </span>
        <span className="min-w-0 flex-1 basis-[10rem] truncate text-[12px] text-muted-foreground" title={c.reason}>
          {c.reason}
        </span>
        <span className="shrink-0 font-mono text-[11px] text-muted-foreground">{lineCount} lines</span>
      </summary>
      {open && (
        <div className="border-t border-border-soft">
          <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-2">
            <p className="text-[12px] text-muted-foreground">{c.reason}</p>
            <span className="flex items-center gap-2">
              {repo && branch && (
                <ExtLink href={githubUrl(repo, 'blob', branch, c.path)} className="text-[12px]">
                  On GitHub
                </ExtLink>
              )}
              <CopyButton value={content} label="Copy" />
            </span>
          </div>
          <pre className="max-h-[32rem] overflow-auto border-t border-border-soft bg-surface px-4 py-3 font-mono text-[12px] leading-relaxed text-foreground/85">
            {content || '(empty file)'}
          </pre>
        </div>
      )}
    </details>
  )
}

/* -------------------------------------------------------------------------- */
/*  Research                                                                  */
/* -------------------------------------------------------------------------- */

function ResearchTab({ run, base }: { run: SeoRunDetail; base: string | null }) {
  const r = run.research
  if (!r) {
    return (
      <Empty>
        {isMoving(run.status) ? 'Research shows up once the run reaches the research stage.' : 'This run has no research.'}
      </Empty>
    )
  }
  const sources = asArray<{ url: string; title: string }>(r.sources)
  const seen = new Set<string>()
  const unique = sources.filter((s) => {
    const k = (s.url ?? '').replace(/\/$/, '')
    if (!k || seen.has(k)) return false
    seen.add(k)
    return true
  })
  const errors = asArray<string>(r.toolErrors)

  return (
    <div className="flex flex-col gap-4">
      {errors.length > 0 && (
        <div className="rounded-xl border border-warning/30 bg-warning/10 p-3 text-[12.5px] text-warning">
          <p className="eyebrow mb-1">Tool errors during research</p>
          <ul className="flex flex-col gap-0.5">
            {errors.map((e, i) => (
              <li key={i} className="break-words">
                {e}
              </li>
            ))}
          </ul>
        </div>
      )}
      <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <Card title="Digest">
          {r.digest ? (
            <div className="whitespace-pre-wrap break-words text-[13px] leading-relaxed text-foreground/85">
              <InlineText text={r.digest} base={base} />
            </div>
          ) : (
            <p className="text-[13px] text-muted-foreground">No digest.</p>
          )}
        </Card>
        <Card title="Sources" hint={`${unique.length}`}>
          {unique.length === 0 ? (
            <p className="text-[13px] text-muted-foreground">No sources.</p>
          ) : (
            <ol className="flex flex-col gap-2.5">
              {unique.map((s, i) => {
                const href = safeLink(s.url)
                return (
                  <li key={`${s.url}-${i}`} className="flex min-w-0 gap-2 text-[12.5px]">
                    <span className="w-5 shrink-0 text-right font-mono text-[11px] text-muted-foreground">{i + 1}</span>
                    <span className="min-w-0">
                      {href ? (
                        <ExtLink href={href} className="max-w-full" title={s.url}>
                          {s.title || hostOf(href)}
                        </ExtLink>
                      ) : (
                        <span>{s.title || s.url}</span>
                      )}
                      <span className="block truncate font-mono text-[11px] text-muted-foreground">{hostOf(s.url)}</span>
                    </span>
                  </li>
                )
              })}
            </ol>
          )}
        </Card>
      </div>
    </div>
  )
}

/* -------------------------------------------------------------------------- */
/*  Log                                                                       */
/* -------------------------------------------------------------------------- */

function clock(iso: string): string {
  const d = new Date(iso)
  return Number.isNaN(d.getTime())
    ? '—'
    : d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', second: '2-digit' })
}

function offset(iso: string, startMs: number | null): string | undefined {
  const t = new Date(iso).getTime()
  if (startMs === null || Number.isNaN(t)) return undefined
  const s = Math.max(0, Math.round((t - startMs) / 1000))
  return `+${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')} into the run`
}

const compact = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 })

function LogTab({ run, log, drafts }: { run: SeoRunDetail; log: RunLogEntry[]; drafts: Draft[] }) {
  const [level, setLevel] = useState<'all' | 'problems'>('all')
  const problems = log.filter((e) => e.level !== 'info').length
  const shown = level === 'all' ? log : log.filter((e) => e.level !== 'info')
  const first = log.length ? new Date(log[0].at).getTime() : NaN
  const startMs = Number.isNaN(first) ? null : first

  return (
    <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_18rem]">
      <Card
        title="Log"
        hint={`${log.length} entries`}
        bodyClassName="p-0"
        actions={
          <Segmented
            size="sm"
            value={level}
            onChange={setLevel}
            options={[
              { value: 'all', label: 'All' },
              { value: 'problems', label: `Warnings & errors ${problems}`, disabled: problems === 0 },
            ]}
          />
        }
      >
        {shown.length === 0 ? (
          <p className="p-6 text-center text-[13px] text-muted-foreground">
            {log.length === 0 ? 'Nothing logged yet.' : 'No warnings or errors.'}
          </p>
        ) : (
          <ol className="divide-y divide-border-soft">
            {shown.map((e, i) => (
              <li
                key={`${e.at}-${i}`}
                className={cn(
                  'grid grid-cols-[5.5rem_4.5rem_minmax(0,1fr)] gap-3 px-4 py-2',
                  e.level === 'error' && 'bg-destructive/[0.06]',
                  e.level === 'warn' && 'bg-warning/[0.05]',
                )}
              >
                <span className="font-mono text-[11.5px] tabular-nums text-muted-foreground" title={offset(e.at, startMs)}>
                  {clock(e.at)}
                </span>
                <span className="eyebrow truncate pt-px text-muted-foreground/80">{e.stage === 'engine' ? 'engine' : (STAGE_LABEL[e.stage] ?? e.stage)}</span>
                <span
                  className={cn(
                    'whitespace-pre-wrap break-words text-[12.5px] leading-relaxed',
                    e.level === 'error' ? 'text-destructive' : e.level === 'warn' ? 'text-warning' : 'text-foreground/85',
                  )}
                >
                  {e.msg}
                </span>
              </li>
            ))}
          </ol>
        )}
      </Card>
      <UsageCard usage={run.usage} costUsd={run.costUsd} drafts={drafts} />
    </div>
  )
}

function UsageCard({ usage, costUsd, drafts }: { usage: ClaudeUsage | null; costUsd: number; drafts: Draft[] }) {
  const rows: [string, number | null | undefined][] = [
    ['Claude calls', usage?.calls],
    ['Input tokens', usage?.inputTokens],
    ['Output tokens', usage?.outputTokens],
    ['Cache reads', usage?.cacheReadTokens],
    ['Cache writes', usage?.cacheWriteTokens],
    ['Web searches', usage?.webSearches],
    ['Web fetches', usage?.webFetches],
  ]
  return (
    <Card title="Usage" className="h-fit">
      <p className="font-mono text-[26px] font-medium leading-none tabular-nums">{usd(usage?.costUsd ?? costUsd)}</p>
      <p className="mt-2 text-xs text-muted-foreground">Claude spend on this run</p>
      <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-3 border-t border-border-soft pt-3">
        {rows.map(([label, v]) => (
          <div key={label}>
            <dt className="eyebrow text-muted-foreground/80">{label}</dt>
            <dd className="mt-0.5 font-mono text-[13px] tabular-nums" title={typeof v === 'number' ? v.toLocaleString('en-US') : undefined}>
              {typeof v === 'number' && Number.isFinite(v) ? compact.format(v) : '—'}
            </dd>
          </div>
        ))}
      </dl>
      {drafts.length > 0 && (
        <div className="mt-4 border-t border-border-soft pt-3">
          <p className="eyebrow mb-2 text-muted-foreground/80">Per draft</p>
          <ul className="flex flex-col gap-1.5">
            {drafts.map((d, i) => (
              <li key={d.post?.slug || i} className="flex items-baseline justify-between gap-3 text-[12px]">
                <span className="min-w-0 truncate text-muted-foreground" title={d.post?.title}>
                  {d.post?.title || 'Untitled'}
                </span>
                <span className="shrink-0 font-mono tabular-nums">{usd(d.costUsd)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </Card>
  )
}
