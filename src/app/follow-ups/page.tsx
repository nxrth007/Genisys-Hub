'use client'

/**
 * /follow-ups
 *
 * Unified view of prospects + clients who need a nudge. Pulls from
 * Gmail (alex@ + ethan@ inboxes/sent) and GHL conversations on the
 * Genisys sub-account. Three urgency buckets — see lib/follow-ups.ts
 * for the rules.
 *
 * Per-row actions:
 *   - "Reply" on Gmail rows  → inline drawer composer, sends via
 *                              /api/follow-ups/reply
 *   - "Open in CRM" on GHL rows → click-through to the existing
 *                              /crm/[subName]/[convId] thread page
 *   - "Mark handled" on any   → /api/follow-ups/dismiss, removes
 *                              the card from this user's view
 */
import { useState } from 'react'
import Link from 'next/link'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  PageHeader,
} from '@/components/ui/page-header'
import {
  AlertCircle,
  ArrowRight,
  Building2,
  CheckCheck,
  Clock,
  Inbox,
  Loader2,
  Mail,
  MessageSquare,
  RefreshCcw,
  Send,
  Sparkles,
  X,
} from 'lucide-react'

type FollowUpCandidate = {
  threadKey: string
  source: 'gmail' | 'ghl'
  accountEmail?: string
  contactName: string
  contactHandle: string
  subject: string
  preview: string
  latestDirection: 'inbound' | 'outbound'
  latestAt: string
  daysSinceLatest: number
  messageCount: number
  bucket: 'awaiting' | 'suggest' | 'stale'
  ghl?: {
    conversationId: string
    subAccountVaultName: string
  }
  gmail?: {
    gmailThreadId: string
    inReplyToMessageId: string
    matchedClientName?: string | null
  }
}

type FollowUpResults = {
  awaiting: FollowUpCandidate[]
  suggest: FollowUpCandidate[]
  stale: FollowUpCandidate[]
  counts: { awaiting: number; suggest: number; stale: number; total: number }
  computedAt: string
  lastSyncByAccount: Record<string, string>
  scan: {
    gmailThreadsExamined: number
    gmailThreadsBulkFiltered: number
    gmailThreadsOutreachBlast: number
    gmailThreadsHealthy: number
    gmailThreadsDismissed: number
    ghlConvsFetched: number
    ghlConvsAfterReminderFilter: number
    ghlConvsMatched: number
    ghlConvsConsidered: number
    ghlConvsBucketed: number
    ghlConvsHealthy: number
    ghlConvsDismissed: number
  }
}

type ActiveTab = 'all' | 'awaiting' | 'suggest' | 'stale'

