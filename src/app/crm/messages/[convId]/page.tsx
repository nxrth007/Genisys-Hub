'use client'

import { use, useEffect, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import Link from 'next/link'
import {
  ArrowLeft,
  Loader2,
  AlertCircle,
  Send,
  MessageSquare,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { Avatar } from '@/components/ui/avatar'
import { Chip } from '@/components/ui/chip'
import { REMINDER_LABELS, type ReminderType } from '@/lib/reminders-constants'

/**
 * Thread view for a single reminder conversation. Used by both the
 * /crm/messages and /agent/messages routes — the only thing that
 * varies is the back-link target (passed via the `basePath` prop on
 * the wrapping page).
 *
 * Pulls the live message thread from GHL on every focus + 30s poll
 * so customer replies show up reasonably promptly. Outbound bubbles
 * tagged with the reminderType (1day / 2hr / 30min / start) when we
 * can correlate the GHL messageId back to one of our cron-fired
 * AppointmentReminder rows — gives Mary at-a-glance context for
 * which reminder a customer was responding to.
 */

type Message = {
  id?: string
  body?: string
  type?: string
  direction?: 'inbound' | 'outbound'
  dateAdded?: string
  reminderType?: string | null
}

type ConversationData = {
  conversationId: string
  customerName: string
  customerPhone: string
  contactId: string
  messages: Message[]
}

export function ReminderConversationDetail({
  convId,
  basePath,
}: {
  convId: string
  basePath: string
}) {
  const qc = useQueryClient()
  const [reply, setReply] = useState('')
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const didInitialScrollRef = useRef(false)
  const [mounted, setMounted] = useState(false)
  useEffect(() => {
    setMounted(true)
  }, [])

  const { data, isLoading, error } = useQuery<ConversationData>({
    queryKey: ['reminder-conversation', convId],
    queryFn: async () => {
      const res = await fetch(
        `/api/crm/reminders/conversations/${encodeURIComponent(convId)}`,
      )
      if (!res.ok) {
        const d = await res.json().catch(() => ({}))
        throw new Error(d.error || 'Failed to load conversation')
      }
      return res.json()
    },
    refetchInterval: 30_000,
    refetchOnWindowFocus: true,
  })

  const sortedMessages = (data?.messages ?? [])
    .slice()
    .sort((a, b) => {
      const at = a.dateAdded ? new Date(a.dateAdded).getTime() : 0
      const bt = b.dateAdded ? new Date(b.dateAdded).getTime() : 0
      return at - bt
    })

  // Scroll to the bottom on first load + smoothly after subsequent
  // updates; matches the Slack channel viewer's behavior so the two
  // SMS-ish surfaces feel consistent.
  useEffect(() => {
    if (!messagesEndRef.current) return
    messagesEndRef.current.scrollIntoView({
      behavior: didInitialScrollRef.current ? 'smooth' : 'auto',
    })
    if (sortedMessages.length > 0) didInitialScrollRef.current = true
  }, [sortedMessages.length])

  const sendMutation = useMutation({
    mutationFn: async (text: string) => {
      const res = await fetch(
        `/api/crm/reminders/conversations/${encodeURIComponent(convId)}`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ text }),
        },
      )
      if (!res.ok) {
        const d = await res.json().catch(() => ({}))
        throw new Error(d.error || 'Send failed')
      }
      return res.json()
    },
    onSuccess: () => {
      setReply('')
      qc.invalidateQueries({ queryKey: ['reminder-conversation', convId] })
    },
  })

  function handleSend() {
    const text = reply.trim()
    if (text) sendMutation.mutate(text)
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    // Cmd/Ctrl+Enter sends — Enter inserts a newline. Same shortcut
    // the Slack viewer uses, so muscle memory carries across.
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault()
      handleSend()
    }
  }

  if (!mounted) return null

  return (
    <div className="mx-auto flex h-[calc(100vh-7rem)] w-full max-w-3xl flex-col">
      <div className="mb-3 flex items-center gap-3 border-b border-border pb-3 border-border">
        <Link
          href={basePath}
          className="rounded-md p-1.5 text-muted-foreground/70 transition hover:bg-muted hover:text-foreground hover:bg-muted hover:text-foreground"
          aria-label="Back to messages"
        >
          <ArrowLeft className="h-4 w-4" />
        </Link>
        {data && (
          <Avatar name={data.customerName} size="md" />
        )}
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-lg font-semibold tracking-tight">
            {data?.customerName ?? 'Loading…'}
          </h2>
          {data?.customerPhone && (
            <p className="truncate text-xs text-muted-foreground">
              {data.customerPhone}
            </p>
          )}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto rounded-xl border border-border bg-card px-4 py-3 border-border bg-card">
        {isLoading ? (
          <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            Loading thread…
          </div>
        ) : error ? (
          <div className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive border-destructive/30 bg-destructive/10 text-destructive">
            <AlertCircle className="mt-0.5 h-4 w-4 flex-shrink-0" />
            <div>{(error as Error).message}</div>
          </div>
        ) : sortedMessages.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center text-sm text-muted-foreground">
            <MessageSquare className="h-8 w-8 text-muted-foreground/50" />
            <p className="mt-2">No messages in this thread yet.</p>
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            {sortedMessages.map((m, i) => (
              <MessageBubble key={m.id ?? i} message={m} />
            ))}
            <div ref={messagesEndRef} />
          </div>
        )}
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault()
          handleSend()
        }}
        className="mt-3"
      >
        <div className="flex items-end gap-2 rounded-xl border border-border bg-card p-2 focus-within:border-blue-500 border-border bg-card">
          <textarea
            value={reply}
            onChange={(e) => setReply(e.target.value)}
            onKeyDown={handleKeyDown}
            rows={2}
            placeholder="Type a reply… (⌘/Ctrl+Enter to send)"
            disabled={sendMutation.isPending}
            className="max-h-40 min-h-[44px] flex-1 resize-y bg-transparent px-2 py-1.5 text-sm focus:outline-none"
          />
          <button
            type="submit"
            disabled={sendMutation.isPending || !reply.trim()}
            className={cn(
              'inline-flex flex-shrink-0 items-center gap-1.5 rounded-lg bg-foreground px-3.5 py-2 text-sm font-medium text-background transition hover:bg-foreground/90 disabled:opacity-50',
            )}
          >
            <Send className="h-3.5 w-3.5" />
            {sendMutation.isPending ? 'Sending…' : 'Send'}
          </button>
        </div>
      </form>
      {sendMutation.isError && (
        <p className="mt-2 text-xs text-destructive">
          Failed: {(sendMutation.error as Error).message}
        </p>
      )}
    </div>
  )
}

