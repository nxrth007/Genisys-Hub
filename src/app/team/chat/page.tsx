'use client'

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
} from 'react'
import Link from 'next/link'
import { signOut } from 'next-auth/react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  ArrowLeft,
  ImageIcon,
  Loader2,
  LogOut,
  Send,
  Target,
  X,
} from 'lucide-react'
import { Avatar } from '@/components/ui/avatar'
import { cn } from '@/lib/utils'

/**
 * /team/chat — internal group chat for Team #1.
 *
 * Single shared room. Polling-based "live" updates (15s + refetch
 * on window focus). Lifted patterns from src/app/slack/[id]/page.tsx
 * for grouping + auto-scroll + date dividers.
 *
 * Permissions: middleware gates /team/* to team_member; the chat
 * API additionally allows admin/member so Alex/Ethan can post too.
 * Mary (role=agent) doesn't reach this page — by design, she has
 * her own surfaces.
 */

type Attachment = {
  id: string
  filename: string
  mimeType: string
  sizeBytes: number
  createdAt: string
}

type Message = {
  id: string
  senderId: string | null
  senderName: string
  senderImage: string | null
  /** Sender's CURRENT role at fetch time. Drives the animated
   *  "Admin" chip next to Alex/Ethan's names. Null when the sender
   *  was deleted. Updated live (not snapshotted) so a role change
   *  reflects on next poll without a DB rewrite. */
  senderRole: string | null
  text: string
  createdAt: string
  attachments: Attachment[]
}

type Channel = {
  id: string
  slug: string
  name: string
  teamNumber: number
}

const POLL_INTERVAL_MS = 15_000
const PHOTO_MAX_BYTES = 5 * 1024 * 1024
const ACCEPTED_MIMES = new Set(['image/jpeg', 'image/png'])

