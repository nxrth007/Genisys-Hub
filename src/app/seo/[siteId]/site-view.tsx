'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useCallback, useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  Archive,
  ArrowUpRight,
  Building2,
  CheckCircle2,
  Circle,
  FolderGit2,
  GitPullRequest,
  Globe,
  Heart,
  Layers,
  LayoutDashboard,
  Loader2,
  Play,
  Plus,
  Save,
  Settings2,
  Sparkles,
  Trash2,
  Undo2,
  Upload,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { PageHeader } from '@/components/ui/page-header'
import type {
  SeoPostView,
  SeoRunSummary,
  SeoSiteDetail,
  SeoSiteDetailResponse,
  UpdateSiteBody,
} from '@/lib/seo/api-types'
import type { BusinessFacts, SeoMode } from '@/lib/seo/types'
import {
  btnDanger,
  btnGhost,
  btnPrimary,
  btnSecondary,
  btnSmall,
  Card,
  CopyButton,
  dayLabel,
  Delta,
  Empty,
  enc,
  ErrorBlock,
  ExtLink,
  fetchOverview,
  Field,
  fieldClass,
  FoundationBadge,
  githubUrl,
  hashString,
  hostOf,
  isMoving,
  LinkChip,
  LoadingBlock,
  lovableUrl,
  ModeChip,
  MODES,
  needsYou,
  normalizeUrl,
  Notice,
  type NoticeState,
  pathOf,
  platformLabel,
  pollEvery,
  PostStatusPill,
  RepoPicker,
  RunStatusPill,
  ScoreNumber,
  Segmented,
  seoFetch,
  seoKeys,
  SeverityChip,
  ShowMore,
  Sparkline,
  STAGE_LABEL,
  suggestRepo,
  Switch,
  Table,
  Tabs,
  tdClass,
  thClass,
  timeAgo,
  usd,
  useGithubRepos,
  useNow,
  useStartRun,
  weekLabel,
} from '../ui'
import { ClientAnswersCard, SourceChip } from './client-answers'

/**
 * SEO → one site.
 *
 * Overview is the weekly view: score trend, the run that needs you, the
 * run history and the post ledger. Business facts are the single source
 * of truth every post and schema block is written from, so they get their
 * own tab; Settings holds the wiring (repo, Search Console, Lovable).
 *
 * All three tabs stay mounted while you switch, so half-edited facts
 * survive a look at the runs.
 */

type TabKey = 'overview' | 'facts' | 'settings'

function useUpdateSite(siteId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (body: UpdateSiteBody) =>
      seoFetch<{ site: SeoSiteDetail }>(`/api/seo/sites/${enc(siteId)}`, { method: 'PATCH', body }),
    onSuccess: ({ site }) => {
      if (site) {
        qc.setQueryData<SeoSiteDetailResponse>(seoKeys.site(siteId), (old) => (old ? { ...old, site } : old))
      }
      qc.invalidateQueries({ queryKey: seoKeys.overview })
    },
  })
}

export function SiteView({ siteId }: { siteId: string }) {
  const now = useNow()
  const [tab, setTab] = useState<TabKey>('overview')
  const [notice, setNotice] = useState<NoticeState>(null)
  const start = useStartRun()

  const q = useQuery<SeoSiteDetailResponse>({
    queryKey: seoKeys.site(siteId),
    queryFn: ({ signal }) => seoFetch<SeoSiteDetailResponse>(`/api/seo/sites/${enc(siteId)}`, { signal }),
    refetchInterval: (query) => pollEvery((query.state.data?.runs ?? []).map((r) => r.status), 15_000),
  })

  const crumbs = [{ label: 'Genisys' }, { label: 'SEO', href: '/seo' }]

  if (q.isLoading) {
    return (
      <div className="mx-auto flex max-w-[1280px] flex-col gap-6">
        <PageHeader title="Site" breadcrumbs={[...crumbs, { label: '…' }]} />
        <LoadingBlock />
      </div>
    )
  }
  if (q.isError || !q.data?.site) {
    return (
      <div className="mx-auto flex max-w-[1280px] flex-col gap-6">
        <PageHeader title="Site" breadcrumbs={crumbs} />
        <ErrorBlock
          message={q.error instanceof Error ? q.error.message : 'Couldn’t load this site.'}
          onRetry={() => q.refetch()}
        />
        <Link href="/seo" className={cn(btnSecondary, 'self-start')}>
          Back to SEO
        </Link>
      </div>
    )
  }

  const { site } = q.data
  const runs = q.data.runs ?? []
  const posts = q.data.posts ?? []
  const moving = runs.some((r) => isMoving(r.status))
  const runBlocked = !site.liveUrl ? 'Add the live URL in Settings first' : moving ? 'A run is already in progress' : null

  function startRun(kind: 'weekly' | 'foundation') {
    setNotice(null)
    start.mutate(
      { siteId: site.id, kind },
      {
        onSuccess: ({ run }) =>
          setNotice({
            tone: 'ok',
            text: (
              <>
                {kind === 'foundation' ? 'Foundation install queued.' : 'Weekly run queued.'}{' '}
                {run?.id && (
                  <Link href={`/seo/runs/${run.id}`} className="font-medium underline underline-offset-2">
                    Follow it
                  </Link>
                )}
              </>
            ),
          }),
        onError: (e) => setNotice({ tone: 'err', text: e.message }),
      },
    )
  }

  const subtitle = [
    site.clientName ?? 'No client linked',
    platformLabel(site.platform),
    site.createdAt ? `added ${dayLabel(site.createdAt, true)}` : null,
  ]
    .filter(Boolean)
    .join(' · ')

  return (
    <div className="mx-auto flex max-w-[1280px] flex-col gap-6">
      <PageHeader
        title={site.name}
        subtitle={subtitle}
        breadcrumbs={[...crumbs, { label: site.name }]}
        actions={
          <button
            type="button"
            className={btnPrimary}
            disabled={start.isPending || !!runBlocked}
            title={runBlocked ?? 'Crawl, audit, plan and write this week’s content now'}
            onClick={() => startRun('weekly')}
          >
            {start.isPending && start.variables?.kind === 'weekly' ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Play className="h-4 w-4" />
            )}
            Run weekly now
          </button>
        }
      />

      <SiteLinks site={site} />
      <Notice notice={notice} onClose={() => setNotice(null)} />

      <Tabs<TabKey>
        value={tab}
        onChange={setTab}
        tabs={[
          { key: 'overview', label: 'Overview', icon: LayoutDashboard, count: runs.filter((r) => waitingOnYou(r, runs)).length, alert: true },
          { key: 'facts', label: 'Business facts', icon: Building2 },
          { key: 'settings', label: 'Settings', icon: Settings2 },
        ]}
      />

      <div className={cn('flex flex-col gap-6', tab !== 'overview' && 'hidden')}>
        <RunsNeedingYou runs={runs} now={now} />
        <div className="grid gap-4 lg:grid-cols-3">
          <ScoreCard runs={runs} className="lg:col-span-2" />
          <SiteControls site={site} posts={posts} onNotice={setNotice} />
        </div>
        <FoundationCard
          site={site}
          runs={runs}
          starting={start.isPending && start.variables?.kind === 'foundation'}
          onInstall={() => {
            if (
              window.confirm(
                `Open a pull request on ${site.repoFullName} that installs the SEO foundation?\n\nIt happens once. Nothing merges until you approve it on the run page and the build passes.`,
              )
            ) {
              startRun('foundation')
            }
          }}
          onOpenSettings={() => setTab('settings')}
        />
        <ReadinessCard site={site} onNotice={setNotice} />
        <RunsCard runs={runs} now={now} />
        <PostsCard posts={posts} now={now} />
      </div>

      <div className={cn('flex flex-col gap-4', tab !== 'facts' && 'hidden')}>
        <ClientAnswersCard site={site} now={now} />
        <FactsSection site={site} />
      </div>

      <div className={cn(tab !== 'settings' && 'hidden')}>
        <SettingsSection site={site} now={now} />
      </div>
    </div>
  )
}

/* -------------------------------------------------------------------------- */
/*  Header pieces                                                             */
/* -------------------------------------------------------------------------- */