export default function FollowUpsPage() {
  const qc = useQueryClient()
  const [tab, setTab] = useState<ActiveTab>('all')
  const [replyTo, setReplyTo] = useState<FollowUpCandidate | null>(null)

  const query = useQuery<FollowUpResults>({
    queryKey: ['follow-ups'],
    queryFn: async () => {
      const res = await fetch('/api/follow-ups')
      if (!res.ok) {
        const d = await res.json().catch(() => ({}))
        throw new Error(d.error || 'Failed to load follow-ups')
      }
      return res.json()
    },
  })

  const refresh = useMutation({
    mutationFn: async () => {
      // Trigger a Gmail re-sync for both accounts before recomputing,
      // so the page reflects the latest emails. Best-effort — if the
      // sync hiccups, the recompute still runs against whatever's
      // already in the Email table.
      await fetch('/api/gmail/sync', { method: 'POST' }).catch(() => null)
      await qc.invalidateQueries({ queryKey: ['follow-ups'] })
    },
  })

  const data = query.data

  const visible = (() => {
    if (!data) return [] as FollowUpCandidate[]
    if (tab === 'awaiting') return data.awaiting
    if (tab === 'suggest') return data.suggest
    if (tab === 'stale') return data.stale
    return [...data.awaiting, ...data.suggest, ...data.stale]
  })()

  // Split visible candidates by source so the page can render two
  // distinct sections — Alex's spec was "split section between
  // emails and GHL conversations." Cleaner UX than interleaving,
  // makes it obvious when GHL has 0 entries vs. when we just
  // happened to mix emails first.
  const visibleEmail = visible.filter((c) => c.source === 'gmail')
  const visibleGhl = visible.filter((c) => c.source === 'ghl')

  return (
    <div className="mx-auto flex max-w-[1100px] flex-col gap-5">
      <PageHeader
        title="Follow-ups"
        breadcrumbs={[{ label: 'Genisys' }, { label: 'Follow-ups' }]}
        actions={
          <button
            type="button"
            onClick={() => refresh.mutate()}
            disabled={refresh.isPending}
            className="inline-flex items-center gap-2 rounded-full border border-border bg-card px-4 py-2 text-sm font-medium text-foreground transition hover:bg-muted disabled:opacity-50"
          >
            {refresh.isPending ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <RefreshCcw className="h-4 w-4" />
            )}
            Refresh
          </button>
        }
      />

      {/* Pitch line — what this view is. Helps Ethan understand the
          mental model on first open. */}
      <div className="rounded-2xl border border-border bg-card p-4 text-sm shadow-soft">
        <div className="flex items-start gap-2">
          <Sparkles className="mt-0.5 h-4 w-4 flex-shrink-0 text-amber-500" />
          <div>
            <p className="font-medium">Prospects who need a nudge</p>
            <p className="mt-1 text-xs text-muted-foreground">
              Pulled from Alex&apos;s + Ethan&apos;s Gmail and the
              Genisys GHL sub-account. We highlight threads where
              someone&apos;s waiting on you, where we sent a message
              that didn&apos;t get a reply, and conversations that
              have gone quiet. Stuff you handled is hidden — click
              <CheckCheck className="mx-1 inline h-3 w-3" /> on a
              card to mark it done.
            </p>
          </div>
        </div>
      </div>

      {/* Bucket tabs */}
      <div className="flex flex-wrap items-center gap-2">
        <BucketTab
          active={tab === 'all'}
          onClick={() => setTab('all')}
          label="All"
          count={data?.counts.total ?? 0}
          tone="muted"
        />
        <BucketTab
          active={tab === 'awaiting'}
          onClick={() => setTab('awaiting')}
          label="Awaiting reply"
          count={data?.counts.awaiting ?? 0}
          tone="rose"
          icon={<AlertCircle className="h-3.5 w-3.5" />}
        />
        <BucketTab
          active={tab === 'suggest'}
          onClick={() => setTab('suggest')}
          label="Suggest follow-up"
          count={data?.counts.suggest ?? 0}
          tone="amber"
          icon={<Clock className="h-3.5 w-3.5" />}
        />
        <BucketTab
          active={tab === 'stale'}
          onClick={() => setTab('stale')}
          label="Stale"
          count={data?.counts.stale ?? 0}
          tone="zinc"
          icon={<Inbox className="h-3.5 w-3.5" />}
        />
      </div>

      {/* Results */}
      {query.isLoading ? (
        <div className="flex items-center justify-center py-16">
          <Loader2 className="h-6 w-6 animate-spin text-primary" />
        </div>
      ) : query.isError ? (
        <div className="rounded-2xl border border-destructive/30 bg-destructive/5 p-6 text-sm text-destructive">
          {(query.error as Error).message}
        </div>
      ) : data && data.counts.total === 0 ? (
        <div className="rounded-2xl border border-dashed border-border bg-card p-12 text-center">
          <CheckCheck className="mx-auto h-10 w-10 text-emerald-500/60" />
          <p className="mt-3 text-sm font-medium">All caught up</p>
          <p className="mt-1 text-xs text-muted-foreground">
            No prospects waiting on a reply, nothing stale, nothing
            stuck. Nice work.
          </p>
        </div>
      ) : visible.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-border bg-card p-10 text-center text-sm text-muted-foreground">
          Nothing in this bucket right now.
        </div>
      ) : (
        <div className="flex flex-col gap-5">
          <SourceSection
            label="Email follow-ups"
            sublabel="From alex@ + ethan@ Gmail"
            icon={<Mail className="h-4 w-4 text-blue-500" />}
            items={visibleEmail}
            onReply={(c) => setReplyTo(c)}
          />
          <SourceSection
            label="GHL conversations"
            sublabel="Genisys sub-account messages from registered clients"
            icon={
              <MessageSquare className="h-4 w-4 text-violet-500" />
            }
            items={visibleGhl}
            onReply={(c) => setReplyTo(c)}
          />
        </div>
      )}

      {/* Scan diagnostics — surfaced as a per-stage breakdown so
          admin can see exactly where data drops off. Each stage is
          a filter; if the count goes from non-zero to zero between
          two stages, that's the broken/missing piece. */}
      {data && (
        <div className="mt-4 space-y-2 rounded-xl border border-border bg-card/50 p-4 text-[11px] text-muted-foreground shadow-soft">
          <div>
            <div className="mb-1 font-medium text-foreground/80">
              Gmail
            </div>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5">
              <span>{data.scan.gmailThreadsExamined} threads scanned</span>
              <span>→</span>
              <span>{data.scan.gmailThreadsBulkFiltered} bulk filtered</span>
              <span>→</span>
              <span>
                {data.scan.gmailThreadsOutreachBlast} cold-outreach blasts
              </span>
              <span>→</span>
              <span>{data.scan.gmailThreadsHealthy} healthy</span>
              {data.scan.gmailThreadsDismissed > 0 && (
                <>
                  <span>→</span>
                  <span>{data.scan.gmailThreadsDismissed} dismissed</span>
                </>
              )}
            </div>
          </div>
          <div>
            <div className="mb-1 font-medium text-foreground/80">GHL</div>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5">
              <span>{data.scan.ghlConvsFetched} convs from GHL</span>
              <span>→</span>
              <span>
                {data.scan.ghlConvsAfterReminderFilter} non-reminder
              </span>
              <span>→</span>
              <span>{data.scan.ghlConvsMatched} matched a client</span>
              <span>→</span>
              <span>
                {data.scan.ghlConvsConsidered} considered (≤60 days old)
              </span>
              <span>→</span>
              <span>{data.scan.ghlConvsBucketed} bucketed</span>
              {data.scan.ghlConvsHealthy > 0 && (
                <>
                  <span>·</span>
                  <span>{data.scan.ghlConvsHealthy} healthy</span>
                </>
              )}
              {data.scan.ghlConvsDismissed > 0 && (
                <>
                  <span>·</span>
                  <span>{data.scan.ghlConvsDismissed} dismissed</span>
                </>
              )}
            </div>
          </div>
          {Object.keys(data.lastSyncByAccount).length > 0 && (
            <div className="flex flex-wrap items-center gap-x-3 pt-1">
              {Object.entries(data.lastSyncByAccount).map(([email, iso]) => (
                <span key={email}>
                  Last Gmail sync · {email.replace('@leadgenisys.com', '')}:{' '}
                  {formatRelativeShort(iso)}
                </span>
              ))}
            </div>
          )}
          <div className="text-[10px] text-muted-foreground/80">
            Each → is a filter. If GHL shows e.g. &quot;5 from GHL → 5
            non-reminder → 0 matched a client&quot;, the matcher
            isn&apos;t pairing convs with your registered clients —
            usually a contactPhone / contactEmail mismatch on the
            Client record. &quot;Healthy&quot; = recent activity but
            no nudge needed yet.
          </div>
        </div>
      )}

      {replyTo && (
        <ReplyDrawer
          candidate={replyTo}
          onClose={() => setReplyTo(null)}
        />
      )}
    </div>
  )
}