export default function TeamChatPage() {
  const qc = useQueryClient()

  // Channel list is one row in v1 but we still fetch through the
  // API — keeps the URL contract future-friendly for multi-channel.
  const channelsQuery = useQuery<{ channels: Channel[] }>({
    queryKey: ['team-chat-channels'],
    queryFn: async () => {
      const res = await fetch('/api/team/chat/channels')
      if (!res.ok) {
        const d = await res.json().catch(() => ({}))
        throw new Error(d.error || 'Failed to load channel list')
      }
      return res.json()
    },
  })
  const channel = channelsQuery.data?.channels[0] ?? null

  const messagesQuery = useQuery<{ messages: Message[]; hasMore: boolean }>({
    queryKey: ['team-chat-messages', channel?.id],
    queryFn: async () => {
      if (!channel) return { messages: [], hasMore: false }
      const res = await fetch(
        `/api/team/chat/channels/${channel.id}/messages`,
      )
      if (!res.ok) {
        const d = await res.json().catch(() => ({}))
        throw new Error(d.error || 'Failed to load messages')
      }
      return res.json()
    },
    // Two layers of "show me new messages": 15s poll + window focus.
    // Without focus-refetch, Mary tabbing away and back sees stale
    // messages until the next 15s tick.
    refetchInterval: channel ? POLL_INTERVAL_MS : false,
    refetchOnWindowFocus: !!channel,
    enabled: !!channel,
  })

  const messages = useMemo(() => {
    // API returns newest-first for cursor convenience; flip for UI
    // so the freshest message is at the bottom.
    return (messagesQuery.data?.messages ?? []).slice().reverse()
  }, [messagesQuery.data])

  // Auto-scroll to the bottom. Track whether we've done the
  // initial paint scroll so subsequent refetches don't animate.
  // Matches the Slack viewer pattern.
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const didInitialScrollRef = useRef(false)
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const behavior = didInitialScrollRef.current ? 'smooth' : 'auto'
    el.scrollTo({ top: el.scrollHeight, behavior })
    if (messages.length > 0) didInitialScrollRef.current = true
  }, [messages])

  // --- Composer state ---------------------------------------------------
  const [text, setText] = useState('')
  const [stagedFiles, setStagedFiles] = useState<File[]>([])
  const [composerError, setComposerError] = useState<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement | null>(null)

  const sendMutation = useMutation({
    mutationFn: async () => {
      if (!channel) throw new Error('No channel loaded')
      const fd = new FormData()
      fd.append('text', text.trim())
      for (const f of stagedFiles) fd.append('file', f)
      const res = await fetch(
        `/api/team/chat/channels/${channel.id}/messages`,
        { method: 'POST', body: fd },
      )
      const d = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(d.error || 'Send failed')
      return d
    },
    onSuccess: () => {
      setText('')
      setStagedFiles([])
      setComposerError(null)
      qc.invalidateQueries({ queryKey: ['team-chat-messages', channel?.id] })
    },
    onError: (err) => {
      setComposerError(err instanceof Error ? err.message : 'Send failed')
    },
  })

  function onSubmit(e: FormEvent) {
    e.preventDefault()
    if (sendMutation.isPending) return
    if (!text.trim() && stagedFiles.length === 0) return
    sendMutation.mutate()
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    // Cmd/Ctrl+Enter sends — Slack convention, matches existing
    // chat surfaces in the codebase.
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault()
      onSubmit(e as unknown as FormEvent)
    }
  }

  function onFilePick(e: React.ChangeEvent<HTMLInputElement>) {
    const incoming = Array.from(e.target.files ?? [])
    e.target.value = '' // allow re-picking the same file later
    const fresh: File[] = []
    for (const f of incoming) {
      if (!ACCEPTED_MIMES.has(f.type)) {
        setComposerError(`"${f.name}" — JPEG or PNG only.`)
        continue
      }
      if (f.size > PHOTO_MAX_BYTES) {
        setComposerError(`"${f.name}" is over 5 MB. Resize or compress.`)
        continue
      }
      fresh.push(f)
    }
    // Cap at 4 to match the server-side limit.
    setStagedFiles((prev) => [...prev, ...fresh].slice(0, 4))
  }

  function removeStaged(index: number) {
    setStagedFiles((prev) => prev.filter((_, i) => i !== index))
  }

  // Day grouping for date dividers ("Today" / "Yesterday" / weekday).
  const grouped = useMemo(() => groupByDay(messages), [messages])

  return (
    <div className="flex h-screen flex-col bg-zinc-50 dark:bg-zinc-950">
      <header className="border-b border-zinc-200 bg-white px-4 py-3 dark:border-zinc-800 dark:bg-zinc-900">
        <div className="mx-auto flex max-w-4xl items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <Link
              href="/team"
              className="inline-flex items-center gap-1 rounded-md p-1 text-zinc-500 transition hover:bg-zinc-100 hover:text-zinc-700 dark:hover:bg-zinc-800 dark:hover:text-zinc-200"
              aria-label="Back to dashboard"
            >
              <ArrowLeft className="h-4 w-4" />
            </Link>
            <Target className="h-5 w-5 text-blue-600" />
            <div>
              <h1 className="text-sm font-semibold">
                {channel?.name ?? 'Team chat'}
              </h1>
              <p className="text-[10px] text-zinc-500">
                Internal — replaces Microsoft Teams. Photos auto-expire after
                30 days.
              </p>
            </div>
          </div>
          <button
            onClick={() => signOut({ callbackUrl: '/signin/team' })}
            className="inline-flex items-center gap-1 rounded-md border border-zinc-200 bg-white px-2.5 py-1 text-[11px] font-medium text-zinc-700 transition hover:bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-200 dark:hover:bg-zinc-800"
          >
            <LogOut className="h-3 w-3" />
            Sign out
          </button>
        </div>
      </header>

      <div
        ref={scrollRef}
        className="flex-1 overflow-y-auto px-4 py-3"
      >
        <div className="mx-auto max-w-4xl">
          {messagesQuery.isLoading ? (
            <div className="flex h-32 items-center justify-center text-zinc-500">
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              Loading messages…
            </div>
          ) : messages.length === 0 ? (
            <div className="rounded-lg border border-dashed border-zinc-300 bg-white p-8 text-center text-sm text-zinc-500 dark:border-zinc-700 dark:bg-zinc-900">
              No messages yet. Say hi.
            </div>
          ) : (
            <div className="space-y-4">
              {grouped.map((group) => (
                <div key={group.dayKey} className="space-y-1">
                  <div className="sticky top-0 z-10 my-2 flex items-center justify-center">
                    <span className="rounded-full border border-zinc-200 bg-white px-3 py-0.5 text-[10px] font-medium text-zinc-500 dark:border-zinc-700 dark:bg-zinc-900">
                      {group.label}
                    </span>
                  </div>
                  {group.runs.map((run, runIdx) => (
                    <MessageRun key={`${group.dayKey}-${runIdx}`} messages={run} />
                  ))}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      <form
        onSubmit={onSubmit}
        className="border-t border-zinc-200 bg-white px-4 py-3 dark:border-zinc-800 dark:bg-zinc-900"
      >
        <div className="mx-auto max-w-4xl">
          {stagedFiles.length > 0 && (
            <div className="mb-2 flex flex-wrap gap-2">
              {stagedFiles.map((f, i) => (
                <div
                  key={`${f.name}-${i}`}
                  className="flex items-center gap-2 rounded-md border border-zinc-200 bg-zinc-50 px-2 py-1 text-[11px] text-zinc-600 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-300"
                >
                  <ImageIcon className="h-3 w-3" />
                  <span className="max-w-[160px] truncate">{f.name}</span>
                  <button
                    type="button"
                    onClick={() => removeStaged(i)}
                    className="rounded-full p-0.5 text-zinc-400 hover:bg-zinc-200 hover:text-zinc-700 dark:hover:bg-zinc-700 dark:hover:text-zinc-200"
                    aria-label={`Remove ${f.name}`}
                  >
                    <X className="h-3 w-3" />
                  </button>
                </div>
              ))}
            </div>
          )}
          {composerError && (
            <div className="mb-2 rounded-md border border-red-200 bg-red-50 px-2 py-1 text-[11px] text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-300">
              {composerError}
            </div>
          )}
          <div className="flex items-end gap-2">
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className="flex-shrink-0 rounded-md border border-zinc-200 bg-white p-2 text-zinc-500 transition hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300 dark:hover:bg-zinc-800"
              aria-label="Attach photo"
              title="Attach JPEG/PNG photo (max 5 MB each, up to 4)"
            >
              <ImageIcon className="h-4 w-4" />
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/png,image/jpeg"
              multiple
              onChange={onFilePick}
              className="hidden"
            />
            <textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={onKeyDown}
              placeholder="Type a message (Cmd/Ctrl+Enter to send)…"
              rows={1}
              className="min-h-[40px] max-h-[160px] flex-1 resize-none rounded-md border border-zinc-200 bg-white px-3 py-2 text-sm focus:border-blue-500 focus:outline-none dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100"
            />
            <button
              type="submit"
              disabled={
                sendMutation.isPending ||
                (!text.trim() && stagedFiles.length === 0)
              }
              className="inline-flex flex-shrink-0 items-center gap-1.5 rounded-md bg-blue-600 px-3 py-2 text-sm font-semibold text-white transition hover:bg-blue-700 disabled:opacity-50"
            >
              {sendMutation.isPending ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Send className="h-3.5 w-3.5" />
              )}
              Send
            </button>
          </div>
        </div>
      </form>
    </div>
  )
}

/* -------------------------------------------------------------------------- */
/*  Day grouping + message runs                                               */
/* -------------------------------------------------------------------------- */

type DayGroup = {
  dayKey: string
  label: string
  runs: Message[][]
}

function groupByDay(messages: Message[]): DayGroup[] {
  const groups: DayGroup[] = []
  let currentGroup: DayGroup | null = null
  let currentRun: Message[] | null = null

  for (const msg of messages) {
    const d = new Date(msg.createdAt)
    const dayKey = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`
    if (!currentGroup || currentGroup.dayKey !== dayKey) {
      currentGroup = { dayKey, label: formatDayLabel(d), runs: [] }
      groups.push(currentGroup)
      currentRun = null
    }
    // Same sender + within 5 minutes of last message → same "run"
    // and the avatar/name only renders on the first row.
    const last = currentRun?.[currentRun.length - 1]
    const sameSender =
      last && last.senderName === msg.senderName && last.senderId === msg.senderId
    const within5min =
      last &&
      new Date(msg.createdAt).getTime() - new Date(last.createdAt).getTime() <
        5 * 60_000
    if (sameSender && within5min && currentRun) {
      currentRun.push(msg)
    } else {
      currentRun = [msg]
      currentGroup.runs.push(currentRun)
    }
  }
  return groups
}

function formatDayLabel(d: Date): string {
  const today = new Date()
  const yesterday = new Date()
  yesterday.setDate(today.getDate() - 1)
  const sameDay = (a: Date, b: Date) =>
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  if (sameDay(d, today)) return 'Today'
  if (sameDay(d, yesterday)) return 'Yesterday'
  return d.toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'short',
    day: 'numeric',
    year: today.getFullYear() === d.getFullYear() ? undefined : 'numeric',
  })
}

function formatMsgTime(iso: string): string {
  const d = new Date(iso)
  return d.toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  })
}

function MessageRun({ messages }: { messages: Message[] }) {
  const first = messages[0]
  const isAdmin =
    first.senderRole === 'admin' || first.senderRole === 'member'
  return (
    <div className="flex items-start gap-3">
      <div className="flex-shrink-0 pt-1">
        <Avatar name={first.senderName} size="sm" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline flex-wrap gap-2">
          <span className="text-sm font-semibold">{first.senderName}</span>
          {isAdmin && <AdminChip />}
          <span className="text-[10px] text-zinc-400">
            {formatMsgTime(first.createdAt)}
          </span>
        </div>
        <div className="space-y-1">
          {messages.map((m) => (
            <MessageBody key={m.id} message={m} />
          ))}
        </div>
      </div>
    </div>
  )
}

/**
 * Animated "Admin" chip rendered next to Alex / Ethan's names in
 * the chat. CSS-only animation — defined inline as a <style> block
 * so it ships with the component instead of pulling a Tailwind
 * plugin. Two effects:
 *   1. Gradient pan (blue → indigo → blue) that scrolls every 3s
 *   2. Subtle shimmer overlay that pulses every 2.5s
 *
 * Result is a chip that "breathes" without being distracting —
 * authoritative-looking enough to read as a staff marker, calm
 * enough not to compete with the message text.
 */
function AdminChip() {
  return (
    <>
      <style jsx>{`
        @keyframes adminChipPan {
          0% {
            background-position: 0% 50%;
          }
          50% {
            background-position: 100% 50%;
          }
          100% {
            background-position: 0% 50%;
          }
        }
        @keyframes adminChipPulse {
          0%,
          100% {
            opacity: 0.4;
            transform: translateX(-100%);
          }
          50% {
            opacity: 0.9;
            transform: translateX(100%);
          }
        }
        .admin-chip {
          background: linear-gradient(
            90deg,
            #2563eb 0%,
            #4f46e5 50%,
            #2563eb 100%
          );
          background-size: 200% 100%;
          animation: adminChipPan 3s ease-in-out infinite;
        }
        .admin-chip-shimmer {
          background: linear-gradient(
            90deg,
            transparent 0%,
            rgba(255, 255, 255, 0.4) 50%,
            transparent 100%
          );
          animation: adminChipPulse 2.5s ease-in-out infinite;
        }
      `}</style>
      <span className="admin-chip relative inline-flex items-center overflow-hidden rounded-full px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider text-white shadow-sm">
        <span className="relative z-10">Admin</span>
        <span
          aria-hidden
          className="admin-chip-shimmer pointer-events-none absolute inset-0"
        />
      </span>
    </>
  )
}

function MessageBody({ message }: { message: Message }) {
  return (
    <div>
      {message.text && (
        <p className="whitespace-pre-wrap break-words text-sm text-zinc-700 dark:text-zinc-200">
          {message.text}
        </p>
      )}
      {message.attachments.length > 0 && (
        <div
          className={cn(
            'mt-1 flex flex-wrap gap-2',
            message.text ? 'mt-1' : 'mt-0',
          )}
        >
          {message.attachments.map((a) => (
            <a
              key={a.id}
              href={`/api/team/chat/attachments/${a.id}`}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-block overflow-hidden rounded-md border border-zinc-200 bg-zinc-50 transition hover:border-blue-400 dark:border-zinc-700 dark:bg-zinc-800"
            >
              <img
                src={`/api/team/chat/attachments/${a.id}`}
                alt={a.filename}
                className="block max-h-72 max-w-xs object-contain"
                loading="lazy"
              />
            </a>
          ))}
        </div>
      )}
    </div>
  )
}