function SiteLinks({ site }: { site: SeoSiteDetail }) {
  return (
    <div className="-mt-2 flex flex-wrap items-center gap-2">
      {site.liveUrl && (
        <LinkChip href={site.liveUrl} icon={Globe}>
          {hostOf(site.liveUrl)}
        </LinkChip>
      )}
      {site.repoFullName && (
        <LinkChip href={githubUrl(site.repoFullName)} icon={FolderGit2}>
          {site.repoFullName}
          {site.defaultBranch ? <span className="text-muted-foreground"> · {site.defaultBranch}</span> : null}
        </LinkChip>
      )}
      {site.lovableProjectId && (
        <LinkChip href={lovableUrl(site.lovableProjectId)} icon={Heart} title="Open the project in Lovable">
          Lovable project
        </LinkChip>
      )}
      {site.foundationPrUrl && site.foundationStatus !== 'installed' && (
        <LinkChip href={site.foundationPrUrl} icon={GitPullRequest}>
          Foundation PR
        </LinkChip>
      )}
      {site.clientId && (
        <Link
          href={`/clients?focus=${site.clientId}`}
          className="inline-flex items-center gap-1.5 rounded-md border border-border bg-surface px-2.5 py-1.5 font-mono text-[12px] text-foreground transition hover:border-foreground/30"
        >
          <Building2 className="h-3.5 w-3.5 text-muted-foreground" />
          {site.clientName ?? 'Client'}
        </Link>
      )}
      <span className="ml-1 flex items-center gap-2">
        <ModeChip mode={site.mode} />
        {!site.enabled && <span className="eyebrow text-muted-foreground">not scheduled</span>}
      </span>
    </div>
  )
}

/**
 * A run parked on a person. A failed run stops counting once a newer run
 * of the same kind has been started — the fresh run replaced it, and the
 * dashboard (which only looks at the latest run) has already moved on.
 */
function waitingOnYou(r: SeoRunSummary, runs: SeoRunSummary[]): boolean {
  if (!needsYou(r)) return false
  if (r.status !== 'failed') return true
  return !runs.some((o) => o.id !== r.id && o.kind === r.kind && o.createdAt > r.createdAt)
}

/** Runs parked on a person, or moving right now, with a direct link. */
function RunsNeedingYou({ runs, now }: { runs: SeoRunSummary[]; now: number }) {
  const rows = runs.filter((r) => waitingOnYou(r, runs) || isMoving(r.status) || r.hubPublishing).slice(0, 4)
  if (rows.length === 0) return null
  return (
    <div className="flex flex-col divide-y divide-border-soft rounded-xl border border-border bg-card">
      {rows.map((r) => (
        <Link
          key={r.id}
          href={`/seo/runs/${r.id}`}
          className="group flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5 transition hover:bg-surface-muted"
        >
          <RunStatusPill status={r.status} hubPublishing={r.hubPublishing} />
          <span className="text-[13px] font-medium">
            {r.kind === 'foundation' ? 'Foundation install' : weekLabel(r.weekOf)}
          </span>
          <span
            className={cn(
              'min-w-0 flex-1 basis-[14rem] truncate text-[13px]',
              r.status === 'failed' ? 'text-destructive/90' : 'text-muted-foreground',
            )}
          >
            {r.status === 'failed'
              ? r.error || 'Stopped with an error.'
              : r.status === 'running'
                ? `${STAGE_LABEL[r.stage] ?? r.stage}…`
                : r.headline || ''}
          </span>
          <span className="font-mono text-[11px] text-muted-foreground">{timeAgo(r.finishedAt ?? r.startedAt ?? r.createdAt, now)}</span>
          <ArrowUpRight className="h-3.5 w-3.5 text-muted-foreground group-hover:text-foreground" />
        </Link>
      ))}
    </div>
  )
}

/* -------------------------------------------------------------------------- */
/*  Overview cards                                                            */
/* -------------------------------------------------------------------------- */

function ScoreCard({ runs, className }: { runs: SeoRunSummary[]; className?: string }) {
  // Weekly runs only: a foundation run audits just a handful of pages with
  // no PageSpeed, so its score isn't comparable (the dashboard agrees).
  const scored = runs
    .filter((r) => r.kind === 'weekly' && typeof r.score === 'number' && Number.isFinite(r.score))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  const recent = scored.slice(-12)
  const latest = scored[scored.length - 1]
  const prev = scored[scored.length - 2]
  const counts = latest?.counts

  return (
    <Card title="Audit score" hint={recent.length > 1 ? `last ${recent.length} weekly runs` : undefined} className={className}>
      {latest ? (
        <div className="flex flex-col gap-5 sm:flex-row sm:items-end">
          <div className="shrink-0">
            <div className="flex items-baseline gap-1.5">
              <ScoreNumber score={latest.score} className="text-[48px]" />
              <span className="font-mono text-[13px] text-muted-foreground">/100</span>
            </div>
            <p className="mt-2 flex items-center gap-2 text-[12px] text-muted-foreground">
              {prev ? (
                <>
                  <Delta value={(latest.score as number) - (prev.score as number)} />
                  <span>vs {weekLabel(prev.weekOf)}</span>
                </>
              ) : (
                <span>First scored run · {weekLabel(latest.weekOf)}</span>
              )}
            </p>
            {counts && (
              <p className="mt-3 flex items-center gap-3 text-[12px] text-muted-foreground">
                {(['P0', 'P1', 'P2'] as const).map((sev) => (
                  <span key={sev} className="inline-flex items-center gap-1.5">
                    <SeverityChip severity={sev} />
                    <span className="font-mono tabular-nums text-foreground/85">{counts[sev] ?? 0}</span>
                  </span>
                ))}
                <span className="font-mono tabular-nums">{counts.pass ?? 0} passing</span>
              </p>
            )}
          </div>
          <div className="min-w-0 flex-1 pt-6 sm:pt-0">
            {recent.length > 1 ? (
              <Sparkline
                height={80}
                points={recent.map((r) => ({ value: r.score as number, label: weekLabel(r.weekOf) }))}
              />
            ) : (
              <p className="text-[12px] text-muted-foreground">The trend line appears after the second weekly run.</p>
            )}
          </div>
        </div>
      ) : (
        <p className="text-[13px] text-muted-foreground">
          No score yet. Each weekly run crawls the live site and audits it. The score shows up here after the first one.
        </p>
      )}
    </Card>
  )
}

function SiteControls({
  site,
  posts,
  onNotice,
}: {
  site: SeoSiteDetail
  posts: SeoPostView[]
  onNotice: (n: NoticeState) => void
}) {
  const update = useUpdateSite(site.id)
  const qc = useQueryClient()
  const blurb = MODES.find((m) => m.value === site.mode)?.blurb
  const lovableOn = !!site.readiness.steps.find((s) => s.id === 'publish')?.ok
  const publish = useMutation({
    mutationFn: () => seoFetch<{ url: string | null }>(`/api/seo/sites/${enc(site.id)}/publish`, { method: 'POST' }),
    onMutate: () => onNotice(null),
    onSuccess: ({ url }) => {
      onNotice({ tone: 'ok', text: `Published ${site.name} in Lovable${url ? ` — ${url}` : ''}. Give it a minute to reach the live site.` })
      qc.invalidateQueries({ queryKey: seoKeys.site(site.id) })
      qc.invalidateQueries({ queryKey: seoKeys.overview })
    },
    onError: (e: Error) => onNotice({ tone: 'err', text: e.message }),
  })

  function patch(body: UpdateSiteBody, ok: string) {
    onNotice(null)
    update.mutate(body, {
      onSuccess: () => onNotice({ tone: 'ok', text: ok }),
      onError: (e) => onNotice({ tone: 'err', text: e.message }),
    })
  }

  function setMode(m: SeoMode) {
    if (
      m === 'autopilot' &&
      !window.confirm(
        `Autopilot merges and publishes ${site.name}’s changes without anyone approving them, whenever every content check and the build pass.\n\nTurn Autopilot on?`,
      )
    ) {
      return
    }
    patch({ mode: m }, `${site.name} is now in ${MODES.find((x) => x.value === m)?.label ?? m} mode.`)
  }

  const live = posts.filter((p) => p.status === 'live').length
  const committed = posts.filter((p) => p.status === 'committed').length

  return (
    <Card title="Engine">
      <div className="flex flex-col gap-4">
        <div className="flex flex-col gap-2">
          <Segmented
            value={site.mode}
            disabled={update.isPending}
            onChange={setMode}
            options={MODES.map((m) => ({
              value: m.value,
              label: m.label,
              disabled: m.value !== 'audit' && !site.repoFullName,
              title: m.value !== 'audit' && !site.repoFullName ? 'Needs a linked GitHub repo' : m.blurb,
            }))}
          />
          <p className="text-[12px] leading-snug text-muted-foreground">{blurb}</p>
        </div>
        <div className="flex items-center justify-between gap-3 border-t border-border-soft pt-4">
          <div className="min-w-0">
            <p className="text-[13px] font-medium">Weekly runs</p>
            <p className="text-[12px] text-muted-foreground">
              {site.enabled ? 'In the weekly schedule.' : 'Skipped by the schedule. “Run weekly now” still works.'}
            </p>
          </div>
          <Switch
            on={site.enabled}
            busy={update.isPending}
            label="Include in the weekly schedule"
            onChange={(v) => patch({ enabled: v }, v ? 'Back in the weekly schedule.' : 'Taken out of the weekly schedule.')}
          />
        </div>
        {lovableOn && site.repoFullName && (
          <div className="flex items-center justify-between gap-3 border-t border-border-soft pt-4">
            <div className="min-w-0">
              <p className="text-[13px] font-medium">Publish in Lovable</p>
              <p className="text-[12px] text-muted-foreground">The Hub publishes after every merge on its own. This is for a fix that landed another way.</p>
            </div>
            <button
              type="button"
              className={btnSmall}
              disabled={publish.isPending}
              onClick={() => {
                if (window.confirm(`Publish ${site.name} in Lovable now?\n\nWhatever is in the Lovable project goes live — including edits made in Lovable since its last publish.`)) {
                  publish.mutate()
                }
              }}
            >
              {publish.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : <Upload className="h-3 w-3" />}
              Publish now
            </button>
          </div>
        )}
        <div className="grid grid-cols-3 gap-2 border-t border-border-soft pt-4 text-center">
          <MiniStat label="Live" value={live} />
          <MiniStat label="Committed" value={committed} />
          <MiniStat label="All posts" value={posts.filter((p) => p.status !== 'rejected').length} />
        </div>
      </div>
    </Card>
  )
}

