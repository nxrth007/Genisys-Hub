'use client'

import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import Link from 'next/link'
import {
  MessageSquare,
  ChevronDown,
  ChevronRight,
  User,
  AlertCircle,
  Building2,
} from 'lucide-react'
import { cn } from '@/lib/utils'

type SubAccount = {
  vaultName: string
  locationId: string
  locationName: string
}

type GhlConversation = {
  id: string
  contactId?: string
  contactName?: string
  contactEmail?: string
  lastMessageBody?: string
  lastMessageDate?: string
  lastMessageType?: string
  unreadCount?: number
  type?: string
}

type Group = {
  subAccount: SubAccount
  conversations: GhlConversation[]
  error: string | null
}

type ResolutionError = {
  vaultName: string
  error: string
}

export default function CrmPage() {
  const { data, isLoading, error } = useQuery<{
    groups: Group[]
    resolutionErrors?: ResolutionError[]
    discoveredEntries?: number
  }>({
    queryKey: ['crm-groups'],
    queryFn: async () => {
      const res = await fetch('/api/crm/conversations')
      if (!res.ok) {
        const d = await res.json().catch(() => ({}))
        throw new Error(d.error || 'Failed to load conversations')
      }
      return res.json()
    },
  })

  const groups = data?.groups ?? []
  const resolutionErrors = data?.resolutionErrors ?? []
  const discoveredEntries = data?.discoveredEntries ?? 0
  const totalConvos = groups.reduce((acc, g) => acc + g.conversations.length, 0)

  return (
    <div className="max-w-5xl space-y-6">
      <div>
        <div className="flex items-center gap-3">
          <div className="rounded-lg bg-purple-50 p-2.5 dark:bg-purple-950">
            <MessageSquare className="h-6 w-6 text-purple-600" />
          </div>
          <div>
            <h2 className="text-2xl font-bold tracking-tight">CRM — GoHighLevel</h2>
            <p className="text-sm text-zinc-500">
              {groups.length > 0
                ? `${totalConvos} conversation${totalConvos === 1 ? '' : 's'} across ${groups.length} sub-account${groups.length === 1 ? '' : 's'}`
                : 'Conversations from all your GHL sub-accounts.'}
            </p>
          </div>
        </div>
      </div>

      {isLoading ? (
        <div className="rounded-xl border border-zinc-200 bg-white px-6 py-12 text-center text-sm text-zinc-500 dark:border-zinc-800 dark:bg-zinc-900">
          Loading conversations from all sub-accounts…
        </div>
      ) : error ? (
        <div className="rounded-xl border border-amber-200 bg-amber-50 p-6 dark:border-amber-900 dark:bg-amber-950">
          <div className="flex items-start gap-3 text-sm text-amber-800 dark:text-amber-200">
            <AlertCircle className="h-4 w-4 mt-0.5 flex-shrink-0" />
            <div>
              <div className="font-medium">Could not load conversations</div>
              <div className="text-xs mt-1">{(error as Error).message}</div>
              <div className="text-xs mt-1 text-amber-600 dark:text-amber-300">
                Make sure your GHL Private Integration tokens are in the vault tagged{' '}
                <code>ghl</code>.
              </div>
            </div>
          </div>
        </div>
      ) : groups.length === 0 ? (
        <div className="space-y-3">
          <div className="rounded-xl border border-zinc-200 bg-white px-6 py-12 text-center dark:border-zinc-800 dark:bg-zinc-900">
            <Building2 className="mx-auto h-8 w-8 text-zinc-300 mb-3" />
            <p className="text-sm text-zinc-500">
              {discoveredEntries === 0 ? (
                <>No vault entries tagged <code>ghl</code> were found.</>
              ) : (
                <>
                  Found {discoveredEntries} vault {discoveredEntries === 1 ? 'entry' : 'entries'} tagged <code>ghl</code>,
                  but none could be resolved to a GHL sub-account. See errors below.
                </>
              )}
            </p>
          </div>

          {resolutionErrors.length > 0 && (
            <div className="rounded-xl border border-red-200 bg-red-50 p-4 dark:border-red-900 dark:bg-red-950">
              <h3 className="font-semibold text-sm text-red-900 dark:text-red-200 mb-2">
                Resolution errors
              </h3>
              <ul className="space-y-2 text-xs">
                {resolutionErrors.map((re) => (
                  <li key={re.vaultName} className="text-red-800 dark:text-red-300">
                    <span className="font-mono font-semibold">{re.vaultName}</span>: {re.error}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      ) : (
        <div className="space-y-3">
          {groups.map((group) => (
            <SubAccountGroup key={group.subAccount.vaultName} group={group} />
          ))}
        </div>
      )}
    </div>
  )
}

function SubAccountGroup({ group }: { group: Group }) {
  const [expanded, setExpanded] = useState(true)
  const convos = group.conversations

  return (
    <section className="rounded-xl border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900 overflow-hidden">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex w-full items-center justify-between px-5 py-3 hover:bg-zinc-50 dark:hover:bg-zinc-800/50 transition-colors"
      >
        <div className="flex items-center gap-3">
          {expanded ? (
            <ChevronDown className="h-4 w-4 text-zinc-400" />
          ) : (
            <ChevronRight className="h-4 w-4 text-zinc-400" />
          )}
          <Building2 className="h-4 w-4 text-purple-600" />
          <h3 className="font-semibold text-sm">{group.subAccount.locationName}</h3>
          <span className="text-xs text-zinc-400">
            ({convos.length} {convos.length === 1 ? 'conversation' : 'conversations'})
          </span>
        </div>
      </button>

      {expanded && (
        <div className="border-t border-zinc-100 dark:border-zinc-800">
          {group.error ? (
            <div className="px-5 py-4 text-xs text-red-600 bg-red-50 dark:bg-red-950 dark:text-red-300">
              Error: {group.error}
            </div>
          ) : convos.length === 0 ? (
            <div className="px-5 py-6 text-center text-xs text-zinc-500">
              No conversations yet.
            </div>
          ) : (
            <div className="divide-y divide-zinc-100 dark:divide-zinc-800">
              {convos.map((conv) => (
                <ConversationRow
                  key={conv.id}
                  conversation={conv}
                  subName={group.subAccount.vaultName}
                />
              ))}
            </div>
          )}
        </div>
      )}
    </section>
  )
}

function ConversationRow({
  conversation,
  subName,
}: {
  conversation: GhlConversation
  subName: string
}) {
  const encodedSub = encodeURIComponent(subName)
  const href = `/crm/${encodedSub}/${conversation.id}`
  const name =
    conversation.contactName || conversation.contactEmail || conversation.contactId || 'Unknown'

  return (
    <Link
      href={href}
      className="flex items-start gap-4 px-5 py-3 transition-colors hover:bg-zinc-50 dark:hover:bg-zinc-800/50"
    >
      <div className="rounded-full bg-zinc-100 p-2 dark:bg-zinc-800 flex-shrink-0">
        <User className="h-4 w-4 text-zinc-500" />
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="font-medium text-sm">{name}</span>
          {(conversation.unreadCount ?? 0) > 0 && (
            <span className="inline-flex items-center rounded-full bg-purple-600 px-1.5 py-0.5 text-[10px] font-medium text-white">
              {conversation.unreadCount}
            </span>
          )}
          {conversation.lastMessageType && (
            <span className="text-[10px] text-zinc-400 uppercase tracking-wide">
              {cleanMessageType(conversation.lastMessageType)}
            </span>
          )}
        </div>
        <p className="text-xs text-zinc-500 truncate mt-0.5">
          {conversation.lastMessageBody || 'No messages yet'}
        </p>
      </div>
      <span className="text-[11px] text-zinc-400 whitespace-nowrap flex-shrink-0">
        {conversation.lastMessageDate ? formatRelative(conversation.lastMessageDate) : ''}
      </span>
    </Link>
  )
}

function cleanMessageType(raw: string): string {
  return raw.replace(/^TYPE_/, '').toLowerCase()
}

function formatRelative(date: string): string {
  try {
    const d = new Date(date)
    const now = new Date()
    const diffMin = Math.round((now.getTime() - d.getTime()) / 60000)
    if (diffMin < 1) return 'now'
    if (diffMin < 60) return `${diffMin}m`
    const diffHr = Math.round(diffMin / 60)
    if (diffHr < 24) return `${diffHr}h`
    const diffDay = Math.round(diffHr / 24)
    if (diffDay < 7) return `${diffDay}d`
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
  } catch {
    return date
  }
}