/** Short relative time helper for the diagnostic footer.
 *  "5m ago" / "2h ago" / "3d ago". */
function formatRelativeShort(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime()
  if (isNaN(ms) || ms < 0) return 'just now'
  const m = Math.floor(ms / 60_000)
  if (m < 1) return 'just now'
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  const d = Math.floor(h / 24)
  return `${d}d ago`
}

/* -------------------------------------------------------------------------- */

/* Section header + cards for one source (Email OR GHL). Always
   renders the header even when empty so admin sees the count
   explicitly — answers "is GHL even being checked?" without us
   guessing. */
function SourceSection({
  label,
  sublabel,
  icon,
  items,
  onReply,
}: {
  label: string
  sublabel: string
  icon: React.ReactNode
  items: FollowUpCandidate[]
  onReply: (c: FollowUpCandidate) => void
}) {
  return (
    <section>
      <div className="mb-2 flex items-baseline justify-between gap-3">
        <div className="flex items-center gap-2">
          {icon}
          <h3 className="text-sm font-semibold tracking-tight">
            {label}
          </h3>
          <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium tabular-nums text-muted-foreground">
            {items.length}
          </span>
        </div>
        <p className="text-[11px] text-muted-foreground">{sublabel}</p>
      </div>
      {items.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border bg-card/50 p-5 text-center text-xs text-muted-foreground">
          Nothing in this section right now.
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {items.map((c) => (
            <CandidateCard
              key={c.threadKey}
              candidate={c}
              onReply={() => onReply(c)}
            />
          ))}
        </div>
      )}
    </section>
  )
}

