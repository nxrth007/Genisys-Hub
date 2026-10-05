'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  ArrowUpRight,
  CalendarClock,
  Circle,
  CircleAlert,
  CircleCheck,
  CircleDot,
  FolderGit2,
  Globe,
  KeyRound,
  Loader2,
  Play,
  Plus,
  TrendingUp,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { LovableConnect } from './lovable-connect'
import { PageHeader } from '@/components/ui/page-header'
import type {
  CreateSiteBody,
  IntegrationState,
  SeoIntegrations,
  SeoOverviewResponse,
  SeoSettings,
  SeoSiteDetail,
  SeoSiteSummary,
} from '@/lib/seo/api-types'
import type { SeoMode } from '@/lib/seo/types'
import {
  btnGhost,
  btnPrimary,
  btnSecondary,
  btnSmall,
  Card,
  CopyButton,
  Delta,
  Empty,
  ErrorBlock,
  ExtLink,
  fetchOverview,
  Field,
  fieldClass,
  FoundationBadge,
  githubUrl,
  hostOf,
  hourLabel,
  inZone,
  isMoving,
  LoadingBlock,
  Modal,
  ModeChip,
  MODES,
  needsYou,
  normalizeUrl,
  Notice,
  type NoticeState,
  platformLabel,
  pollEvery,
  RepoPicker,
  RunStatusPill,
  ScoreNumber,
  seoFetch,
  seoKeys,
  Segmented,
  STAGE_LABEL,
  StatTile,
  suggestRepo,
  Table,
  tdClass,
  thClass,
  timeAgo,
  timeUntil,
  usd,
  useGithubRepos,
  useNow,
  useStartRun,
  WEEKDAYS,
} from './ui'

/**
 * SEO → dashboard.
 *
 * Everything the weekly engine needs at a glance: what's waiting on a
 * person (reviews, publishes, failures), every site with its latest score
 * and run, the schedule, and which keys are still missing. Polls every 15s
 * while any run is moving so a "Run now" can be watched from here.
 */

const TIMEZONES = ['America/New_York', 'America/Chicago', 'America/Denver', 'America/Phoenix', 'America/Los_Angeles', 'UTC']

/**
 * The overview doesn't carry the score before the latest one yet. If the
 * API grows a `previousScore`, the dashboard shows the delta; until then
 * the per-site page (which has every run) is where the trend lives.
 */
type WithPrevious = { previousScore?: number | null }

function initials(name: string): string {
  const words = name.split(/\s+/).filter(Boolean)
  if (words.length === 0) return '?'
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase()
  return (words[0][0] + words[1][0]).toUpperCase()
}