function MiniStat({ label, value }: { label: string; value: number }) {
  return (
    <div>
      <p className="font-mono text-[18px] font-medium tabular-nums">{value}</p>
      <p className="eyebrow mt-0.5 text-muted-foreground">{label}</p>
    </div>
  )
}

function FoundationCard({
  site,
  runs,
  starting,
  onInstall,
  onOpenSettings,
}: {
  site: SeoSiteDetail
  runs: SeoRunSummary[]
  starting: boolean
  onInstall: () => void
  onOpenSettings: () => void
}) {
  if (!site.repoFullName || site.foundationStatus === 'installed') return null
  // Runs arrive newest first.
  const open = runs.find(
    (r) => r.kind === 'foundation' && (isMoving(r.status) || r.status === 'awaiting_review' || r.status === 'awaiting_publish'),
  )
  const offTemplate = site.platform !== 'lovable-tanstack' && site.platform !== 'unknown'

  return (
    <section className="rounded-xl border border-border bg-card p-4">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex min-w-0 flex-1 basis-[22rem] items-start gap-3">
          <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg border border-border bg-surface">
            <Layers className="h-4 w-4 text-muted-foreground" />
          </span>
          <div className="min-w-0">
            <p className="flex flex-wrap items-center gap-2 text-[14px] font-semibold">
              SEO foundation <FoundationBadge status={site.foundationStatus} />
            </p>
            <p className="mt-1 max-w-3xl text-[13px] leading-relaxed text-muted-foreground">
              Weekly runs only ever add post files under <code className="font-mono text-[12px] text-foreground/85">src/content/blog</code>.
              The foundation teaches the site to render them, publish a sitemap, describe itself to AI crawlers and check
              every build. It goes in once, as a single pull request on{' '}
              <span className="font-mono text-[12px] text-foreground/85">{site.repoFullName}</span> — nothing merges until
              you approve it on the run page. Until then, runs audit, plan and draft only.
            </p>
            {!site.liveUrl && (
              <p className="mt-2 text-[12.5px] text-warning">
                Set the live URL first — the sitemap and canonical tags are built from it.{' '}
                <button type="button" onClick={onOpenSettings} className="underline underline-offset-2">
                  Open settings
                </button>
              </p>
            )}
            {offTemplate && (
              <p className="mt-2 text-[12.5px] text-muted-foreground">
                This repo was detected as {platformLabel(site.platform)}, not Genisys’ Lovable template. The install run
                stops and says so if it can’t apply cleanly.
              </p>
            )}
          </div>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          {open ? (
            <Link href={`/seo/runs/${open.id}`} className={btnSecondary}>
              {open.status === 'awaiting_review' ? 'Review the PR' : 'Open the install run'}
              <ArrowUpRight className="h-3.5 w-3.5" />
            </Link>
          ) : (
            <>
              {site.foundationPrUrl && (
                <a href={site.foundationPrUrl} target="_blank" rel="noopener noreferrer" className={btnSecondary}>
                  <GitPullRequest className="h-3.5 w-3.5" /> Foundation PR
                </a>
              )}
              <button type="button" onClick={onInstall} disabled={starting || !site.liveUrl} className={btnPrimary}>
                {starting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Layers className="h-4 w-4" />}
                {site.foundationStatus === 'proposed' ? 'Propose again' : 'Install SEO foundation'}
              </button>
            </>
          )}
        </div>
      </div>
    </section>
  )
}

/**
 * The road to hands-off publishing. Required steps gate Autopilot; the
 * rest make it better. The button appears only once the site is ready.
 */
