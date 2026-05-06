'use client'

import Link from 'next/link'
import { useQuery } from '@tanstack/react-query'
import {
  MessageSquare,
  ArrowLeft,
  Building2,
  AlertCircle,
  User,
  ChevronRight,
} from 'lucide-react'

/**
 * /crm/clients
 *
 * "Client Messages" — Genisys-sub-account conversations whose
 * contact matches a registered Client (by phone, email, or name).
 * Reminder-system threads are excluded server-side, so this view
 * is purely admin ↔ client communication.
 *
 * Per Alex: "I want to easily see what my clients are saying
 * without having the reminder threads cluttering the view." Same
 * thread UI on click as the rest of /crm — links to
 * /crm/[subName]/[convId] so existing reply machinery just works.
 */

type ClientBadge = {
  id: string
  name: string
  state: string | null
  color: string
}

type ClientConversation = {
  id: string
  contactId: string | null
  contactName: string | null
  contactPhone: string | null
  contactEmail: string | null
  lastMessageBody: string | null
  lastMessageDate: string | null
  lastMessageType: string | null
  unreadCount: number
  client: ClientBadge
  matchedOn: 'phone' | 'email' | 'name'
}

type ApiResponse = {
  conversations: ClientConversation[]
  diagnostics: {
    ghlFetched: number
    remindersExcluded: number
    matched: number
    registeredClients: number
  }
}

const VAULT_ENTRY_NAME = 'GHL Genisys Token'

