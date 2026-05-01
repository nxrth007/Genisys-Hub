'use client'

import { Fragment, useMemo, useRef, useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useParams, useRouter } from 'next/navigation'
import { Hash, Lock, ArrowLeft, Send, Users, MessageSquare } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Avatar } from '@/components/ui/avatar'

/**
 * Slack channel viewer. Visual goals (mirrors Slack's own layout):
 *   - Wide single-column message list that uses the available width
 *   - Avatar + name on the first message of each author run; grouped
 *     replies sit indented under the same column with no avatar repeat
 *   - Date dividers between calendar days
 *   - Slack escape sequences (<@U…>, <mailto:…>, <url|label>, <#C|name>,
 *     <!channel>) rendered as proper inline elements
 *   - Inline mrkdwn (*bold*, _italic_, ~strike~, `code`) rendered as styles
 *   - Multiline reply input; Cmd/Ctrl+Enter sends without losing the
 *     in-message Enter for paragraph breaks
 */

type SlackMsg = {
  ts: string
  userId: string
  userName: string
  text: string
  threadTs?: string
  replyCount?: number
  timestamp: string
}

type ApiResponse = {
  messages: SlackMsg[]
  channelName: string
  channelTopic: string
  memberCount: number
  userMap: Record<string, string>
}

export default function SlackChannelPage() {
  const params = useParams()
  const router = useRouter()
  const qc = useQueryClient()
  const channelId = params.id as string
  const [reply, setReply] = useState('')
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const didInitialScrollRef = useRef(false)

  const { data, isLoading, error } = useQuery<ApiResponse>({
    queryKey: ['slack-messages', channelId],
    queryFn: async () => {
      const res = await fetch(`/api/slack/channels/${channelId}/messages`)
      if (!res.ok) {
        const d = await res.json().catch(() => ({}))
        throw new Error(d.error || 'Failed to load messages')
      }
      return res.json()
    },
    refetchInterval: 15000, // Poll every 15s for new messages.
  })

  const sendMutation = useMutation({
    mutationFn: async (text: string) => {
      const res = await fetch(`/api/slack/channels/${channelId}/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text }),
      })
      if (!res.ok) {
        const d = await res.json().catch(() => ({}))
        throw new Error(d.error || 'Send failed')
      }
      return res.json()
    },
    onSuccess: () => {
      setReply('')
      qc.invalidateQueries({ queryKey: ['slack-messages', channelId] })
    },
  })

  const messages = data?.messages ?? []
  const userMap = data?.userMap ?? {}
  const channelName = data?.channelName ?? channelId
  const channelTopic = data?.channelTopic ?? ''
  const memberCount = data?.memberCount ?? 0

  // Auto-scroll behavior: instant on first paint (so the user lands at
  // the latest message), smooth on subsequent updates (so new arrivals
  // feel animated rather than jumping).
  useEffect(() => {
    if (!messagesEndRef.current) return
    const behavior: ScrollBehavior = didInitialScrollRef.current
      ? 'smooth'
      : 'auto'
    messagesEndRef.current.scrollIntoView({ behavior })
    if (messages.length > 0) didInitialScrollRef.current = true
  }, [messages.length])

  function handleSend() {
    const text = reply.trim()
    if (text) sendMutation.mutate(text)
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    // Cmd/Ctrl+Enter sends; bare Enter inserts a newline. This matches
    // Slack's own behavior on the desktop client.
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault()
      handleSend()
    }
  }

  return (
    <div className="flex h-[calc(100vh-7rem)] w-full flex-col">
      {/* ---- Header --------------------------------------------------- */}
      <div className="mb-3 flex items-start gap-3 border-b border-zinc-200 pb-3 dark:border-zinc-800">
        <button
          onClick={() => router.push('/slack')}
          className="mt-0.5 rounded-md p-1.5 text-zinc-400 transition hover:bg-zinc-100 hover:text-zinc-900 dark:hover:bg-zinc-800 dark:hover:text-zinc-100"
          aria-label="Back to channels"
        >
          <ArrowLeft className="h-4 w-4" />
        </button>
        <div className="grid h-9 w-9 flex-shrink-0 place-items-center rounded-lg bg-zinc-100 dark:bg-zinc-800">
          <Hash className="h-4 w-4 text-zinc-500" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h2 className="truncate text-lg font-semibold tracking-tight">
              {channelName}
            </h2>
            {memberCount > 0 && (
              <span className="inline-flex items-center gap-1 rounded-full bg-zinc-100 px-2 py-0.5 text-[11px] font-medium text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300">
                <Users className="h-3 w-3" />
                {memberCount}
              </span>
            )}
          </div>
          {channelTopic && (
            <p className="mt-0.5 truncate text-xs text-zinc-500">
              {channelTopic}
            </p>
          )}
        </div>
      </div>

      {/* ---- Messages ------------------------------------------------- */}
      <div className="flex-1 overflow-y-auto rounded-xl border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900">
        {isLoading ? (
          <div className="flex h-full items-center justify-center text-sm text-zinc-500">
            Loading messages…
          </div>
        ) : error ? (
          <div className="p-6 text-center text-sm text-red-600">
            {(error as Error).message}
          </div>
        ) : messages.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-sm text-zinc-500">
            <MessageSquare className="h-8 w-8 text-zinc-300" />
            <p>No messages in this channel yet.</p>
          </div>
        ) : (
          <MessageList messages={messages} userMap={userMap} />
        )}
        <div ref={messagesEndRef} />
      </div>

      {/* ---- Reply ---------------------------------------------------- */}
      <form
        onSubmit={(e) => {
          e.preventDefault()
          handleSend()
        }}
        className="mt-3"
      >
        <div className="flex items-end gap-2 rounded-xl border border-zinc-200 bg-white p-2 shadow-sm focus-within:border-blue-500 dark:border-zinc-800 dark:bg-zinc-900">
          <textarea
            value={reply}
            onChange={(e) => setReply(e.target.value)}
            onKeyDown={handleKeyDown}
            rows={2}
            placeholder={`Message #${channelName}…  (⌘/Ctrl+Enter to send)`}
            className="max-h-40 min-h-[44px] flex-1 resize-y bg-transparent px-2 py-1.5 text-sm focus:outline-none"
            disabled={sendMutation.isPending}
          />
          <button
            type="submit"
            disabled={sendMutation.isPending || !reply.trim()}
            className={cn(
              'inline-flex flex-shrink-0 items-center gap-1.5 rounded-lg bg-blue-600 px-3.5 py-2 text-sm font-medium text-white transition hover:bg-blue-700 disabled:opacity-50'
            )}
          >
            <Send className="h-3.5 w-3.5" />
            {sendMutation.isPending ? 'Sending…' : 'Send'}
          </button>
        </div>
      </form>

      {sendMutation.isError && (
        <p className="mt-2 text-xs text-red-500">
          Failed: {(sendMutation.error as Error).message}
        </p>
      )}
    </div>
  )
}

/* -------------------------------------------------------------------------- */
/*  Message list — groups + date dividers                                      */
/* -------------------------------------------------------------------------- */

/**
 * Group consecutive messages from the same author within a 5-minute
 * window so the avatar + name only show on the first message of each
 * run. Inserts date dividers when the calendar day changes between
 * consecutive groups.
 */
type RenderItem =
  | { kind: 'divider'; key: string; label: string }
  | {
      kind: 'group'
      key: string
      authorId: string
      authorName: string
      timestamp: string
      messages: SlackMsg[]
    }

function MessageList({
  messages,
  userMap,
}: {
  messages: SlackMsg[]
  userMap: Record<string, string>
}) {
  const items = useMemo<RenderItem[]>(
    () => buildRenderItems(messages),
    [messages]
  )

  return (
    <div className="px-4 py-3">
      {items.map((item) => {
        if (item.kind === 'divider') {
          return (
            <div
              key={item.key}
              className="my-3 flex items-center gap-3 first:mt-0"
            >
              <div className="h-px flex-1 bg-zinc-200 dark:bg-zinc-800" />
              <span className="rounded-full border border-zinc-200 bg-white px-2.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-zinc-500 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-400">
                {item.label}
              </span>
              <div className="h-px flex-1 bg-zinc-200 dark:bg-zinc-800" />
            </div>
          )
        }
        return <MessageGroup key={item.key} group={item} userMap={userMap} />
      })}
    </div>
  )
}

function buildRenderItems(messages: SlackMsg[]): RenderItem[] {
  const items: RenderItem[] = []
  let lastDayKey: string | null = null
  let currentGroup: Extract<RenderItem, { kind: 'group' }> | null = null
  const FIVE_MIN = 5 * 60 * 1000

  for (const m of messages) {
    const t = new Date(m.timestamp || 0)
    const dayKey = isNaN(t.getTime())
      ? 'unknown'
      : `${t.getFullYear()}-${t.getMonth()}-${t.getDate()}`

    if (dayKey !== lastDayKey) {
      items.push({
        kind: 'divider',
        key: `divider-${dayKey}-${m.ts}`,
        label: formatDayLabel(t),
      })
      lastDayKey = dayKey
      currentGroup = null
    }

    const last = currentGroup?.messages[currentGroup.messages.length - 1]
    const sameAuthor = currentGroup && currentGroup.authorId === m.userId
    const closeInTime =
      last &&
      new Date(m.timestamp).getTime() - new Date(last.timestamp).getTime() <
        FIVE_MIN

    if (currentGroup && sameAuthor && closeInTime) {
      currentGroup.messages.push(m)
    } else {
      currentGroup = {
        kind: 'group',
        key: `group-${m.ts}`,
        authorId: m.userId,
        authorName: m.userName,
        timestamp: m.timestamp,
        messages: [m],
      }
      items.push(currentGroup)
    }
  }

  return items
}

function MessageGroup({
  group,
  userMap,
}: {
  group: Extract<RenderItem, { kind: 'group' }>
  userMap: Record<string, string>
}) {
  return (
    <div className="group/msg mt-3 grid grid-cols-[40px_1fr] gap-3 first:mt-0">
      <div className="pt-0.5">
        <Avatar name={group.authorName} email={group.authorId} size="md" />
      </div>
      <div className="min-w-0">
        <div className="flex items-baseline gap-2">
          <span className="text-sm font-semibold">{group.authorName}</span>
          <span className="text-[11px] text-zinc-400">
            {formatMsgTime(group.timestamp)}
          </span>
        </div>
        {group.messages.map((m, i) => (
          <div key={m.ts} className={cn('text-sm leading-relaxed', i > 0 && 'mt-0.5')}>
            <SlackText text={m.text} userMap={userMap} />
            {!!m.replyCount && m.replyCount > 0 && (
              <button
                type="button"
                className="mt-1 inline-flex items-center gap-1 rounded-md bg-blue-50 px-2 py-0.5 text-[11px] font-medium text-blue-700 transition hover:bg-blue-100 dark:bg-blue-950/50 dark:text-blue-300 dark:hover:bg-blue-950"
                title="Thread navigation coming soon"
              >
                <MessageSquare className="h-3 w-3" />
                {m.replyCount} {m.replyCount === 1 ? 'reply' : 'replies'}
              </button>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}

/* -------------------------------------------------------------------------- */
/*  Slack text rendering — escape sequences + mrkdwn                           */
/* -------------------------------------------------------------------------- */

/**
 * Render a Slack message body with all the inline goodies:
 *   - <@U123>            → @display name (chip)
 *   - <#C123|name>       → #name (chip)
 *   - <!channel|here|everyone> → @broadcast (chip)
 *   - <mailto:foo|label> → clickable email link
 *   - <url|label>        → clickable link
 *   - *bold* / _italic_ / ~strike~ / `code`
 *   - HTML entities (&amp; &lt; &gt;)
 *   - Newlines preserved as paragraph breaks
 *
 * Two-pass strategy: split on Slack's `<…>` escapes first (they're
 * unambiguous), then run inline mrkdwn on the plain-text segments
 * between them. Keeps the regex sane and prevents formatting markers
 * from being swallowed by URL labels.
 */
function SlackText({
  text,
  userMap,
}: {
  text: string
  userMap: Record<string, string>
}) {
  const lines = decodeSlackEntities(text).split('\n')
  return (
    <div className="break-words text-zinc-700 dark:text-zinc-300">
      {lines.map((line, i) => (
        <p key={i} className={i > 0 ? 'mt-1' : ''}>
          {line.length === 0 ? ' ' : renderInline(line, userMap)}
        </p>
      ))}
    </div>
  )
}

const ESCAPE_RE =
  /<@([A-Z0-9]+)>|<!(channel|here|everyone)(?:\|[^>]*)?>|<#[A-Z0-9]+\|([^>]+)>|<mailto:([^|>]+)\|([^>]+)>|<mailto:([^>]+)>|<((?:https?|ftp):\/\/[^|>]+)\|([^>]+)>|<((?:https?|ftp):\/\/[^>]+)>/g

function renderInline(
  line: string,
  userMap: Record<string, string>
): ReactNode[] {
  const out: ReactNode[] = []
  let lastIdx = 0
  let key = 0

  for (const m of line.matchAll(ESCAPE_RE)) {
    const idx = m.index ?? 0
    if (idx > lastIdx) {
      // Plain text segment — run mrkdwn formatter over it.
      out.push(
        <Fragment key={`t-${key++}`}>
          {renderMrkdwn(line.slice(lastIdx, idx))}
        </Fragment>
      )
    }

    if (m[1]) {
      const name = userMap[m[1]] ?? m[1]
      out.push(<Mention key={`m-${key++}`}>@{name}</Mention>)
    } else if (m[2]) {
      out.push(<Mention key={`m-${key++}`}>@{m[2]}</Mention>)
    } else if (m[3]) {
      out.push(<Mention key={`m-${key++}`}>#{m[3]}</Mention>)
    } else if (m[4] && m[5]) {
      out.push(
        <ExternalLink key={`l-${key++}`} href={`mailto:${m[4]}`}>
          {m[5]}
        </ExternalLink>
      )
    } else if (m[6]) {
      out.push(
        <ExternalLink key={`l-${key++}`} href={`mailto:${m[6]}`}>
          {m[6]}
        </ExternalLink>
      )
    } else if (m[7] && m[8]) {
      out.push(
        <ExternalLink key={`l-${key++}`} href={m[7]} external>
          {m[8]}
        </ExternalLink>
      )
    } else if (m[9]) {
      out.push(
        <ExternalLink key={`l-${key++}`} href={m[9]} external>
          {m[9]}
        </ExternalLink>
      )
    }

    lastIdx = idx + m[0].length
  }

  if (lastIdx < line.length) {
    out.push(
      <Fragment key={`t-${key++}`}>
        {renderMrkdwn(line.slice(lastIdx))}
      </Fragment>
    )
  }

  return out
}

/**
 * Apply Slack inline mrkdwn (*bold*, _italic_, ~strike~, `code`) to a
 * plain-text segment. Greedy single-pass tokenizer — picks the earliest
 * matching delimiter and recurses on the body so nesting works (e.g.
 * "*important `code`*").
 */
function renderMrkdwn(s: string): ReactNode[] {
  const out: ReactNode[] = []
  let key = 0
  let rest = s
  // Order matters: `code` first (its body shouldn't be re-parsed), then
  // bold/italic/strike. Slack requires non-whitespace adjacent to the
  // delimiter, hence the (?=\S) / (?<=\S) lookarounds.
  const PATTERNS: Array<{
    re: RegExp
    wrap: (children: ReactNode) => ReactNode
    recurse: boolean
  }> = [
    {
      re: /`([^`\n]+)`/,
      wrap: (c) => (
        <code className="rounded bg-zinc-100 px-1 py-0.5 font-mono text-[12.5px] text-zinc-800 dark:bg-zinc-800 dark:text-zinc-200">
          {c}
        </code>
      ),
      recurse: false,
    },
    {
      re: /\*(?=\S)([^*\n]+?)(?<=\S)\*/,
      wrap: (c) => <strong className="font-semibold">{c}</strong>,
      recurse: true,
    },
    {
      re: /_(?=\S)([^_\n]+?)(?<=\S)_/,
      wrap: (c) => <em className="italic">{c}</em>,
      recurse: true,
    },
    {
      re: /~(?=\S)([^~\n]+?)(?<=\S)~/,
      wrap: (c) => <span className="line-through">{c}</span>,
      recurse: true,
    },
  ]

  while (rest.length > 0) {
    let bestIdx = -1
    let bestMatch: RegExpMatchArray | null = null
    let bestPattern: (typeof PATTERNS)[number] | null = null

    for (const p of PATTERNS) {
      const m = rest.match(p.re)
      if (m && m.index !== undefined && (bestIdx === -1 || m.index < bestIdx)) {
        bestIdx = m.index
        bestMatch = m
        bestPattern = p
      }
    }

    if (!bestMatch || !bestPattern || bestIdx < 0) {
      out.push(<Fragment key={key++}>{rest}</Fragment>)
      break
    }

    if (bestIdx > 0) {
      out.push(<Fragment key={key++}>{rest.slice(0, bestIdx)}</Fragment>)
    }
    const inner = bestMatch[1]
    out.push(
      <Fragment key={key++}>
        {bestPattern.wrap(
          bestPattern.recurse ? renderMrkdwn(inner) : inner
        )}
      </Fragment>
    )
    rest = rest.slice(bestIdx + bestMatch[0].length)
  }

  return out
}

function decodeSlackEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
}

function Mention({ children }: { children: ReactNode }) {
  return (
    <span className="rounded bg-blue-100 px-1 py-0.5 text-[13px] font-medium text-blue-700 dark:bg-blue-950/50 dark:text-blue-300">
      {children}
    </span>
  )
}

function ExternalLink({
  href,
  children,
  external,
}: {
  href: string
  children: ReactNode
  external?: boolean
}) {
  return (
    <a
      href={href}
      target={external ? '_blank' : undefined}
      rel={external ? 'noreferrer' : undefined}
      className="break-all text-blue-600 underline decoration-blue-200 underline-offset-2 hover:decoration-blue-500 dark:text-blue-400 dark:decoration-blue-900"
    >
      {children}
    </a>
  )
}

/* -------------------------------------------------------------------------- */
/*  Date / time formatting                                                     */
/* -------------------------------------------------------------------------- */

function formatMsgTime(iso: string): string {
  if (!iso) return ''
  try {
    const d = new Date(iso)
    return d.toLocaleTimeString('en-US', {
      hour: 'numeric',
      minute: '2-digit',
    })
  } catch {
    return iso
  }
}

/**
 * "Today" / "Yesterday" for the recent days, full weekday + date for
 * anything older. Matches Slack's own day-divider phrasing.
 */
function formatDayLabel(d: Date): string {
  if (isNaN(d.getTime())) return 'Unknown'
  const now = new Date()
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const startOfDay = new Date(d.getFullYear(), d.getMonth(), d.getDate())
  const diffDays = Math.round(
    (startOfToday.getTime() - startOfDay.getTime()) / (24 * 60 * 60 * 1000)
  )
  if (diffDays === 0) return 'Today'
  if (diffDays === 1) return 'Yesterday'
  if (diffDays < 7) {
    return d.toLocaleDateString('en-US', { weekday: 'long' })
  }
  return d.toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: d.getFullYear() === now.getFullYear() ? undefined : 'numeric',
  })
}

// Suppress unused-import warning — Lock isn't currently used by this
// page but it's reserved for the upcoming "private" badge in the
// header for private channels (mirrors the channel-list page).
void Lock