function BucketTab({
  active,
  onClick,
  label,
  count,
  tone,
  icon,
}: {
  active: boolean
  onClick: () => void
  label: string
  count: number
  tone: 'rose' | 'amber' | 'zinc' | 'muted'
  icon?: React.ReactNode
}) {
  const toneCls =
    tone === 'rose'
      ? 'text-rose-700 bg-rose-50 border-rose-200 dark:text-rose-300 dark:bg-rose-950/40 dark:border-rose-900'
      : tone === 'amber'
        ? 'text-amber-700 bg-amber-50 border-amber-200 dark:text-amber-300 dark:bg-amber-950/40 dark:border-amber-900'
        : tone === 'zinc'
          ? 'text-zinc-600 bg-zinc-100 border-zinc-200 dark:text-zinc-300 dark:bg-zinc-900 dark:border-zinc-800'
          : 'text-foreground bg-card border-border'
  const activeCls = active
    ? 'ring-2 ring-primary/30 border-primary/40'
    : 'hover:bg-muted'
  return (
    <button
      type="button"
      onClick={onClick}
      className={`inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs font-medium transition ${toneCls} ${activeCls}`}
    >
      {icon}
      <span>{label}</span>
      <span className="rounded-full bg-white/60 px-1.5 text-[10px] font-semibold tabular-nums dark:bg-black/30">
        {count}
      </span>
    </button>
  )
}

function CandidateCard({
  candidate,
  onReply,
}: {
  candidate: FollowUpCandidate
  onReply: () => void
}) {
  const qc = useQueryClient()
  const dismiss = useMutation({
    mutationFn: async () => {
      const res = await fetch('/api/follow-ups/dismiss', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          threadKey: candidate.threadKey,
          contactLabel: candidate.contactName,
        }),
      })
      if (!res.ok) throw new Error('Failed to dismiss')
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['follow-ups'] })
    },
  })

  const bucketTone =
    candidate.bucket === 'awaiting'
      ? 'border-l-rose-400'
      : candidate.bucket === 'suggest'
        ? 'border-l-amber-400'
        : 'border-l-zinc-300 dark:border-l-zinc-700'

  const sourceIcon =
    candidate.source === 'gmail' ? (
      <Mail className="h-3 w-3" />
    ) : (
      <MessageSquare className="h-3 w-3" />
    )

  const sourceLabel =
    candidate.source === 'gmail'
      ? `Gmail · ${candidate.accountEmail?.replace('@leadgenisys.com', '') ?? '?'}`
      : 'GHL conversation'

  return (
    <div
      className={`flex flex-col gap-3 rounded-2xl border border-l-4 border-border bg-card p-4 shadow-soft transition hover:bg-muted/30 sm:flex-row sm:items-start ${bucketTone}`}
    >
      <div className="min-w-0 flex-1 space-y-1.5">
        <div className="flex flex-wrap items-center gap-2">
          <p className="text-sm font-semibold">{candidate.contactName}</p>
          {candidate.gmail?.matchedClientName && (
            <span className="inline-flex items-center gap-1 rounded-full border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-[10px] font-semibold text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-300">
              <Building2 className="h-3 w-3" />
              {candidate.gmail.matchedClientName}
            </span>
          )}
          <span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground">
            {sourceIcon}
            {sourceLabel}
          </span>
        </div>
        <p className="text-xs text-muted-foreground">
          {candidate.contactHandle}
        </p>
        {candidate.subject && (
          <p className="truncate text-xs font-medium">
            {candidate.subject}
          </p>
        )}
        {candidate.preview && (
          <p className="line-clamp-2 text-xs text-muted-foreground">
            {candidate.preview}
          </p>
        )}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 pt-0.5 text-[11px] text-muted-foreground">
          <span>
            {candidate.latestDirection === 'inbound'
              ? 'They wrote'
              : 'You wrote'}{' '}
            {candidate.daysSinceLatest === 0
              ? 'today'
              : candidate.daysSinceLatest === 1
                ? 'yesterday'
                : `${candidate.daysSinceLatest} days ago`}
          </span>
          {candidate.messageCount > 0 && (
            <span>
              {candidate.messageCount} msg
              {candidate.messageCount === 1 ? '' : 's'}
            </span>
          )}
        </div>
      </div>

      <div className="flex flex-row items-center gap-2 sm:flex-shrink-0 sm:flex-col sm:items-stretch">
        {candidate.source === 'gmail' ? (
          <button
            type="button"
            onClick={onReply}
            className="inline-flex items-center justify-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground transition hover:bg-primary/90"
          >
            <Send className="h-3 w-3" />
            Reply
          </button>
        ) : (
          <Link
            href={`/crm/${encodeURIComponent(candidate.ghl?.subAccountVaultName ?? '')}/${candidate.ghl?.conversationId ?? ''}`}
            className="inline-flex items-center justify-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground transition hover:bg-primary/90"
          >
            <ArrowRight className="h-3 w-3" />
            Open in CRM
          </Link>
        )}
        <button
          type="button"
          onClick={() => dismiss.mutate()}
          disabled={dismiss.isPending}
          className="inline-flex items-center justify-center gap-1.5 rounded-md border border-border bg-card px-3 py-1.5 text-xs font-medium text-foreground/80 transition hover:bg-muted disabled:opacity-50"
          title="Mark this thread as handled — hides it for you, doesn't affect anyone else."
        >
          {dismiss.isPending ? (
            <Loader2 className="h-3 w-3 animate-spin" />
          ) : (
            <CheckCheck className="h-3 w-3" />
          )}
          Mark handled
        </button>
      </div>
    </div>
  )
}