export default function ClientMessagesPage() {
  const { data, isLoading, error } = useQuery<ApiResponse>({
    queryKey: ['crm-client-conversations'],
    queryFn: async () => {
      const res = await fetch('/api/crm/client-conversations')
      if (!res.ok) {
        const d = await res.json().catch(() => ({}))
        throw new Error(d.error || 'Failed to load client conversations')
      }
      return res.json()
    },
    refetchInterval: 60_000,
  })

  const conversations = data?.conversations ?? []
  const diag = data?.diagnostics

  return (
    <div className="max-w-5xl space-y-6">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="rounded-lg bg-purple-50 p-2.5 dark:bg-purple-950">
            <MessageSquare className="h-6 w-6 text-purple-600" />
          </div>
          <div>
            <h2 className="text-2xl font-bold tracking-tight">
              Client Messages
            </h2>
            <p className="text-sm text-zinc-500">
              Conversations on your Genisys sub-account, filtered to
              registered clients only. Reminder threads are excluded —
              they live on{' '}
              <Link
                href="/crm/messages"
                className="text-primary hover:underline"
              >
                Reminder threads
              </Link>
              .
            </p>
          </div>
        </div>
        <Link
          href="/crm"
          className="inline-flex items-center gap-1.5 rounded-md border border-zinc-200 bg-white px-3 py-1.5 text-xs font-medium text-zinc-600 transition hover:bg-zinc-50 hover:text-blue-600 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-300 dark:hover:bg-zinc-800"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          All conversations
        </Link>
      </div>

      {/* Diagnostic strip — gives admin a quick "is the filter
          actually working?" sanity check. Useful when there are 0
          matches to distinguish "no client comms yet" from "filter
          broken" or "no clients have contactPhone set." */}
      {diag && !isLoading && (
        <div className="rounded-md border border-zinc-200 bg-zinc-50 px-4 py-2 text-[11px] text-zinc-500 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-400">
          {diag.ghlFetched} conversations fetched from Genisys ·{' '}
          {diag.remindersExcluded} reminder threads excluded ·{' '}
          <span className="font-semibold text-zinc-700 dark:text-zinc-200">
            {diag.matched} matched a registered client
          </span>{' '}
          (across {diag.registeredClients} active client
          {diag.registeredClients === 1 ? '' : 's'})
        </div>
      )}

      {isLoading ? (
        <div className="rounded-xl border border-zinc-200 bg-white px-6 py-12 text-center text-sm text-zinc-500 dark:border-zinc-800 dark:bg-zinc-900">
          Loading client conversations…
        </div>
      ) : error ? (
        <div className="rounded-xl border border-amber-200 bg-amber-50 p-6 dark:border-amber-900 dark:bg-amber-950">
          <div className="flex items-start gap-3 text-sm text-amber-800 dark:text-amber-200">
            <AlertCircle className="mt-0.5 h-4 w-4 flex-shrink-0" />
            <div>
              <div className="font-medium">Couldn&apos;t load</div>
              <div className="mt-1 text-xs">{(error as Error).message}</div>
              <div className="mt-1 text-xs text-amber-600 dark:text-amber-300">
                Confirm the &ldquo;GHL Genisys Token&rdquo; vault entry
                exists and the GHL Private Integration scopes include{' '}
                <code>conversations.readonly</code>.
              </div>
            </div>
          </div>
        </div>
      ) : conversations.length === 0 ? (
        <div className="rounded-xl border border-dashed border-zinc-200 bg-white px-6 py-16 text-center dark:border-zinc-800 dark:bg-zinc-900">
          <Building2 className="mx-auto h-8 w-8 text-zinc-300 dark:text-zinc-600" />
          <p className="mt-3 text-sm font-medium">
            No client conversations yet
          </p>
          <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
            Messages appear here when one of your registered clients
            (matched by contact phone, email, or name) sends or
            receives a thread on the Genisys GHL sub-account. Make
            sure each client&apos;s contact info is filled out under{' '}
            <Link href="/clients" className="text-primary hover:underline">
              /clients
            </Link>
            .
          </p>
        </div>
      ) : (
        <div className="overflow-hidden rounded-xl border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900">
          <ul className="divide-y divide-zinc-100 dark:divide-zinc-800">
            {conversations.map((c) => (
              <ClientConversationRow key={c.id} conversation={c} />
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}

function ClientConversationRow({
  conversation,
}: {
  conversation: ClientConversation
}) {
  // Same thread-view route the rest of /crm uses, so clicking lands
  // in the existing reply / message-history UI without us
  // re-implementing it. URL-encode the vault entry name so spaces
  // don't break the route param.
  const href = `/crm/${encodeURIComponent(VAULT_ENTRY_NAME)}/${conversation.id}`
  const display =
    conversation.contactName ||
    conversation.contactPhone ||
    conversation.contactEmail ||
    'Unknown contact'
  const lastDate = conversation.lastMessageDate
    ? new Date(conversation.lastMessageDate)
    : null
  const matchedOnLabel =
    conversation.matchedOn === 'phone'
      ? 'phone match'
      : conversation.matchedOn === 'email'
        ? 'email match'
        : 'name match'

  return (
    <li>
      <Link
        href={href}
        className="flex items-start gap-4 px-5 py-3 transition-colors hover:bg-zinc-50 dark:hover:bg-zinc-800/50"
      >
        <div className="flex-shrink-0 rounded-full bg-zinc-100 p-2 dark:bg-zinc-800">
          <User className="h-4 w-4 text-zinc-500" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <p className="truncate text-sm font-semibold">{display}</p>
            {/* Client badge — colored dot + name + state. Lets admin
                see at a glance which client this thread belongs to
                without opening it. */}
            <span
              className="inline-flex flex-shrink-0 items-center gap-1.5 rounded-full bg-zinc-100 px-2 py-0.5 text-[10px] font-semibold text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300"
              title={`Matched ${conversation.client.name} via ${matchedOnLabel}`}
            >
              <span
                className="h-1.5 w-1.5 rounded-full"
                style={{ backgroundColor: conversation.client.color }}
                aria-hidden
              />
              {conversation.client.name}
              {conversation.client.state && (
                <span className="font-normal text-zinc-500">
                  · {conversation.client.state}
                </span>
              )}
            </span>
            {conversation.unreadCount > 0 && (
              <span className="flex-shrink-0 rounded-full bg-blue-600 px-1.5 text-[10px] font-bold text-white">
                {conversation.unreadCount}
              </span>
            )}
          </div>
          <p className="mt-0.5 line-clamp-1 text-xs text-zinc-500">
            {conversation.lastMessageBody || '(no message body)'}
          </p>
        </div>
        <div className="flex flex-shrink-0 items-center gap-1.5 text-[11px] text-zinc-500">
          {lastDate && (
            <span
              className="tabular-nums"
              title={lastDate.toLocaleString('en-US')}
            >
              {formatRelative(lastDate)}
            </span>
          )}
          <ChevronRight className="h-3.5 w-3.5 text-zinc-300" />
        </div>
      </Link>
    </li>
  )
}

/** Compact relative timestamp — "2h" / "3d" / "Apr 15". Long-tail
 *  dates fall back to absolute MMM-DD so admin can scan a year of
 *  conversations without every row reading "365d". */
function formatRelative(d: Date): string {
  const diff = Date.now() - d.getTime()
  const sec = Math.floor(diff / 1000)
  if (sec < 60) return `${sec}s`
  const min = Math.floor(sec / 60)
  if (min < 60) return `${min}m`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr}h`
  const day = Math.floor(hr / 24)
  if (day < 7) return `${day}d`
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