function ReadinessCard({ site, onNotice }: { site: SeoSiteDetail; onNotice: (n: NoticeState) => void }) {
  const update = useUpdateSite(site.id)
  const r = site.readiness
  if (!r) return null
  const required = r.steps.filter((s) => s.required)
  const optional = r.steps.filter((s) => !s.required)
  const done = required.filter((s) => s.ok).length
  const canOffer = r.ready && site.mode !== 'autopilot'

  function goAutopilot() {
    if (
      !window.confirm(
        `Autopilot merges and publishes ${site.name}’s weekly changes without anyone approving them, whenever every content check and the build pass.

Turn Autopilot on?`,
      )
    ) {
      return
    }
    onNotice(null)
    update.mutate(
      { mode: 'autopilot' },
      {
        onSuccess: () => onNotice({ tone: 'ok', text: `${site.name} is now on Autopilot.` }),
        onError: (e) => onNotice({ tone: 'err', text: e.message }),
      },
    )
  }

  const Step = ({ s }: { s: (typeof r.steps)[number] }) => (
    <li className="flex items-start gap-2.5 py-1.5">
      {s.ok ? (
        <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-success" />
      ) : (
        <Circle className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground/60" />
      )}
      <div className="min-w-0">
        <p className={cn('text-[13px] font-medium', !s.ok && 'text-foreground/85')}>{s.label}</p>
        <p className="text-[12px] leading-snug text-muted-foreground">{s.detail}</p>
      </div>
    </li>
  )

  return (
    <Card
      title={
        <span className="flex flex-wrap items-center gap-2">
          Automation
          <span className={cn('eyebrow rounded-md px-2 py-0.5', r.ready ? 'bg-success/15 text-success' : 'bg-muted text-muted-foreground')}>
            {site.mode === 'autopilot' ? 'Autopilot' : r.ready ? 'Ready for autopilot' : `${done} of ${required.length} required`}
          </span>
        </span>
      }
      hint="What it takes for this site to publish every week with nobody clicking."
      actions={
        canOffer && (
          <button type="button" onClick={goAutopilot} disabled={update.isPending} className={btnPrimary}>
            {update.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
            Switch to Autopilot
          </button>
        )
      }
    >
      <div className="grid gap-x-8 md:grid-cols-2">
        <div>
          <p className="eyebrow mb-1 text-muted-foreground">Required</p>
          <ul className="divide-y divide-border-soft">
            {required.map((s) => (
              <Step key={s.id} s={s} />
            ))}
          </ul>
        </div>
        <div>
          <p className="eyebrow mb-1 text-muted-foreground">Makes it better</p>
          <ul className="divide-y divide-border-soft">
            {optional.map((s) => (
              <Step key={s.id} s={s} />
            ))}
          </ul>
        </div>
      </div>
    </Card>
  )
}

const RUNS_PAGE = 12

function RunsCard({ runs, now }: { runs: SeoRunSummary[]; now: number }) {
  const router = useRouter()
  const [limit, setLimit] = useState(RUNS_PAGE)

  if (runs.length === 0) {
    return (
      <section className="flex flex-col gap-3">
        <h2 className="eyebrow text-muted-foreground">Runs</h2>
        <Empty>No runs yet. “Run weekly now” starts the first one; after that the schedule takes over.</Empty>
      </section>
    )
  }

  // Newest first; each weekly score compares with the next older scored
  // weekly run. Foundation runs show their own score with no delta.
  const sorted = [...runs].sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  const prevScore = new Map<string, number>()
  let older: number | null = null
  for (let i = sorted.length - 1; i >= 0; i--) {
    const r = sorted[i]
    if (r.kind !== 'weekly') continue
    if (older !== null) prevScore.set(r.id, older)
    if (typeof r.score === 'number') older = r.score
  }

  return (
    <section className="flex flex-col gap-3">
      <h2 className="eyebrow text-muted-foreground">Runs · {runs.length}</h2>
      <Table
        minWidth="min-w-[64rem]"
        head={
          <>
            <th className={cn(thClass, 'pl-4')}>Week</th>
            <th className={thClass}>Status</th>
            <th className={thClass}>Stage</th>
            <th className={cn(thClass, 'text-right')}>Score</th>
            <th className={thClass}>Issues</th>
            <th className={cn(thClass, 'text-right')}>Drafts</th>
            <th className={cn(thClass, 'text-right')}>Cost</th>
            <th className={thClass}>PR</th>
            <th className={cn(thClass, 'pr-4')}>Started</th>
          </>
        }
      >
        {sorted.slice(0, limit).map((r) => {
          const prev = prevScore.get(r.id)
          return (
            <tr
              key={r.id}
              onClick={() => router.push(`/seo/runs/${r.id}`)}
              className="cursor-pointer border-t border-border-soft transition hover:bg-surface-muted"
            >
              <td className={cn(tdClass, 'pl-4')}>
                <Link href={`/seo/runs/${r.id}`} onClick={(e) => e.stopPropagation()} className="font-medium hover:underline">
                  {weekLabel(r.weekOf, { markManual: false })}
                </Link>
                <p className="text-[11.5px] text-muted-foreground">
                  {r.kind === 'foundation' ? 'Foundation' : 'Weekly'} · {r.trigger === 'schedule' ? 'scheduled' : 'manual'}
                </p>
              </td>
              <td className={tdClass}>
                <RunStatusPill status={r.status} hubPublishing={r.hubPublishing} />
              </td>
              <td className={cn(tdClass, 'text-[12px] text-muted-foreground')}>
                {r.status === 'done' ? '—' : (STAGE_LABEL[r.stage] ?? r.stage)}
              </td>
              <td className={cn(tdClass, 'text-right')}>
                <span className="inline-flex items-baseline gap-1.5">
                  <ScoreNumber score={r.score} className="text-[15px]" />
                  {typeof r.score === 'number' && typeof prev === 'number' && <Delta value={r.score - prev} />}
                </span>
              </td>
              <td className={cn(tdClass, 'whitespace-nowrap font-mono text-[11.5px] text-muted-foreground')}>
                {r.counts ? `${r.counts.P0 ?? 0} · ${r.counts.P1 ?? 0} · ${r.counts.P2 ?? 0}` : '—'}
              </td>
              <td className={cn(tdClass, 'text-right font-mono tabular-nums')}>{r.drafts || '—'}</td>
              <td className={cn(tdClass, 'text-right font-mono text-[12px] tabular-nums text-muted-foreground')}>{usd(r.costUsd)}</td>
              <td className={tdClass}>
                {r.prUrl ? (
                  <ExtLink href={r.prUrl} className="font-mono text-[12px]">
                    {prLabel(r.prUrl)}
                  </ExtLink>
                ) : (
                  <span className="text-muted-foreground/60">—</span>
                )}
              </td>
              <td className={cn(tdClass, 'pr-4 whitespace-nowrap font-mono text-[11.5px] text-muted-foreground')}>
                {timeAgo(r.startedAt ?? r.createdAt, now)}
              </td>
            </tr>
          )
        })}
      </Table>
      <ShowMore shown={Math.min(limit, sorted.length)} total={sorted.length} onMore={() => setLimit((l) => l + RUNS_PAGE)} />
      <p className="text-[11.5px] text-muted-foreground">Issues are failing P0 · P1 · P2 checks.</p>
    </section>
  )
}

function prLabel(url: string): string {
  const m = /\/pull\/(\d+)/.exec(url)
  return m ? `#${m[1]}` : 'PR'
}

const POSTS_PAGE = 20

function PostsCard({ posts, now }: { posts: SeoPostView[]; now: number }) {
  const [limit, setLimit] = useState(POSTS_PAGE)
  return (
    <section className="flex flex-col gap-3">
      <h2 className="eyebrow text-muted-foreground">Posts · {posts.length}</h2>
      {posts.length === 0 ? (
        <Empty>No posts yet. Drafts land here when a run writes them and move to live once they’re published.</Empty>
      ) : (
        <>
          <Table
            minWidth="min-w-[56rem]"
            head={
              <>
                <th className={cn(thClass, 'pl-4')}>Post</th>
                <th className={thClass}>Keyword</th>
                <th className={thClass}>Status</th>
                <th className={thClass}>Live at</th>
                <th className={thClass}>Run</th>
                <th className={cn(thClass, 'pr-4')}>Created</th>
              </>
            }
          >
            {posts.slice(0, limit).map((p) => (
              <tr key={p.id} className={cn('border-t border-border-soft', p.status === 'rejected' && 'opacity-60')}>
                <td className={cn(tdClass, 'max-w-[26rem] pl-4')}>
                  <p className="truncate font-medium" title={p.title}>
                    {p.title}
                  </p>
                  <p className="truncate font-mono text-[11px] text-muted-foreground">{p.slug}</p>
                </td>
                <td className={cn(tdClass, 'max-w-[14rem] truncate text-muted-foreground')} title={p.primaryKeyword}>
                  {p.primaryKeyword || '—'}
                </td>
                <td className={tdClass}>
                  <PostStatusPill status={p.status} />
                </td>
                <td className={tdClass}>
                  {p.url ? (
                    <ExtLink href={p.url} className="max-w-[14rem] font-mono text-[12px]">
                      {pathOf(p.url)}
                    </ExtLink>
                  ) : (
                    <span className="text-muted-foreground/60">—</span>
                  )}
                </td>
                <td className={tdClass}>
                  {p.runId ? (
                    <Link href={`/seo/runs/${p.runId}`} className="text-[12px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline">
                      Open
                    </Link>
                  ) : (
                    <span className="text-muted-foreground/60">—</span>
                  )}
                </td>
                <td className={cn(tdClass, 'pr-4 whitespace-nowrap font-mono text-[11.5px] text-muted-foreground')}>
                  {timeAgo(p.createdAt, now)}
                </td>
              </tr>
            ))}
          </Table>
          <ShowMore shown={Math.min(limit, posts.length)} total={posts.length} onMore={() => setLimit((l) => l + POSTS_PAGE)} />
        </>
      )}
    </section>
  )
}

/* -------------------------------------------------------------------------- */
/*  Business facts                                                            */
/* -------------------------------------------------------------------------- */

type Keyed<T> = T & { k: string }
type ServiceRow = Keyed<{ name: string; slug: string; notes: string }>
type ProjectRow = Keyed<{ title: string; city: string; service: string; details: string }>
type ProfileRow = Keyed<{ label: string; url: string }>

/**
 * The editor's working copy. String lists are edited as one item per line
 * and only split on save, so a half-typed line (or a trailing newline)
 * isn't eaten while typing.
 */
type FactsDraft = {
  businessName: string
  trade: string
  schemaType: string
  primaryCity: string
  state: string
  serviceAreas: string
  services: ServiceRow[]
  phone: string
  email: string
  address: string
  hiddenAddress: boolean
  owner: string
  established: string
  license: string
  insurance: string
  warranty: string
  hours: string
  pricingNotes: string
  differentiators: string
  projects: ProjectRow[]
  profiles: ProfileRow[]
  brandVoice: string
  avoid: string
  notes: string
}

/** The draft fields edited as plain text. */
type TextKey = { [K in keyof FactsDraft]: FactsDraft[K] extends string ? K : never }[keyof FactsDraft]

const SCHEMA_TYPES = [
  'HomeAndConstructionBusiness',
  'GeneralContractor',
  'RoofingContractor',
  'Electrician',
  'Plumber',
  'HVACBusiness',
  'HousePainter',
  'Locksmith',
  'MovingCompany',
  'LocalBusiness',
]

let rowSeq = 0
/** Only ever called from event handlers — never during render. */
const newRowKey = () => `n${++rowSeq}`

const str = (v: unknown) => (typeof v === 'string' ? v : '')
const lines = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').join('\n') : '')
function keyedRows<T>(v: unknown, map: (o: Record<string, unknown>) => T): Keyed<T>[] {
  if (!Array.isArray(v)) return []
  return v
    .filter((o): o is Record<string, unknown> => !!o && typeof o === 'object')
    .map((o, i) => ({ ...map(o), k: `r${i}` }))
}

function toDraft(f: BusinessFacts | null, fallbackName: string): FactsDraft {
  // Stored JSON may predate a field; read every value defensively.
  const x = (f ?? {}) as Partial<Record<keyof BusinessFacts, unknown>>
  return {
    businessName: str(x.businessName) || fallbackName,
    trade: str(x.trade),
    schemaType: str(x.schemaType),
    primaryCity: str(x.primaryCity),
    state: str(x.state),
    serviceAreas: lines(x.serviceAreas),
    services: keyedRows(x.services, (o) => ({ name: str(o.name), slug: str(o.slug), notes: str(o.notes) })),
    phone: str(x.phone),
    email: str(x.email),
    address: str(x.address),
    hiddenAddress: x.hiddenAddress === true,
    owner: str(x.owner),
    established: typeof x.established === 'number' && Number.isFinite(x.established) ? String(x.established) : '',
    license: str(x.license),
    insurance: str(x.insurance),
    warranty: str(x.warranty),
    hours: str(x.hours),
    pricingNotes: str(x.pricingNotes),
    differentiators: lines(x.differentiators),
    projects: keyedRows(x.projects, (o) => ({
      title: str(o.title),
      city: str(o.city),
      service: str(o.service),
      details: str(o.details),
    })),
    profiles: keyedRows(x.profiles, (o) => ({ label: str(o.label), url: str(o.url) })),
    brandVoice: str(x.brandVoice),
    avoid: lines(x.avoid),
    notes: str(x.notes),
  }
}

const orNull = (v: string) => v.trim() || null
function toList(v: string): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of v.split('\n')) {
    const t = raw.trim()
    if (t && !seen.has(t.toLowerCase())) {
      seen.add(t.toLowerCase())
      out.push(t)
    }
  }
  return out
}

