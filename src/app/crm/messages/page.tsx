'use client'

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { useQuery } from '@tanstack/react-query'
import {
  MessageSquare,
  Loader2,
  AlertCircle,
  Search,
  Phone,
  Calendar,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { Avatar } from '@/components/ui/avatar'
import { Chip } from '@/components/ui/chip'

/**
 * Reminder Messages — every customer SMS conversation the reminder
 * system has ever created, in one place. Both Alex (CRM) and Mary
 * (agent view) consume this through their respective routes; the
 * underlying data + component are the same.
 *
 * List view: one row per unique customer conversation, sorted by
 * most recent outbound activity. Click into a row → /crm/messages/
 * [convId] (or /agent/messages/[convId] for Mary), which fetches
 * the live thread from GHL and lets you reply inline.
 *
 * The "from-the-reminder-line" filtering is implicit: this list is
 * derived from AppointmentReminder rows, which only ever record
 * conversations the reminder system created. Threads that exist
 * for other reasons (manual GHL outbound, other integrations) live
 * on the main /crm view; this view stays focused on Mary's
 * appointment-reminder workflow.
 */

type Summary = {
  ghlConversationId: string
  ghlContactId: string
  customerName: string
  customerPhone: string
  apptDateTime: string
  lastOutboundBody: string | null
  lastOutboundAt: string
  reminderCount: number
}

export function ReminderMessagesList({ basePath }: { basePath: string }) {
  const [mounted, setMounted] = useState(false)
  useEffect(() => {
    setMounted(true)
  }, [])
  const [search, setSearch] = useState('')

  const { data, isLoading, error } = useQuery<{ conversations: Summary[] }>({
    queryKey: ['reminder-conversations'],
    queryFn: async () => {
      const res = await fetch('/api/crm/reminders/conversations')
      if (!res.ok) {
        const d = await res.json().catch(() => ({}))
        throw new Error(d.error || 'Failed to load conversations')
      }
      return res.json()
    },
    refetchInterval: 30_000,
  })

  const conversations = data?.conversations ?? []
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return conversations
    return conversations.filter(
      (c) =>
        c.customerName.toLowerCase().includes(q) ||
        c.customerPhone.replace(/\D/g, '').includes(q.replace(/\D/g, '')) ||
        (c.lastOutboundBody ?? '').toLowerCase().includes(q),
    )
  }, [conversations, search])

  if (!mounted) {
    // Same hydration-mismatch dodge as the booking-form widgets —
    // useQuery's internal state during SSR can diverge from client,
    // and an empty initial render is cheap insurance.
    return null
  }

  return (
    <div className="mx-auto w-full max-w-5xl space-y-5">
      <div className="flex items-start gap-3">
        <div className="rounded-lg bg-blue-50 p-2.5 dark:bg-blue-950">
          <MessageSquare className="h-6 w-6 text-blue-600" />
        </div>
        <div className="flex-1">
          <h2 className="text-2xl font-bold tracking-tight">Reminder messages</h2>
          <p className="text-sm text-zinc-500">
            Customer SMS threads the reminder system started. Replies
            land here too — click a conversation to read or respond.
          </p>
        </div>
        <Chip tone="blue">
          {conversations.length}{' '}
          {conversations.length === 1 ? 'thread' : 'threads'}
        </Chip>
      </div>

      <div className="relative">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-400" />
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search by customer name, phone, or message…"
          className="w-full rounded-lg border border-zinc-200 bg-white py-2.5 pl-9 pr-3 text-sm focus:border-blue-500 focus:outline-none dark:border-zinc-800 dark:bg-zinc-900"
        />
      </div>

      <div className="rounded-2xl border border-zinc-200 bg-white shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
        {isLoading ? (
          <div className="flex items-center justify-center py-12 text-sm text-zinc-500">
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            Loading conversations…
          </div>
        ) : error ? (
          <div className="p-6">
            <div className="flex items-start gap-3 rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-300">
              <AlertCircle className="mt-0.5 h-4 w-4 flex-shrink-0" />
              <div>
                <div className="font-medium">Couldn&apos;t load conversations</div>
                <div className="mt-1 text-xs">{(error as Error).message}</div>
              </div>
            </div>
          </div>
        ) : filtered.length === 0 ? (
          <div className="px-6 py-12 text-center text-sm text-zinc-500">
            <MessageSquare className="mx-auto h-8 w-8 text-zinc-300" />
            <p className="mt-2">
              {conversations.length === 0
                ? 'No reminder conversations yet. Once the system fires its first SMS, threads will appear here.'
                : 'No matches for that search.'}
            </p>
          </div>
        ) : (
          <ul className="divide-y divide-zinc-100 dark:divide-zinc-800">
            {filtered.map((c) => (
              <li key={c.ghlConversationId}>
                <Link
                  href={`${basePath}/${encodeURIComponent(c.ghlConversationId)}`}
                  className="flex items-start gap-3 px-5 py-4 transition hover:bg-zinc-50 dark:hover:bg-zinc-800"
                >
                  <Avatar name={c.customerName} size="md" />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <p className="truncate text-sm font-semibold">
                        {c.customerName}
                      </p>
                      <span className="text-[11px] text-zinc-500">
                        · {c.customerPhone}
                      </span>
                      {c.reminderCount > 1 && (
                        <Chip tone="muted">
                          {c.reminderCount} reminders
                        </Chip>
                      )}
                    </div>
                    {c.lastOutboundBody && (
                      <p className="mt-1 line-clamp-2 text-xs text-zinc-600 dark:text-zinc-400">
                        {c.lastOutboundBody}
                      </p>
                    )}
                    <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-zinc-500">
                      <span className="inline-flex items-center gap-1">
                        <Calendar className="h-3 w-3" />
                        Appt: {formatDate(c.apptDateTime)}
                      </span>
                      <span>· Last sent {timeAgo(c.lastOutboundAt)}</span>
                    </div>
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </div>

      <p className="text-[11px] text-zinc-500">
        <Phone className="mr-1 inline h-3 w-3" />
        Replies fire from the configured agency sender phone in
        Settings. Outbound from anywhere else (manual GHL, agent
        portal, etc.) lives on the main CRM view.
      </p>
    </div>
  )
}

export default function CrmReminderMessagesPage() {
  return <ReminderMessagesList basePath="/crm/messages" />
}

function formatDate(iso: string): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (isNaN(d.getTime())) return iso
  return d.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
}

function timeAgo(iso: string): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (isNaN(d.getTime())) return '—'
  const diffMs = Date.now() - d.getTime()
  const mins = Math.round(diffMs / 60_000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hours = Math.round(mins / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.round(hours / 24)
  if (days < 30) return `${days}d ago`
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}