export function SeoDashboard() {
  const router = useRouter()
  const now = useNow()
  const [adding, setAdding] = useState(false)
  const [notice, setNotice] = useState<NoticeState>(null)
  const start = useStartRun()

  const q = useQuery<SeoOverviewResponse>({
    queryKey: seoKeys.overview,
    queryFn: fetchOverview,
    refetchInterval: (query) => pollEvery((query.state.data?.sites ?? []).map((s) => s.latestRun?.status), 15_000),
  })

  const data = q.data
  const sites = data?.sites ?? []
  const requiredOk = !!data?.integrations?.anthropic?.ok && !!data?.integrations?.github?.ok

  function runNow(site: SeoSiteSummary) {
    setNotice(null)
    start.mutate(
      { siteId: site.id, kind: 'weekly' },
      {
        onSuccess: ({ run }) =>
          setNotice({
            tone: 'ok',
            text: (
              <>
                Weekly run queued for {site.name}.{' '}
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

  const config = data && (
    <div className="grid gap-4 lg:grid-cols-5">
      <EngineCard
        className="lg:col-span-3"
        settings={data.settings}
        nextRunAt={data.nextRunAt}
        spend={data.spend}
        requiredOk={requiredOk}
        now={now}
      />
      <SetupCard className="lg:col-span-2" integrations={data.integrations} />
    </div>
  )

  return (
    <div className="mx-auto flex max-w-[1280px] flex-col gap-6">
      <PageHeader
        title="SEO"
        subtitle="Each week the engine crawls every client site, audits it, plans the week, writes the posts and ships them through the site’s repo."
        breadcrumbs={[{ label: 'Genisys' }, { label: 'SEO' }]}
        actions={
          <button
            type="button"
            className={btnPrimary}
            disabled={!data}
            onClick={() => {
              setNotice(null)
              setAdding(true)
            }}
          >
            <Plus className="h-4 w-4" /> Add site
          </button>
        }
      />

      {q.isLoading ? (
        <LoadingBlock />
      ) : q.isError || !data ? (
        <ErrorBlock
          message={q.error instanceof Error ? q.error.message : 'Couldn’t load the SEO overview.'}
          onRetry={() => q.refetch()}
        />
      ) : (
        <>
          <Notice notice={notice} onClose={() => setNotice(null)} />
          <StatsRow sites={sites} spend={data.spend} />
          <Attention sites={sites} now={now} />
          {/* First visit: the checklist is the most useful thing on the page. */}
          {!requiredOk && config}
          <SitesTable
            sites={sites}
            now={now}
            pendingSiteId={start.isPending ? (start.variables?.siteId ?? null) : null}
            onRun={runNow}
            onOpen={(id) => router.push(`/seo/${id}`)}
            onAdd={() => setAdding(true)}
          />
          {requiredOk && config}
        </>
      )}

      {adding && data && (
        <AddSiteDialog
          clients={data.clients ?? []}
          now={now}
          onClose={() => setAdding(false)}
          onCreated={(site) => router.push(`/seo/${site.id}`)}
        />
      )}
    </div>
  )
}

/* -------------------------------------------------------------------------- */
/*  Stats + attention                                                         */
/* -------------------------------------------------------------------------- */

function StatsRow({ sites, spend }: { sites: SeoSiteSummary[]; spend: SeoOverviewResponse['spend'] }) {
  const scored = sites.filter((s) => typeof s.lastScore === 'number')
  const avg = scored.length
    ? Math.round(scored.reduce((a, s) => a + (s.lastScore as number), 0) / scored.length)
    : null
  const modes = (m: SeoMode) => sites.filter((s) => s.mode === m).length
  const waiting = sites.filter((s) => needsYou(s.latestRun)).length
  const live = sites.reduce((a, s) => a + (s.posts?.live ?? 0), 0)
  const total = sites.reduce((a, s) => a + (s.posts?.total ?? 0), 0)

  return (
    <div className="grid grid-cols-2 gap-4 md:grid-cols-3 lg:grid-cols-5">
      <StatTile
        label="Sites"
        value={sites.length}
        sub={sites.length ? `${modes('autopilot')} autopilot · ${modes('review')} review · ${modes('audit')} audit` : 'none yet'}
      />
      <StatTile label="Average score" value={avg ?? '—'} sub={`across ${scored.length} scored site${scored.length === 1 ? '' : 's'}`} />
      <StatTile label="Needs you" value={waiting} sub="reviews, publishes and failures" />
      <StatTile label="Posts live" value={live} sub={`${total} written in all`} />
      <StatTile
        label="Spend · 30 days"
        value={usd(spend?.last30DaysUsd ?? 0)}
        sub={`${spend?.runsLast30Days ?? 0} run${spend?.runsLast30Days === 1 ? '' : 's'}`}
      />
    </div>
  )
}

/** Runs that are parked until a person does something. */
function Attention({ sites, now }: { sites: SeoSiteSummary[]; now: number }) {
  const rows = sites.filter((s) => needsYou(s.latestRun))
  if (rows.length === 0) return null
  const order = { awaiting_review: 0, awaiting_publish: 1, failed: 2 } as Record<string, number>
  const sorted = [...rows].sort((a, b) => (order[a.latestRun!.status] ?? 9) - (order[b.latestRun!.status] ?? 9))

  return (
    <Card title="Waiting on you" hint={`${rows.length}`} bodyClassName="p-0">
      <ul className="divide-y divide-border-soft">
        {sorted.map((s) => {
          const run = s.latestRun!
          const verb = run.status === 'awaiting_review' ? 'Review' : run.status === 'awaiting_publish' ? 'Publish' : 'Open'
          const line =
            run.status === 'failed'
              ? run.error || 'Stopped with an error.'
              : run.headline || (run.kind === 'foundation' ? 'SEO foundation install' : `Weekly run · ${run.drafts} draft${run.drafts === 1 ? '' : 's'}`)
          return (
            <li key={s.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5">
              <RunStatusPill status={run.status} hubPublishing={run.hubPublishing} />
              <Link href={`/seo/${s.id}`} className="text-[13px] font-medium hover:underline">
                {s.name}
              </Link>
              <span
                className={cn(
                  'min-w-0 flex-1 basis-[14rem] truncate text-[13px]',
                  run.status === 'failed' ? 'text-destructive/90' : 'text-muted-foreground',
                )}
                title={line}
              >
                {line}
              </span>
              <span className="font-mono text-[11px] text-muted-foreground">
                {timeAgo(run.finishedAt ?? run.startedAt ?? run.createdAt, now)}
              </span>
              <Link href={`/seo/runs/${run.id}`} className={btnSmall}>
                {verb} <ArrowUpRight className="h-3 w-3" />
              </Link>
            </li>
          )
        })}
      </ul>
    </Card>
  )
}

/* -------------------------------------------------------------------------- */
/*  Sites table                                                               */
/* -------------------------------------------------------------------------- */

function SitesTable({
  sites,
  now,
  pendingSiteId,
  onRun,
  onOpen,
  onAdd,
}: {
  sites: SeoSiteSummary[]
  now: number
  pendingSiteId: string | null
  onRun: (s: SeoSiteSummary) => void
  onOpen: (id: string) => void
  onAdd: () => void
}) {
  if (sites.length === 0) {
    return (
      <Empty className="bg-card p-10">
        <TrendingUp className="mx-auto h-8 w-8 text-muted-foreground/50" />
        <p className="mt-3">
          No sites yet. Add a client’s site — with its GitHub repo if it’s a Lovable build, or on its own for an
          audit-only GoHighLevel site.
        </p>
        <button type="button" onClick={onAdd} className={cn(btnSecondary, 'mt-4')}>
          <Plus className="h-4 w-4" /> Add site
        </button>
      </Empty>
    )
  }

  // Sites in the schedule first, then alphabetical — stable while runs poll.
  const sorted = [...sites].sort(
    (a, b) => Number(b.enabled) - Number(a.enabled) || a.name.localeCompare(b.name),
  )

  return (
    <section className="flex flex-col gap-3">
      <h2 className="eyebrow text-muted-foreground">Sites · {sites.length}</h2>
      <Table
        minWidth="min-w-[58rem]"
        head={
          <>
            <th className={cn(thClass, 'pl-4')}>Site</th>
            <th className={thClass}>Live site · repo</th>
            <th className={thClass}>Mode · foundation</th>
            <th className={cn(thClass, 'text-right')}>Score</th>
            <th className={thClass}>Latest run</th>
            <th className={cn(thClass, 'text-right')}>Posts</th>
            <th className={cn(thClass, 'pr-4 text-right')}>
              <span className="sr-only">Actions</span>
            </th>
          </>
        }
      >
        {sorted.map((s) => (
          <SiteRow
            key={s.id}
            site={s}
            now={now}
            pending={pendingSiteId === s.id}
            onRun={() => onRun(s)}
            onOpen={() => onOpen(s.id)}
          />
        ))}
      </Table>
    </section>
  )
}

function SiteRow({
  site,
  now,
  pending,
  onRun,
  onOpen,
}: {
  site: SeoSiteSummary
  now: number
  pending: boolean
  onRun: () => void
  onOpen: () => void
}) {
  const run = site.latestRun
  const previous = (site as SeoSiteSummary & WithPrevious).previousScore
  const moving = isMoving(run?.status)
  const blockedWhy = !site.liveUrl ? 'Add the live URL first' : moving ? 'A run is already in progress' : null

  return (
    <tr
      onClick={onOpen}
      className={cn(
        'cursor-pointer border-t border-border-soft align-middle transition hover:bg-surface-muted',
        !site.enabled && 'opacity-60',
      )}
    >
      <td className={cn(tdClass, 'pl-4')}>
        <div className="flex min-w-0 items-center gap-3">
          <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg border border-border bg-surface font-mono text-[12px] font-semibold">
            {initials(site.name)}
          </span>
          <div className="min-w-0">
            <Link
              href={`/seo/${site.id}`}
              onClick={(e) => e.stopPropagation()}
              className="block max-w-[14rem] truncate font-medium hover:underline"
            >
              {site.name}
            </Link>
            <p className="max-w-[14rem] truncate text-xs text-muted-foreground">
              {site.clientName ?? 'No client linked'}
              {!site.enabled && ' · not scheduled'}
            </p>
          </div>
        </div>
      </td>
      <td className={tdClass}>
        <div className="flex min-w-0 flex-col gap-1">
          {site.liveUrl ? (
            <ExtLink href={site.liveUrl} className="max-w-[15rem] font-mono text-[12px]">
              {hostOf(site.liveUrl)}
            </ExtLink>
          ) : (
            <span className="text-[12px] text-muted-foreground/60">No live URL</span>
          )}
          <span className="flex min-w-0 items-center gap-1.5 text-[11.5px] text-muted-foreground">
            {site.repoFullName ? (
              <ExtLink
                href={githubUrl(site.repoFullName)}
                className="max-w-[10rem] font-mono text-[11.5px] text-muted-foreground"
                title={site.repoFullName}
              >
                {site.repoFullName.split('/').slice(1).join('/') || site.repoFullName}
              </ExtLink>
            ) : (
              <span className="text-muted-foreground/70">no repo</span>
            )}
            <span aria-hidden>·</span>
            <span className="whitespace-nowrap">{platformLabel(site.platform)}</span>
          </span>
        </div>
      </td>
      <td className={tdClass}>
        <div className="flex flex-col items-start gap-1.5">
          <ModeChip mode={site.mode} />
          {site.repoFullName && <FoundationBadge status={site.foundationStatus} />}
        </div>
      </td>
      <td className={cn(tdClass, 'text-right')}>
        <span className="inline-flex items-baseline gap-1.5">
          <ScoreNumber score={site.lastScore} className="text-[22px]" />
          {typeof previous === 'number' && typeof site.lastScore === 'number' && (
            <Delta value={site.lastScore - previous} />
          )}
        </span>
      </td>
      <td className={tdClass}>
        {run ? (
          <Link
            href={`/seo/runs/${run.id}`}
            onClick={(e) => e.stopPropagation()}
            className="group inline-flex flex-col gap-1"
          >
            <RunStatusPill status={run.status} hubPublishing={run.hubPublishing} />
            <span className="font-mono text-[11px] text-muted-foreground group-hover:text-foreground">
              {run.status === 'running' ? `${STAGE_LABEL[run.stage] ?? run.stage} · ` : ''}
              {timeAgo(run.finishedAt ?? run.startedAt ?? run.createdAt, now)}
            </span>
          </Link>
        ) : (
          <span className="text-[12px] text-muted-foreground/70">Never run</span>
        )}
      </td>
      <td className={cn(tdClass, 'whitespace-nowrap text-right font-mono text-[12px] tabular-nums')}>
        <span className="text-foreground">{site.posts?.live ?? 0}</span>
        <span className="text-muted-foreground"> / {site.posts?.total ?? 0}</span>
      </td>
      <td className={cn(tdClass, 'pr-4 text-right')} onClick={(e) => e.stopPropagation()}>
        <button
          type="button"
          onClick={onRun}
          disabled={pending || !!blockedWhy}
          title={blockedWhy ?? 'Queue a weekly run for this site now'}
          className={btnSmall}
        >
          {pending ? <Loader2 className="h-3 w-3 animate-spin" /> : <Play className="h-3 w-3" />}
          Run now
        </button>
      </td>
    </tr>
  )
}

/* -------------------------------------------------------------------------- */
/*  Engine (schedule) card                                                    */
/* -------------------------------------------------------------------------- */

function EngineCard({
  settings,
  nextRunAt,
  spend,
  requiredOk,
  now,
  className,
}: {
  settings: SeoSettings
  nextRunAt: string | null
  spend: SeoOverviewResponse['spend']
  requiredOk: boolean
  now: number
  className?: string
}) {
  const qc = useQueryClient()
  const [armed, setArmed] = useState(false)
  const [notice, setNotice] = useState<NoticeState>(null)

  // Each control sends only the field it changed, so a stale copy of the
  // settings can never flip another one back. Everything but the schedule
  // switch is optimistic; the switch waits for the server like Automations.
  const save = useMutation({
    mutationFn: (patch: Partial<SeoSettings>) =>
      seoFetch<{ settings: SeoSettings }>('/api/seo/settings', { method: 'PATCH', body: patch }),
    onMutate: async (patch) => {
      setNotice(null)
      await qc.cancelQueries({ queryKey: seoKeys.overview })
      const prev = qc.getQueryData<SeoOverviewResponse>(seoKeys.overview)
      if (prev && !('enabled' in patch)) {
        qc.setQueryData<SeoOverviewResponse>(seoKeys.overview, { ...prev, settings: { ...prev.settings, ...patch } })
      }
      return { prev }
    },
    onError: (e: Error, _patch, ctx) => {
      if (ctx?.prev) qc.setQueryData(seoKeys.overview, ctx.prev)
      setNotice({ tone: 'err', text: e.message })
    },
    onSuccess: ({ settings: next }, patch) => {
      setArmed(false)
      if (next) {
        qc.setQueryData<SeoOverviewResponse>(seoKeys.overview, (old) => (old ? { ...old, settings: next } : old))
      }
      if ('enabled' in patch) {
        setNotice({
          tone: 'ok',
          text: patch.enabled ? 'Weekly schedule is on.' : 'Weekly schedule is off. Manual runs still work.',
        })
      }
    },
    // The next run time depends on every schedule field.
    onSettled: () => qc.invalidateQueries({ queryKey: seoKeys.overview }),
  })

  const s = settings
  const busy = save.isPending
  const zones = TIMEZONES.includes(s.timeZone) ? TIMEZONES : [s.timeZone, ...TIMEZONES]
  const day = WEEKDAYS[s.weekday] ?? `Day ${s.weekday}`
  const until = timeUntil(nextRunAt, now)

  function toggle() {
    if (s.enabled) {
      save.mutate({ enabled: false })
      return
    }
    if (!armed) {
      setArmed(true)
      return
    }
    save.mutate({ enabled: true })
  }

  return (
    <Card className={className} title="Engine" hint={s.enabled ? `${day}s · ${hourLabel(s.hour)}` : 'schedule off'}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-3">
          <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg border border-border bg-surface">
            <CalendarClock className="h-4 w-4 text-muted-foreground" />
          </span>
          <div className="min-w-0">
            <p className="flex items-center gap-2 text-[14px] font-semibold">
              Weekly schedule
              <span
                className={cn(
                  'eyebrow rounded-md px-2 py-0.5',
                  s.enabled ? 'bg-foreground text-background' : 'bg-muted text-muted-foreground',
                )}
              >
                {s.enabled ? 'On' : 'Off'}
              </span>
            </p>
            <p className="mt-0.5 text-[13px] text-muted-foreground">
              {s.enabled
                ? `Every ${day} at ${hourLabel(s.hour)} (${s.timeZone}), each scheduled site gets a run.`
                : 'Off. “Run now” on a site still works.'}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {armed && (
            <button type="button" onClick={() => setArmed(false)} className={cn(btnGhost, 'h-8 text-[12px]')}>
              Cancel
            </button>
          )}
          <button
            type="button"
            disabled={busy}
            onClick={toggle}
            className={cn(
              'inline-flex h-8 items-center gap-1.5 rounded-lg border px-3 text-[12px] font-medium transition disabled:opacity-50',
              armed
                ? 'border-foreground/60 bg-foreground text-background hover:bg-foreground/90'
                : 'border-border bg-card hover:bg-muted',
            )}
          >
            {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            {s.enabled ? 'Turn off' : armed ? 'Confirm — turn on' : 'Turn on'}
          </button>
        </div>
      </div>

      {armed && !s.enabled && (
        <p className="mt-3 text-[12.5px] text-muted-foreground">
          Runs start at the next scheduled slot. If today&rsquo;s slot has already begun, the first run is next week — use Run now on a site to start one today.
        </p>
      )}

      {s.enabled && !requiredOk && (
        <p className="mt-3 flex items-start gap-2 rounded-lg border border-warning/30 bg-warning/10 px-3 py-2 text-[12.5px] text-warning">
          <CircleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          Scheduled runs will fail until the Claude key and the GitHub token are in the Vault.
        </p>
      )}

      <div className="mt-4 grid gap-4 border-t border-border-soft pt-4 sm:grid-cols-2 xl:grid-cols-3">
        <Field label="Day">
          <select
            value={s.weekday}
            disabled={busy}
            onChange={(e) => save.mutate({ weekday: Number(e.target.value) })}
            className={fieldClass}
          >
            {WEEKDAYS.map((d, i) => (
              <option key={d} value={i}>
                {d}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Hour">
          <select
            value={s.hour}
            disabled={busy}
            onChange={(e) => save.mutate({ hour: Number(e.target.value) })}
            className={fieldClass}
          >
            {Array.from({ length: 24 }, (_, h) => (
              <option key={h} value={h}>
                {hourLabel(h)}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Time zone">
          <select
            value={s.timeZone}
            disabled={busy}
            onChange={(e) => save.mutate({ timeZone: e.target.value })}
            className={fieldClass}
          >
            {zones.map((z) => (
              <option key={z} value={z}>
                {z.replace(/_/g, ' ')}
              </option>
            ))}
          </select>
        </Field>
        <Field
          label="New posts per site / week"
          group
          hint="0 keeps runs to audits, fixes and plans. Around $0.40 a post. Above 3, the engine only writes as many as the business's real facts (projects, prices, services) can back — it hands back fewer rather than pad, since Google demotes sites that mass-publish thin AI pages."
        >
          <Segmented
            value={s.postsPerWeek}
            disabled={busy}
            options={[0, 1, 2, 3, 4, 5, 6, 8].map((n) => ({ value: n, label: String(n) }))}
            onChange={(n) => save.mutate({ postsPerWeek: n })}
          />
        </Field>
        <Field label="Cost cap per run" hint="A run stops calling Claude once it has spent this. Up to $50.">
          <CostCapInput
            key={s.maxCostPerRunUsd}
            value={s.maxCostPerRunUsd}
            busy={busy}
            onSave={(v) => save.mutate({ maxCostPerRunUsd: v })}
          />
        </Field>
        <Field label="Model" group>
          <p className="truncate rounded-lg border border-border-soft bg-surface px-3 py-2 font-mono text-[12.5px] text-foreground/85" title={s.model}>
            {s.model || '—'}
          </p>
        </Field>
      </div>

      <div className="mt-4 flex flex-wrap gap-x-6 gap-y-1 border-t border-border-soft pt-3 text-[12.5px] text-muted-foreground">
        <span>
          Next run:{' '}
          <span className="text-foreground/85">
            {nextRunAt ? inZone(nextRunAt, s.timeZone) : s.enabled ? '—' : 'not scheduled'}
          </span>
          {nextRunAt && until && <span className="font-mono text-[11.5px]"> · {until}</span>}
        </span>
        <span>
          Spend, last 30 days: <span className="font-mono text-foreground/85">{usd(spend?.last30DaysUsd ?? 0)}</span>
        </span>
      </div>

      {notice && (
        <div className="mt-3">
          <Notice notice={notice} onClose={() => setNotice(null)} />
        </div>
      )}
    </Card>
  )
}

/** The server stores at most this (settings.ts clamps it), so the field refuses more instead of silently saving less. */
const MAX_COST_CAP_USD = 50

/** Keyed by the saved value, so it resets itself after every save. */
function CostCapInput({ value, busy, onSave }: { value: number; busy: boolean; onSave: (v: number) => void }) {
  const [draft, setDraft] = useState(Number.isFinite(value) ? String(value) : '')
  const [error, setError] = useState<string | null>(null)
  const parsed = Number(draft)
  const changed = draft.trim() !== '' && parsed !== value

  function commit() {
    if (!changed) return
    if (!Number.isFinite(parsed) || parsed < 0.1 || parsed > MAX_COST_CAP_USD) {
      setError(`Between $0.10 and $${MAX_COST_CAP_USD}.`)
      return
    }
    setError(null)
    onSave(Math.round(parsed * 100) / 100)
  }

  return (
    <span className="flex flex-col gap-1">
      <span className="flex gap-2">
        <span className="relative flex-1">
          <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 font-mono text-[12.5px] text-muted-foreground">
            $
          </span>
          <input
            value={draft}
            inputMode="decimal"
            disabled={busy}
            onChange={(e) => {
              setDraft(e.target.value)
              if (error) setError(null)
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                commit()
              }
              if (e.key === 'Escape') setDraft(String(value))
            }}
            className={cn(fieldClass, 'pl-6 font-mono tabular-nums')}
          />
        </span>
        {changed && (
          <button type="button" onClick={commit} disabled={busy} className={cn(btnSmall, 'h-auto')}>
            Save
          </button>
        )}
      </span>
      {error && <span className="text-[11.5px] text-destructive">{error}</span>}
    </span>
  )
}

/* -------------------------------------------------------------------------- */
/*  Setup checklist                                                           */
/* -------------------------------------------------------------------------- */

type SetupRow = {
  key: string
  label: string
  required: boolean
  state: IntegrationState | undefined
  extra?: React.ReactNode
}

function Meta({ children }: { children: React.ReactNode }) {
  return <span className="font-mono text-[11.5px] font-normal text-muted-foreground">{children}</span>
}

function SetupCard({ integrations, className }: { integrations: SeoIntegrations | undefined; className?: string }) {
  const i = integrations
  const gscEmail = i?.searchConsole?.serviceAccountEmail ?? null
  const rows: SetupRow[] = [
    {
      key: 'anthropic',
      label: 'Claude API key',
      required: true,
      state: i?.anthropic,
      extra: i?.anthropic?.ok && i.anthropic.source ? <Meta>{i.anthropic.source === 'env' ? 'from env' : 'from Vault'}</Meta> : null,
    },
    {
      key: 'github',
      label: 'GitHub token',
      required: true,
      state: i?.github,
      extra: i?.github?.login ? <Meta>@{i.github.login}</Meta> : null,
    },
    { key: 'pagespeed', label: 'PageSpeed Insights key', required: false, state: i?.pagespeed },
    {
      key: 'searchConsole',
      label: 'Search Console',
      required: false,
      state: i?.searchConsole,
      extra: gscEmail ? (
        <span className="inline-flex min-w-0 items-center gap-1.5">
          <span className="truncate">
            <Meta>{gscEmail}</Meta>
          </span>
          <CopyButton value={gscEmail} label="Copy" />
        </span>
      ) : null,
    },
    {
      key: 'lovable',
      label: 'Lovable publishing',
      required: false,
      state: i?.lovable,
      extra: i?.lovable?.account ? <Meta>{i.lovable.account}</Meta> : null,
    },
  ]
  const connected = rows.filter((r) => r.state?.ok).length
  const requiredOk = rows.every((r) => !r.required || r.state?.ok)
  // Open by default until the required keys are in; after that it folds
  // to one line. A click overrides either way.
  const [open, setOpen] = useState<boolean | null>(null)
  const expanded = open ?? !requiredOk
  const channel = (i?.slackChannel ?? '').replace(/^#/, '')

  return (
    <Card
      className={className}
      title="Setup"
      hint={`${connected} of ${rows.length} connected`}
      actions={
        <>
          <Link href="/vault" className={btnSmall}>
            <KeyRound className="h-3 w-3" /> Vault
          </Link>
          <button type="button" onClick={() => setOpen(!expanded)} className={btnSmall} aria-expanded={expanded}>
            {expanded ? 'Hide' : 'Details'}
          </button>
        </>
      }
    >
      {expanded ? (
        <ul className="flex flex-col gap-3.5">
          {rows.map((r) => {
            const ok = !!r.state?.ok
            return (
              <li key={r.key} className="flex items-start gap-3">
                {ok ? (
                  <CircleCheck className="mt-0.5 h-4 w-4 shrink-0 text-foreground" aria-label="Connected" />
                ) : r.required ? (
                  <CircleAlert className="mt-0.5 h-4 w-4 shrink-0 text-warning" aria-label="Missing, required" />
                ) : (
                  <Circle className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground/50" aria-label="Not connected" />
                )}
                <div className="min-w-0 flex-1">
                  <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px] font-medium">
                    {r.label}
                    <span className="eyebrow text-muted-foreground/70">{r.required ? 'Required' : 'Optional'}</span>
                    {r.extra}
                  </p>
                  {r.state?.detail && (
                    <p className="mt-0.5 break-words text-[12px] leading-snug text-muted-foreground">{r.state.detail}</p>
                  )}
                </div>
              </li>
            )
          })}
        </ul>
      ) : (
        <ul className="flex flex-wrap gap-x-4 gap-y-2">
          {rows.map((r) => (
            <li key={r.key} className="inline-flex items-center gap-1.5 text-[12.5px]" title={r.state?.detail}>
              {r.state?.ok ? (
                <CircleCheck className="h-3.5 w-3.5 text-foreground" />
              ) : (
                <Circle className="h-3.5 w-3.5 text-muted-foreground/50" />
              )}
              <span className={r.state?.ok ? 'text-foreground/85' : 'text-muted-foreground'}>{r.label}</span>
            </li>
          ))}
        </ul>
      )}
      <LovableConnect state={i?.lovable} />
      {channel && (
        <p className="mt-4 border-t border-border-soft pt-3 text-[12.5px] text-muted-foreground">
          Weekly summaries post to <span className="font-mono text-foreground/85">#{channel}</span> in Slack.
        </p>
      )}
    </Card>
  )
}

/* -------------------------------------------------------------------------- */
/*  Add site                                                                  */
/* -------------------------------------------------------------------------- */

function AddSiteDialog({
  clients,
  now,
  onClose,
  onCreated,
}: {
  clients: SeoOverviewResponse['clients']
  now: number
  onClose: () => void
  onCreated: (site: SeoSiteDetail) => void
}) {
  const qc = useQueryClient()
  const [source, setSource] = useState<'client' | 'other'>(clients.length > 0 ? 'client' : 'other')
  const [clientId, setClientId] = useState<string | null>(null)
  const [name, setName] = useState('')
  const [liveUrl, setLiveUrl] = useState('')
  // null = the person hasn't chosen, so the repo matching the live URL is used.
  const [repoChoice, setRepoChoice] = useState<{ value: string | null } | null>(null)
  const [mode, setMode] = useState<SeoMode | null>(null)
  const [error, setError] = useState<string | null>(null)

  const repos = useGithubRepos()
  const suggested = suggestRepo(normalizeUrl(liveUrl), repos.data ?? [])
  const repo = repoChoice ? repoChoice.value : suggested
  const effectiveMode: SeoMode = !repo ? 'audit' : (mode ?? 'review')

  const create = useMutation({
    mutationFn: (body: CreateSiteBody) =>
      seoFetch<{ site: SeoSiteDetail }>('/api/seo/sites', { method: 'POST', body }),
    onSuccess: ({ site }) => {
      qc.invalidateQueries({ queryKey: seoKeys.overview })
      if (site?.id) onCreated(site)
      else onClose()
    },
    onError: (e: Error) => setError(e.message),
  })

  function pickClient(id: string) {
    setClientId(id || null)
    const c = clients.find((x) => x.id === id)
    if (c) {
      setName(c.name)
      setLiveUrl(c.siteUrl ?? '')
      setRepoChoice(null)
    }
    setError(null)
  }

  function submit(e: React.FormEvent) {
    e.preventDefault()
    if (source === 'client' && !clientId) {
      setError('Pick a client, or switch to “Other site”.')
      return
    }
    const n = name.trim()
    if (!n) {
      setError('Give the site a name.')
      return
    }
    let url: string | null = null
    if (liveUrl.trim()) {
      url = normalizeUrl(liveUrl)
      if (!url) {
        setError('That live URL doesn’t look right — use the full address, e.g. https://example.com.')
        return
      }
    }
    if (!url && !repo) {
      setError('Add the live URL, the GitHub repo, or both.')
      return
    }
    if (
      effectiveMode === 'autopilot' &&
      !window.confirm(
        `Autopilot merges and publishes ${n}’s changes without anyone approving them, whenever every check and the build pass. Start this site on Autopilot?`,
      )
    ) {
      return
    }
    setError(null)
    create.mutate({
      clientId: source === 'client' ? clientId : null,
      name: n,
      liveUrl: url,
      repoFullName: repo,
      mode: effectiveMode,
    })
  }

  return (
    <Modal
      title="Add site"
      subtitle="A site the engine audits every week. Link its GitHub repo to let it commit content; without one it plans and drafts only."
      onClose={onClose}
      busy={create.isPending}
      footer={
        <>
          <button type="button" onClick={onClose} disabled={create.isPending} className={btnGhost}>
            Cancel
          </button>
          <button type="submit" form="seo-add-site" disabled={create.isPending} className={btnPrimary}>
            {create.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
            Add site
          </button>
        </>
      }
    >
      <form id="seo-add-site" onSubmit={submit} className="flex flex-col gap-5">
        <div className="flex flex-col gap-3">
          <Segmented
            value={source}
            onChange={(v) => {
              setSource(v)
              setError(null)
            }}
            options={[
              {
                value: 'client',
                label: 'Client site',
                disabled: clients.length === 0,
                title: clients.length === 0 ? 'Every active client already has an SEO site' : undefined,
              },
              { value: 'other', label: 'Other site' },
            ]}
          />
          {source === 'client' && (
            <Field label="Client" hint="Active clients without an SEO site yet. Picking one fills in the name and the site we built.">
              <select value={clientId ?? ''} onChange={(e) => pickClient(e.target.value)} className={fieldClass}>
                <option value="">Choose a client…</option>
                {clients.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                    {c.siteUrl ? ` — ${hostOf(c.siteUrl)}` : ''}
                  </option>
                ))}
              </select>
            </Field>
          )}
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Name">
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Junior Concrete"
              className={fieldClass}
            />
          </Field>
          <Field
            label="Live URL"
            hint={
              liveUrl.trim() && !normalizeUrl(liveUrl)
                ? 'Not a valid address yet.'
                : 'What the weekly audit crawls — the published site.'
            }
          >
            <span className="relative">
              <Globe className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
              <input
                value={liveUrl}
                onChange={(e) => setLiveUrl(e.target.value)}
                placeholder="https://example.lovable.app"
                spellCheck={false}
                className={cn(fieldClass, 'pl-8 font-mono text-[12.5px]')}
              />
            </span>
          </Field>
        </div>

        <Field
          label="GitHub repo"
          group
          hint={
            suggested && !repoChoice
              ? `Picked ${suggested} because it matches the live URL — change it if that’s wrong.`
              : 'Lovable projects sync to a repo on nxrth007. Optional — GoHighLevel sites have none.'
          }
        >
          <span className="flex items-center gap-2 text-[12px] text-muted-foreground">
            <FolderGit2 className="h-3.5 w-3.5" />
            {repo ? <span className="font-mono text-foreground">{repo}</span> : 'No repo selected'}
          </span>
          <RepoPicker value={repo} onChange={(v) => setRepoChoice({ value: v })} suggested={suggested} now={now} />
        </Field>

        <Field label="Mode" group hint={!repo ? 'Review and Autopilot need a linked repo.' : undefined}>
          <div role="radiogroup" className="grid gap-2 sm:grid-cols-3">
            {MODES.map((m) => {
              const locked = m.value !== 'audit' && !repo
              const active = effectiveMode === m.value
              return (
                <button
                  key={m.value}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  disabled={locked}
                  onClick={() => setMode(m.value)}
                  className={cn(
                    'flex flex-col gap-1 rounded-lg border p-3 text-left transition',
                    active ? 'border-foreground/60 bg-white/[0.05]' : 'border-border hover:border-foreground/25',
                    locked && 'cursor-not-allowed opacity-40 hover:border-border',
                  )}
                >
                  <span className="flex items-center gap-2 text-[13px] font-medium">
                    {active ? <CircleDot className="h-3.5 w-3.5" /> : <Circle className="h-3.5 w-3.5 text-muted-foreground" />}
                    {m.label}
                  </span>
                  <span className="text-[12px] leading-snug text-muted-foreground">{m.blurb}</span>
                </button>
              )
            })}
          </div>
        </Field>

        {error && (
          <p role="alert" className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-[13px] text-destructive">
            {error}
          </p>
        )}
        {repo && effectiveMode !== 'audit' && (
          <p className="text-[12px] leading-snug text-muted-foreground">
            <span className="font-medium text-foreground/85">Next:</span> on the site page, check the business facts
            and install the SEO foundation. Weekly runs only commit content once the foundation is in.
          </p>
        )}
      </form>
    </Modal>
  )
}