function fromDraft(d: FactsDraft): BusinessFacts {
  const year = Number(d.established.trim())
  return {
    businessName: d.businessName.trim(),
    trade: d.trade.trim(),
    schemaType: d.schemaType.trim(),
    primaryCity: d.primaryCity.trim(),
    state: d.state.trim().toUpperCase(),
    serviceAreas: toList(d.serviceAreas),
    services: d.services
      .filter((r) => r.name.trim())
      .map((r) => ({ name: r.name.trim(), slug: orNull(r.slug), notes: orNull(r.notes) })),
    phone: orNull(d.phone),
    email: orNull(d.email),
    address: orNull(d.address),
    hiddenAddress: d.hiddenAddress,
    owner: orNull(d.owner),
    established: d.established.trim() && Number.isFinite(year) ? Math.trunc(year) : null,
    license: orNull(d.license),
    insurance: orNull(d.insurance),
    warranty: orNull(d.warranty),
    hours: orNull(d.hours),
    pricingNotes: orNull(d.pricingNotes),
    differentiators: toList(d.differentiators),
    projects: d.projects
      .filter((r) => r.title.trim() || r.details.trim())
      .map((r) => ({
        title: r.title.trim(),
        city: orNull(r.city),
        service: orNull(r.service),
        details: r.details.trim(),
      })),
    profiles: d.profiles
      .filter((r) => r.url.trim())
      .map((r) => ({ label: r.label.trim() || hostOf(r.url.trim()), url: r.url.trim() })),
    brandVoice: orNull(d.brandVoice),
    avoid: toList(d.avoid),
    notes: orNull(d.notes),
  }
}

/** First problem that would make the facts wrong on the site, or null. */
function factsProblem(d: FactsDraft): string | null {
  if (!d.businessName.trim()) return 'Business name is required.'
  if (d.state.trim() && !/^[A-Za-z]{2}$/.test(d.state.trim())) return 'State is the two-letter code, e.g. TX.'
  if (d.established.trim()) {
    const y = Number(d.established.trim())
    if (!Number.isInteger(y) || y < 1800 || y > 2100) return 'Established should be a year, e.g. 2011.'
  }
  if (d.email.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(d.email.trim())) return 'That email address doesn’t look right.'
  const badSlug = d.services.find((r) => r.slug.trim() && !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(r.slug.trim()))
  if (badSlug) return `Service slugs are lowercase-with-dashes, like the site’s URL (e.g. concrete-driveways): “${badSlug.slug.trim()}”.`
  const badProfile = d.profiles.find((r) => r.url.trim() && !/^https?:\/\/[^\s/]+\.[^\s]+$/i.test(r.url.trim()))
  if (badProfile) return `Profile links need the full address, starting with https:// — ${badProfile.label.trim() || badProfile.url.trim()}.`
  const noDetails = d.projects.find((r) => r.title.trim() && !r.details.trim())
  if (noDetails) return `Add details for the project “${noDetails.title.trim()}” — what was done, and anything notable.`
  return null
}

/**
 * Owns the save / re-seed mutations and their notices. The form below is
 * keyed by a hash of the stored facts, so a save or re-seed that changes
 * them hands the form a fresh copy instead of syncing state in an effect.
 *
 * While the form has unsaved edits its key is held on the facts it was
 * opened with: the site query polls, and a run's collect stage (or someone
 * else saving) can change the stored facts mid-edit — remounting then would
 * silently throw the typing away. The form says so instead; saving,
 * re-seeding or "Load the new facts" lets the key follow the server again.
 */
function FactsSection({ site }: { site: SeoSiteDetail }) {
  const qc = useQueryClient()
  const [notice, setNotice] = useState<NoticeState>(null)
  const [heldKey, setHeldKey] = useState<string | null>(null)
  const update = useUpdateSite(site.id)
  const reseed = useMutation({
    mutationFn: () => seoFetch<{ site: SeoSiteDetail }>(`/api/seo/sites/${enc(site.id)}/facts`, { method: 'POST' }),
    onSuccess: ({ site: next }) => {
      if (next) qc.setQueryData<SeoSiteDetailResponse>(seoKeys.site(site.id), (old) => (old ? { ...old, site: next } : old))
      // Re-seed was confirmed over any unsaved edits, so take the fresh facts.
      setHeldKey(null)
      setNotice({ tone: 'ok', text: 'Business facts re-seeded from the intake and the site. Check them over before the next run.' })
    },
    onError: (e: Error) => setNotice({ tone: 'err', text: e.message }),
  })

  const liveKey = hashString(JSON.stringify(site.facts ?? null))
  const formKey = heldKey ?? liveKey
  const onHold = useCallback((held: boolean, key: string) => setHeldKey(held ? key : null), [])

  return (
    <FactsForm
      key={formKey}
      mountKey={formKey}
      serverMoved={formKey !== liveKey}
      onHold={onHold}
      onLoadServer={() => {
        setNotice(null)
        setHeldKey(null)
      }}
      site={site}
      saving={update.isPending}
      reseeding={reseed.isPending}
      notice={notice}
      onDismiss={() => setNotice(null)}
      onError={(text) => setNotice({ tone: 'err', text })}
      onSave={(facts) => {
        setNotice(null)
        update.mutate(
          { facts },
          {
            onSuccess: () => {
              // What was just saved is now the stored copy — reopen the form on it.
              setHeldKey(null)
              setNotice({ tone: 'ok', text: 'Business facts saved. The next run writes from them.' })
            },
            onError: (e) => setNotice({ tone: 'err', text: e.message }),
          },
        )
      }}
      onReseed={(dirty) => {
        const msg = dirty
          ? 'Re-seed replaces these facts with a fresh read of the onboarding intake and the site. Your unsaved edits will be lost. Continue?'
          : 'Re-seed replaces these facts with a fresh read of the onboarding intake and the site (about a minute). Continue?'
        if (!window.confirm(msg)) return
        setNotice(null)
        reseed.mutate()
      }}
    />
  )
}