function MessageBubble({ message }: { message: Message }) {
  const inbound = message.direction === 'inbound'
  const reminderLabel =
    message.reminderType &&
    (REMINDER_LABELS as Record<string, string>)[message.reminderType]
      ? (REMINDER_LABELS as Record<string, string>)[message.reminderType]
      : null
  return (
    <div
      className={cn(
        'flex w-full',
        inbound ? 'justify-start' : 'justify-end',
      )}
    >
      <div
        className={cn(
          'max-w-[75%] rounded-xl px-3 py-2 text-sm',
          inbound
            ? 'bg-muted text-foreground bg-surface-muted text-foreground'
            : 'bg-foreground text-background',
        )}
      >
        {reminderLabel && (
          <div className="mb-1 eyebrow opacity-80">
            {reminderLabel} reminder
          </div>
        )}
        <div className="whitespace-pre-line break-words">{message.body}</div>
        {message.dateAdded && (
          <div
            className={cn(
              'mt-1 text-[10px]',
              inbound ? 'text-muted-foreground' : 'text-blue-100',
            )}
          >
            {formatTime(message.dateAdded)}
          </div>
        )}
      </div>
    </div>
  )
}

function formatTime(iso: string): string {
  const d = new Date(iso)
  if (isNaN(d.getTime())) return iso
  const now = new Date()
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate()
  if (sameDay) {
    return d.toLocaleTimeString('en-US', {
      hour: 'numeric',
      minute: '2-digit',
    })
  }
  return d.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
}

export default function CrmReminderConversationPage({
  params,
}: {
  params: Promise<{ convId: string }>
}) {
  const { convId } = use(params)
  return (
    <ReminderConversationDetail
      convId={decodeURIComponent(convId)}
      basePath="/crm/messages"
    />
  )
}