/* -------------------------------------------------------------------------- */
/*  Reply drawer — inline composer for Gmail threads                          */
/* -------------------------------------------------------------------------- */

function ReplyDrawer({
  candidate,
  onClose,
}: {
  candidate: FollowUpCandidate
  onClose: () => void
}) {
  const qc = useQueryClient()
  const [message, setMessage] = useState('')

  const baseSubject = candidate.subject || ''
  const subject = baseSubject.toLowerCase().startsWith('re:')
    ? baseSubject
    : `Re: ${baseSubject || 'follow-up'}`

  const send = useMutation({
    mutationFn: async () => {
      if (!candidate.gmail || !candidate.accountEmail) {
        throw new Error('Reply only available on Gmail threads.')
      }
      const res = await fetch('/api/follow-ups/reply', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          threadKey: candidate.threadKey,
          accountEmail: candidate.accountEmail,
          to: candidate.contactHandle,
          subject,
          body: message,
          inReplyToMessageId: candidate.gmail.inReplyToMessageId,
        }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || 'Failed to send')
      return data
    },
    onSuccess: async () => {
      // Mark dismissed too — sending a reply is itself a "handled"
      // signal. Saves the user a second click.
      await fetch('/api/follow-ups/dismiss', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          threadKey: candidate.threadKey,
          contactLabel: candidate.contactName,
        }),
      }).catch(() => null)
      qc.invalidateQueries({ queryKey: ['follow-ups'] })
      onClose()
    },
  })

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 sm:items-center">
      <div
        role="dialog"
        aria-modal="true"
        className="w-full max-w-xl rounded-t-2xl border border-border bg-card shadow-2xl sm:rounded-2xl"
      >
        <div className="flex items-start justify-between gap-3 border-b border-border px-5 py-4">
          <div className="min-w-0">
            <p className="text-sm font-semibold">
              Reply to {candidate.contactName}
            </p>
            <p className="mt-0.5 truncate text-xs text-muted-foreground">
              {candidate.contactHandle} · sending from{' '}
              {candidate.accountEmail}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="grid h-7 w-7 place-items-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="space-y-3 p-5">
          <div>
            <label className="mb-1 block text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
              Subject
            </label>
            <p className="rounded-md border border-border bg-muted/50 px-3 py-2 text-sm">
              {subject}
            </p>
          </div>

          {candidate.preview && (
            <details className="rounded-md border border-border bg-muted/30 px-3 py-2 text-xs">
              <summary className="cursor-pointer font-medium text-muted-foreground">
                Show last message preview
              </summary>
              <p className="mt-2 whitespace-pre-wrap text-muted-foreground">
                {candidate.preview}
              </p>
            </details>
          )}

          <div>
            <label className="mb-1 block text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
              Your reply
            </label>
            <textarea
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              autoFocus
              rows={6}
              placeholder="Hey — just checking in..."
              className="w-full rounded-md border border-border bg-card px-3 py-2 text-sm focus:border-primary/40 focus:outline-none focus:ring-2 focus:ring-primary/20"
            />
            <p className="mt-1 text-[11px] text-muted-foreground">
              Plain text or simple markdown (**bold**, [link](url)).
              Reply lands in the original Gmail thread.
            </p>
          </div>

          {send.isError && (
            <div className="rounded-md border border-red-200 bg-red-50 p-2 text-xs text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300">
              {(send.error as Error).message}
            </div>
          )}

          <div className="flex items-center justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded-md border border-border bg-card px-3 py-1.5 text-xs font-medium hover:bg-muted"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => send.mutate()}
              disabled={send.isPending || !message.trim()}
              className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground transition hover:bg-primary/90 disabled:opacity-50"
            >
              {send.isPending ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : (
                <Send className="h-3 w-3" />
              )}
              Send reply
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