function FactsForm({
  site,
  mountKey,
  serverMoved,
  onHold,
  onLoadServer,
  saving,
  reseeding,
  notice,
  onDismiss,
  onError,
  onSave,
  onReseed,
}: {
  site: SeoSiteDetail
  /** The key this form was mounted with (the stored facts it opened on). */
  mountKey: string
  /** The stored facts have changed since this form opened. */
  serverMoved: boolean
  /** Reports unsaved edits up, so the section keeps this form mounted while there are some. */
  onHold: (held: boolean, key: string) => void
  /** Drop the unsaved edits and reopen on the stored facts. */
  onLoadServer: () => void
  saving: boolean
  reseeding: boolean
  notice: NoticeState
  onDismiss: () => void
  onError: (text: string) => void
  onSave: (facts: BusinessFacts) => void
  onReseed: (dirty: boolean) => void
}) {
  const fallbackName = site.clientName ?? site.name
  /** Where a fact came from (client form / team), shown beside its label. */
  const from = (k: keyof BusinessFacts) => <SourceChip source={site.client.sources[k]} />
  const [draft, setDraft] = useState<FactsDraft>(() => toDraft(site.facts, fallbackName))
  // What the form opened on, and what's stored now — they differ once the
  // stored facts move underneath an open form.
  const [opened] = useState(() => JSON.stringify(fromDraft(toDraft(site.facts, fallbackName))))
  const stored = JSON.stringify(fromDraft(toDraft(site.facts, fallbackName)))
  const current = JSON.stringify(fromDraft(draft))
  const dirty = current !== opened && current !== stored
  const stale = dirty && serverMoved
  const canSave = (dirty || !site.facts) && !saving && !reseeding

  useEffect(() => {
    onHold(dirty, mountKey)
  }, [dirty, mountKey, onHold])

  // Leaving with unsaved facts asks first.
  useEffect(() => {
    if (!dirty) return
    const warn = (e: BeforeUnloadEvent) => e.preventDefault()
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [dirty])

  function set<K extends keyof FactsDraft>(key: K, value: FactsDraft[K]) {
    setDraft((d) => ({ ...d, [key]: value }))
  }

  function save() {
    const problem = factsProblem(draft)
    if (problem) {
      onError(problem)
      return
    }
    onSave(fromDraft(draft))
  }

  const text = (key: TextKey, { className, ...rest }: React.InputHTMLAttributes<HTMLInputElement> = {}) => (
    <input
      {...rest}
      value={draft[key]}
      onChange={(e) => set(key, e.target.value)}
      className={cn(fieldClass, className)}
    />
  )
  const area = (key: TextKey, rows: number, placeholder?: string) => (
    <textarea
      value={draft[key]}
      onChange={(e) => set(key, e.target.value)}
      rows={rows}
      placeholder={placeholder}
      className={cn(fieldClass, 'resize-y leading-relaxed')}
    />
  )

  return (
    <div className="flex flex-col gap-4">
      <Card
        title="Business facts"
        hint={site.facts ? 'what every post and schema block is written from' : 'not set yet'}
        actions={
          <>
            <button type="button" onClick={() => onReseed(dirty)} disabled={reseeding || saving} className={btnSmall}>
              {reseeding ? <Loader2 className="h-3 w-3 animate-spin" /> : <Sparkles className="h-3 w-3" />}
              Re-seed from intake + site
            </button>
            <button type="button" onClick={save} disabled={!canSave} className={cn(btnSmall, canSave && 'border-foreground/40 text-foreground')}>
              {saving ? <Loader2 className="h-3 w-3 animate-spin" /> : <Save className="h-3 w-3" />}
              Save
            </button>
          </>
        }
      >
        <div className="flex flex-col gap-6">
          <Notice notice={notice} onClose={onDismiss} />
          {stale && !reseeding && (
            <div
              role="status"
              className="flex flex-wrap items-start gap-x-3 gap-y-2 rounded-lg border border-warning/30 bg-warning/10 px-3 py-2 text-[12.5px] text-warning"
            >
              <span className="min-w-0 flex-1 basis-[18rem]">
                The saved business facts changed while you were editing — a run filled them in, or someone else saved.
                Your edits are still here. Saving replaces the new facts with this form.
              </span>
              <button
                type="button"
                onClick={() => {
                  if (window.confirm('Drop your unsaved edits and load the saved facts?')) onLoadServer()
                }}
                disabled={saving}
                className={btnSmall}
              >
                <Undo2 className="h-3 w-3" /> Load the saved facts
              </button>
            </div>
          )}
          {reseeding && (
            <p className="flex items-center gap-2 rounded-lg border border-border bg-surface px-3 py-2 text-[12.5px] text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              Reading the onboarding intake{site.repoFullName ? ', the repo' : ''} and the live site with Claude — about a
              minute. The fields unlock when it’s done.
            </p>
          )}
          {!site.facts && !reseeding && (
            <p className="rounded-lg border border-dashed border-border px-3 py-2 text-[12.5px] text-muted-foreground">
              No facts yet. “Re-seed” drafts them from the client’s onboarding answers and the site; you can also fill them
              in by hand. Posts only ever state what’s here or in a cited source.
            </p>
          )}

          <fieldset disabled={reseeding || saving} className="flex min-w-0 flex-col gap-7 disabled:opacity-60">
            <FormSection title="Business">
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                <Field label="Business name" badge={from('businessName')}>{text('businessName')}</Field>
                <Field label="Trade" hint="Plain English, e.g. “Concrete contractor”.">
                  {text('trade', { placeholder: 'Fence contractor' })}
                </Field>
                <Field label="Schema type" hint="The schema.org type the structured data uses.">
                  {text('schemaType', { list: 'seo-schema-types', placeholder: 'HomeAndConstructionBusiness', spellCheck: false })}
                </Field>
                <Field label="Owner" badge={from('owner')}>{text('owner')}</Field>
                <Field label="Established" badge={from('established')}>{text('established', { inputMode: 'numeric', placeholder: '2011' })}</Field>
                <Field label="License" badge={from('license')}>{text('license', { placeholder: 'License # or “Licensed in TX”' })}</Field>
              </div>
              <datalist id="seo-schema-types">
                {SCHEMA_TYPES.map((t) => (
                  <option key={t} value={t} />
                ))}
              </datalist>
            </FormSection>

            <FormSection title="Location">
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                <Field label="Primary city">{text('primaryCity', { placeholder: 'Austin' })}</Field>
                <Field label="State">{text('state', { placeholder: 'TX', maxLength: 2, className: 'uppercase' })}</Field>
                <Field label="Address" hint="Leave empty for service-area businesses.">
                  {text('address')}
                </Field>
              </div>
              <label className="flex items-start gap-2.5 text-[13px]">
                <input
                  type="checkbox"
                  checked={draft.hiddenAddress}
                  onChange={(e) => set('hiddenAddress', e.target.checked)}
                  className="mt-0.5 h-4 w-4 accent-foreground"
                />
                <span>
                  Service-area business
                  <span className="block text-[12px] text-muted-foreground">
                    No customer-facing address. The engine never shows or recommends showing one.
                  </span>
                </span>
              </label>
              <Field label="Service areas" hint="One city or area per line." badge={from('serviceAreas')}>
                {area('serviceAreas', 4, 'Austin\nRound Rock\nCedar Park')}
              </Field>
            </FormSection>

            <FormSection title="Contact">
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                <Field label="Phone" hint="Must match the site and Google profile exactly.">
                  {text('phone', { inputMode: 'tel', placeholder: '(512) 555-0123' })}
                </Field>
                <Field label="Email">{text('email', { inputMode: 'email', spellCheck: false })}</Field>
                <Field label="Hours" badge={from('hours')}>{text('hours', { placeholder: 'Mon–Fri 7am–6pm, Sat 8am–2pm' })}</Field>
              </div>
            </FormSection>

            <FormSection title="Services" hint="The slug matches the site’s /services/<slug> page when there is one." badge={from('services')}>
              <Repeater<ServiceRow>
                items={draft.services}
                onChange={(v) => set('services', v)}
                blank={{ name: '', slug: '', notes: '' }}
                addLabel="Add service"
                emptyText="No services yet."
              >
                {(r, patch) => (
                  <div className="grid gap-3 sm:grid-cols-[1fr_12rem] lg:grid-cols-[1fr_12rem_1.5fr]">
                    <Field label="Name">
                      <input value={r.name} onChange={(e) => patch({ name: e.target.value })} className={fieldClass} />
                    </Field>
                    <Field label="Slug">
                      <input
                        value={r.slug}
                        onChange={(e) => patch({ slug: e.target.value })}
                        placeholder="concrete-driveways"
                        spellCheck={false}
                        className={cn(fieldClass, 'font-mono text-[12.5px]')}
                      />
                    </Field>
                    <Field label="Notes" className="sm:col-span-2 lg:col-span-1">
                      <input value={r.notes} onChange={(e) => patch({ notes: e.target.value })} className={fieldClass} />
                    </Field>
                  </div>
                )}
              </Repeater>
            </FormSection>

            <FormSection title="Trust & pricing">
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Insurance" badge={from('insurance')}>{text('insurance', { placeholder: 'Fully insured, $2M general liability' })}</Field>
                <Field label="Warranty" badge={from('warranty')}>{text('warranty', { placeholder: '5-year workmanship warranty' })}</Field>
                <Field label="Pricing notes" badge={from('pricingNotes')} hint="First-party price bands only. Posts may not invent prices beyond these or a cited source.">
                  {area('pricingNotes', 3)}
                </Field>
                <Field label="Differentiators" hint="One per line — why customers pick them." badge={from('differentiators')}>
                  {area('differentiators', 3)}
                </Field>
              </div>
            </FormSection>

            <FormSection
              title="Projects"
              hint="Real, completed jobs. First-hand detail is what keeps posts from reading like generic filler."
            >
              <Repeater<ProjectRow>
                items={draft.projects}
                onChange={(v) => set('projects', v)}
                blank={{ title: '', city: '', service: '', details: '' }}
                addLabel="Add project"
                emptyText="No projects yet."
              >
                {(r, patch) => (
                  <div className="grid gap-3 sm:grid-cols-3">
                    <Field label="Title">
                      <input value={r.title} onChange={(e) => patch({ title: e.target.value })} className={fieldClass} />
                    </Field>
                    <Field label="City">
                      <input value={r.city} onChange={(e) => patch({ city: e.target.value })} className={fieldClass} />
                    </Field>
                    <Field label="Service">
                      <input value={r.service} onChange={(e) => patch({ service: e.target.value })} className={fieldClass} />
                    </Field>
                    <Field label="Details" className="sm:col-span-3">
                      <textarea
                        value={r.details}
                        onChange={(e) => patch({ details: e.target.value })}
                        rows={2}
                        placeholder="What was done, materials, size, timeline, anything the customer said…"
                        className={cn(fieldClass, 'resize-y leading-relaxed')}
                      />
                    </Field>
                  </div>
                )}
              </Repeater>
            </FormSection>

            <FormSection title="Profiles" hint="Google Business Profile, Yelp, BBB, Facebook, Angi — used for the schema’s sameAs." badge={from('profiles')}>
              <Repeater<ProfileRow>
                items={draft.profiles}
                onChange={(v) => set('profiles', v)}
                blank={{ label: '', url: '' }}
                addLabel="Add profile"
                emptyText="No profiles yet."
              >
                {(r, patch) => (
                  <div className="grid gap-3 sm:grid-cols-[12rem_1fr]">
                    <Field label="Label">
                      <input value={r.label} onChange={(e) => patch({ label: e.target.value })} placeholder="Google" className={fieldClass} />
                    </Field>
                    <Field label="URL">
                      <input
                        value={r.url}
                        onChange={(e) => patch({ url: e.target.value })}
                        placeholder="https://g.page/…"
                        spellCheck={false}
                        className={cn(fieldClass, 'font-mono text-[12.5px]')}
                      />
                    </Field>
                  </div>
                )}
              </Repeater>
            </FormSection>

            <FormSection title="Voice & guardrails">
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Brand voice">{area('brandVoice', 3, 'Straight-talking, local, no hype.')}</Field>
                <Field label="Never say" hint="One claim or phrase per line that content must never use.">
                  {area('avoid', 3, 'Best in Texas\nCheapest')}
                </Field>
                <Field label="Notes" className="sm:col-span-2">
                  {area('notes', 3)}
                </Field>
              </div>
            </FormSection>
          </fieldset>
        </div>
      </Card>

      {(dirty || saving) && (
        <div className="sticky bottom-4 z-20 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-popover px-4 py-3 shadow-pop">
          <span className="text-[13px] text-muted-foreground">Unsaved changes to the business facts.</span>
          <span className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setDraft(toDraft(site.facts, fallbackName))}
              disabled={saving}
              className={cn(btnGhost, 'h-8 text-[12.5px]')}
            >
              <Undo2 className="h-3.5 w-3.5" /> Discard
            </button>
            <button type="button" onClick={save} disabled={!canSave} className={cn(btnPrimary, 'h-8')}>
              {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
              Save facts
            </button>
          </span>
        </div>
      )}
    </div>
  )
}

function FormSection({ title, hint, badge, children }: { title: string; hint?: string; badge?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-3.5">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 border-b border-border-soft pb-2">
        <h3 className="text-[13px] font-semibold">{title}</h3>
        {badge}
        {hint && <p className="text-[12px] text-muted-foreground">{hint}</p>}
      </div>
      {children}
    </section>
  )
}

function Repeater<T extends { k: string }>({
  items,
  onChange,
  blank,
  addLabel,
  emptyText,
  children,
}: {
  items: T[]
  onChange: (next: T[]) => void
  blank: Omit<T, 'k'>
  addLabel: string
  emptyText: string
  children: (item: T, patch: (p: Partial<Omit<T, 'k'>>) => void) => React.ReactNode
}) {
  return (
    <div className="flex flex-col gap-2.5">
      {items.length === 0 && <p className="text-[12.5px] text-muted-foreground">{emptyText}</p>}
      {items.map((item) => (
        <div key={item.k} className="flex items-start gap-2 rounded-lg border border-border-soft bg-surface/60 p-3">
          <div className="min-w-0 flex-1">
            {children(item, (p) => onChange(items.map((x) => (x.k === item.k ? { ...x, ...p } : x))))}
          </div>
          <button
            type="button"
            onClick={() => onChange(items.filter((x) => x.k !== item.k))}
            className="mt-5 grid h-8 w-8 shrink-0 place-items-center rounded-md text-muted-foreground transition hover:bg-muted hover:text-destructive"
            aria-label="Remove"
            title="Remove"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        </div>
      ))}
      <button
        type="button"
        onClick={() => onChange([...items, { ...blank, k: newRowKey() } as T])}
        className={cn(btnSmall, 'self-start')}
      >
        <Plus className="h-3 w-3" /> {addLabel}
      </button>
    </div>
  )
}

/* -------------------------------------------------------------------------- */
/*  Settings                                                                  */
/* -------------------------------------------------------------------------- */

/** "example.com" → "sc-domain:example.com"; URL-prefix properties keep a trailing slash. Undefined = invalid. */
function normalizeGsc(raw: string): string | null | undefined {
  const t = raw.trim()
  if (!t) return null
  if (/^sc-domain:/i.test(t)) {
    const host = t.slice('sc-domain:'.length).trim().toLowerCase()
    return /^[a-z0-9.-]+\.[a-z]{2,}$/.test(host) ? `sc-domain:${host}` : undefined
  }
  if (/^https?:\/\//i.test(t)) {
    try {
      const u = new URL(t)
      return `${u.origin}${u.pathname.endsWith('/') ? u.pathname : `${u.pathname}/`}`
    } catch {
      return undefined
    }
  }
  return /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(t) ? `sc-domain:${t.toLowerCase()}` : undefined
}

/** Accepts the id itself or any lovable.dev/projects/<id> URL. Undefined = invalid. */
function parseLovableId(raw: string): string | null | undefined {
  const t = raw.trim()
  if (!t) return null
  const m = /lovable\.dev\/projects\/([A-Za-z0-9-]+)/i.exec(t)
  if (m) return m[1]
  return /^[A-Za-z0-9-]{8,}$/.test(t) ? t : undefined
}

function SettingsSection({ site, now }: { site: SeoSiteDetail; now: number }) {
  const [notice, setNotice] = useState<NoticeState>(null)
  const update = useUpdateSite(site.id)
  const overview = useQuery({ queryKey: seoKeys.overview, queryFn: fetchOverview, staleTime: 5 * 60_000 })
  const gscEmail = overview.data?.integrations?.searchConsole?.serviceAccountEmail ?? null
  const formKey = hashString(
    JSON.stringify([site.name, site.liveUrl, site.repoFullName, site.gscProperty, site.lovableProjectId]),
  )

  return (
    <div className="flex flex-col gap-6">
      <Notice notice={notice} onClose={() => setNotice(null)} />
      <SettingsForm
        key={formKey}
        site={site}
        now={now}
        gscEmail={gscEmail}
        saving={update.isPending}
        onSave={(body, note) => {
          setNotice(null)
          update.mutate(body, {
            onSuccess: () => setNotice({ tone: 'ok', text: note ?? 'Settings saved.' }),
            onError: (e) => setNotice({ tone: 'err', text: e.message }),
          })
        }}
        onError={(text) => setNotice({ tone: 'err', text })}
      />
      <DetailsCard site={site} />
      <ArchiveCard site={site} onError={(text) => setNotice({ tone: 'err', text })} />
    </div>
  )
}

function SettingsForm({
  site,
  now,
  gscEmail,
  saving,
  onSave,
  onError,
}: {
  site: SeoSiteDetail
  now: number
  gscEmail: string | null
  saving: boolean
  onSave: (body: UpdateSiteBody, note?: string) => void
  onError: (text: string) => void
}) {
  const [name, setName] = useState(site.name)
  const [liveUrl, setLiveUrl] = useState(site.liveUrl ?? '')
  const [repo, setRepo] = useState<string | null>(site.repoFullName)
  const [gsc, setGsc] = useState(site.gscProperty ?? '')
  const [lovable, setLovable] = useState(site.lovableProjectId ?? '')
  const repos = useGithubRepos()
  const suggested = site.repoFullName ? null : suggestRepo(site.liveUrl, repos.data ?? [])

  const gscNorm = normalizeGsc(gsc)
  const lovableId = parseLovableId(lovable)
  const urlNorm = liveUrl.trim() ? normalizeUrl(liveUrl) : null

  // Compare normalised forms on both sides, so a stored value in a slightly
  // different shape doesn't read as an unsaved change.
  const body: UpdateSiteBody = {}
  if (name.trim() !== site.name) body.name = name.trim()
  if (urlNorm !== normalizeUrl(site.liveUrl ?? '') && !(liveUrl.trim() && !urlNorm)) body.liveUrl = urlNorm
  if (repo !== site.repoFullName) body.repoFullName = repo
  if (gscNorm !== undefined && gscNorm !== (normalizeGsc(site.gscProperty ?? '') ?? null)) body.gscProperty = gscNorm
  if (lovableId !== undefined && lovableId !== (parseLovableId(site.lovableProjectId ?? '') ?? null)) body.lovableProjectId = lovableId
  const dirty =
    Object.keys(body).length > 0 ||
    (liveUrl.trim() !== '' && !urlNorm) ||
    gscNorm === undefined ||
    lovableId === undefined

  function save() {
    if (!name.trim()) return onError('The name can’t be empty.')
    if (liveUrl.trim() && !urlNorm) return onError('That live URL doesn’t look right — use the full address, e.g. https://example.com.')
    if (gscNorm === undefined) return onError('Search Console property is “sc-domain:example.com” or a URL prefix like “https://www.example.com/”.')
    if (lovableId === undefined) return onError('Paste the Lovable project’s URL or its id.')
    if (!urlNorm && !repo) return onError('A site needs the live URL, the GitHub repo, or both.')
    let note: string | undefined
    const out = { ...body }
    // The server refuses review/autopilot without a repo, so unlinking one steps the mode down.
    if ('repoFullName' in out && !out.repoFullName && site.mode !== 'audit') {
      out.mode = 'audit'
      note = 'Settings saved. With no repo to commit to, the site is now in Audit mode.'
    } else if ('repoFullName' in out) {
      note = 'Settings saved. The next run re-detects the platform and the foundation for the new repo.'
    }
    onSave(out, note)
  }

  return (
    <Card
      title="Site settings"
      actions={
        <button type="button" onClick={save} disabled={!dirty || saving} className={cn(btnSmall, dirty && 'border-foreground/40 text-foreground')}>
          {saving ? <Loader2 className="h-3 w-3 animate-spin" /> : <Save className="h-3 w-3" />}
          Save
        </button>
      }
    >
      <fieldset disabled={saving} className="flex min-w-0 flex-col gap-5 disabled:opacity-60">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Name">
            <input value={name} onChange={(e) => setName(e.target.value)} className={fieldClass} />
          </Field>
          <Field
            label="Live URL"
            hint={liveUrl.trim() && !urlNorm ? 'Not a valid address yet.' : 'The published site the audit crawls — use the real domain once there is one.'}
          >
            <input
              value={liveUrl}
              onChange={(e) => setLiveUrl(e.target.value)}
              placeholder="https://example.com"
              spellCheck={false}
              className={cn(fieldClass, 'font-mono text-[12.5px]')}
            />
          </Field>
        </div>

        <Field
          label="GitHub repo"
          group
          hint={
            repo !== site.repoFullName && site.repoFullName
              ? 'Changing the repo resets the foundation status; the next run re-detects it.'
              : suggested
                ? `${suggested} matches the live URL.`
                : undefined
          }
        >
          <RepoPicker value={repo} onChange={setRepo} suggested={suggested} now={now} />
        </Field>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            label="Search Console property"
            hint={
              gscNorm === undefined ? (
                'Use “sc-domain:example.com” or “https://www.example.com/”.'
              ) : gscEmail ? (
                <span className="inline-flex flex-wrap items-center gap-1.5">
                  Add <span className="font-mono text-foreground/85">{gscEmail}</span> as a user on the property.
                  <CopyButton value={gscEmail} label="Copy" />
                </span>
              ) : (
                'Connect the Search Console service account in SEO → Setup first.'
              )
            }
          >
            <input
              value={gsc}
              onChange={(e) => setGsc(e.target.value)}
              placeholder="sc-domain:example.com"
              spellCheck={false}
              className={cn(fieldClass, 'font-mono text-[12.5px]')}
            />
          </Field>
          <Field
            label="Lovable project"
            hint={
              lovableId === undefined
                ? 'Paste the project URL from Lovable, or its id.'
                : lovableId && lovableId !== lovable.trim()
                  ? `Project id: ${lovableId}`
                  : 'From the editor URL: lovable.dev/projects/<id>. Used for the publish link and auto-publish.'
            }
          >
            <input
              value={lovable}
              onChange={(e) => setLovable(e.target.value)}
              placeholder="https://lovable.dev/projects/…"
              spellCheck={false}
              className={cn(fieldClass, 'font-mono text-[12.5px]')}
            />
          </Field>
        </div>
      </fieldset>
    </Card>
  )
}

function DetailsCard({ site }: { site: SeoSiteDetail }) {
  const rows: [string, React.ReactNode][] = [
    ['Platform', platformLabel(site.platform)],
    ['Foundation', <FoundationBadge key="f" status={site.foundationStatus} />],
    ['Default branch', site.defaultBranch ? <span className="font-mono">{site.defaultBranch}</span> : '—'],
    [
      'IndexNow key',
      site.indexNowKey ? (
        <span className="inline-flex items-center gap-2">
          <span className="font-mono">{site.indexNowKey}</span>
          <CopyButton value={site.indexNowKey} label="Copy" />
        </span>
      ) : (
        '—'
      ),
    ],
    ['Last run', site.lastRunAt ? dayLabel(site.lastRunAt, true) : '—'],
    ['Added', site.createdAt ? dayLabel(site.createdAt, true) : '—'],
  ]
  return (
    <Card title="Details">
      <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-2 lg:grid-cols-3">
        {rows.map(([label, value]) => (
          <div key={label} className="min-w-0">
            <dt className="eyebrow text-muted-foreground/80">{label}</dt>
            <dd className="mt-1 truncate text-[13px] text-foreground/90">{value}</dd>
          </div>
        ))}
      </dl>
    </Card>
  )
}

function ArchiveCard({ site, onError }: { site: SeoSiteDetail; onError: (text: string) => void }) {
  const router = useRouter()
  const qc = useQueryClient()
  const archive = useMutation({
    mutationFn: () => seoFetch<{ ok: boolean }>(`/api/seo/sites/${enc(site.id)}`, { method: 'DELETE' }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: seoKeys.overview })
      qc.removeQueries({ queryKey: seoKeys.site(site.id) })
      router.push('/seo')
    },
    onError: (e: Error) => onError(e.message),
  })

  return (
    <section className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border-soft bg-surface p-4">
      <div className="min-w-0">
        <p className="text-[13px] font-medium">Archive this site</p>
        <p className="mt-0.5 text-[12px] text-muted-foreground">
          Stops its runs and takes it off the SEO list. Unfinished runs are canceled and their open pull requests closed; merged work, runs, posts and facts are kept. Re-adding the client later brings it back.
        </p>
      </div>
      <button
        type="button"
        disabled={archive.isPending}
        onClick={() => {
          if (window.confirm(`Archive ${site.name}? Unfinished runs are canceled, their open pull requests are closed, and it leaves the weekly schedule.`)) archive.mutate()
        }}
        className={btnDanger}
      >
        {archive.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Archive className="h-4 w-4" />}
        Archive
      </button>
    </section>
  )
}

