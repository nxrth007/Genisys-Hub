'use client'

import { useState, useMemo } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  Inbox,
  RefreshCw,
  Search,
  User,
  AlertCircle,
  Mail,
  Reply,
  X,
} from 'lucide-react'
import { cn, formatDate } from '@/lib/utils'

type EmailRow = {
  id: string
  from: string
  fromName: string | null
  to: string
  subject: string
  snippet: string | null
  date: string
  isRead: boolean
  folder: string
  account: { email: string }
}

type GmailAccount = {
  id: string
  email: string
  _count?: { emails: number }
}

export default function InboxPage() {
  const qc = useQueryClient()
  const [activeAccount, setActiveAccount] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [selectedEmailId, setSelectedEmailId] = useState<string | null>(null)

  const accountsQuery = useQuery<{ accounts: GmailAccount[] }>({
    queryKey: ['gmail-accounts'],
    queryFn: async () => {
      const res = await fetch('/api/gmail/accounts')
      if (!res.ok) throw new Error('Failed to load accounts')
      return res.json()
    },
  })

  const emailsQuery = useQuery<{ emails: EmailRow[]; total: number }>({
    queryKey: ['inbox-emails', activeAccount, search],
    queryFn: async () => {
      const params = new URLSearchParams({ folder: 'inbox', limit: '100' })
      if (activeAccount) params.set('account', activeAccount)
      if (search.trim()) params.set('search', search.trim())
      const res = await fetch(`/api/emails?${params}`)
      if (!res.ok) throw new Error('Failed to load emails')
      return res.json()
    },
  })

  const syncMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch('/api/gmail/sync', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          ...(activeAccount ? { email: activeAccount } : {}),
          folder: 'both',
        }),
      })
      if (!res.ok) {
        const d = await res.json().catch(() => ({}))
        throw new Error(d.error || 'Sync failed')
      }
      return res.json()
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['inbox-emails'] })
      qc.invalidateQueries({ queryKey: ['outbox-emails'] })
      qc.invalidateQueries({ queryKey: ['gmail-accounts'] })
    },
  })

  const accounts = accountsQuery.data?.accounts ?? []
  const emails = emailsQuery.data?.emails ?? []
  const totalUnread = useMemo(() => emails.filter((e) => !e.isRead).length, [emails])

  return (
    <div className="space-y-4 max-w-6xl">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="rounded-lg bg-purple-50 p-2.5 dark:bg-purple-950">
            <Inbox className="h-6 w-6 text-purple-600" />
          </div>
          <div>
            <h2 className="text-2xl font-bold tracking-tight">Inbox</h2>
            <p className="text-sm text-zinc-500">
              {emailsQuery.isLoading
                ? 'Loading…'
                : `${emails.length} email${emails.length === 1 ? '' : 's'}${
                    totalUnread ? ` · ${totalUnread} unread` : ''
                  }`}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => syncMutation.mutate()}
            disabled={syncMutation.isPending || accounts.length === 0}
            className="inline-flex items-center gap-2 rounded-lg border border-zinc-200 px-3 py-2 text-sm font-medium hover:bg-zinc-50 disabled:opacity-50 dark:border-zinc-800 dark:hover:bg-zinc-800"
          >
            <RefreshCw
              className={cn('h-4 w-4', syncMutation.isPending && 'animate-spin')}
            />
            {syncMutation.isPending ? 'Syncing…' : 'Sync'}
          </button>
        </div>
      </div>

      {accounts.length === 0 ? (
        <div className="rounded-xl border border-amber-200 bg-amber-50 p-6 dark:border-amber-900 dark:bg-amber-950">
          <div className="flex items-start gap-3 text-sm text-amber-800 dark:text-amber-200">
            <AlertCircle className="h-4 w-4 mt-0.5 flex-shrink-0" />
            <div>
              <div className="font-medium">No Gmail accounts connected yet</div>
              <div className="text-xs mt-1">
                Go to <a href="/settings" className="underline">Settings</a> to connect{' '}
                <code>alex@leadgenisys.com</code> and <code>ethan@leadgenisys.com</code>.
              </div>
            </div>
          </div>
        </div>
      ) : (
        <>
          {/* Account chips + search */}
          <div className="flex items-center justify-between flex-wrap gap-3">
            <div className="flex items-center gap-2 flex-wrap">
              <AccountChip
                label="All accounts"
                active={activeAccount === null}
                onClick={() => setActiveAccount(null)}
              />
              {accounts.map((a) => (
                <AccountChip
                  key={a.id}
                  label={a.email}
                  count={a._count?.emails}
                  active={activeAccount === a.email}
                  onClick={() => setActiveAccount(a.email)}
                />
              ))}
            </div>
            <div className="relative max-w-sm flex-1">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-zinc-400" />
              <input
                type="text"
                placeholder="Search subject, sender, snippet…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="w-full rounded-lg border border-zinc-200 bg-white pl-10 pr-3 py-2 text-sm focus:border-purple-500 focus:outline-none dark:border-zinc-800 dark:bg-zinc-900"
              />
            </div>
          </div>

          {/* Email list */}
          <div className="rounded-xl border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900 overflow-hidden">
            {emailsQuery.isLoading ? (
              <div className="px-6 py-12 text-center text-sm text-zinc-500">Loading…</div>
            ) : emails.length === 0 ? (
              <div className="px-6 py-12 text-center">
                <Mail className="mx-auto h-8 w-8 text-zinc-300 mb-3" />
                <p className="text-sm text-zinc-500">
                  {search
                    ? 'No emails match your search.'
                    : 'No emails in this view. Try clicking Sync.'}
                </p>
              </div>
            ) : (
              <div className="divide-y divide-zinc-100 dark:divide-zinc-800">
                {emails.map((email) => (
                  <EmailRowView
                    key={email.id}
                    email={email}
                    onClick={() => setSelectedEmailId(email.id)}
                  />
                ))}
              </div>
            )}
          </div>

          {syncMutation.isError && (
            <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700 dark:bg-red-950 dark:border-red-900 dark:text-red-300">
              Sync failed: {(syncMutation.error as Error).message}
            </div>
          )}
        </>
      )}

      {selectedEmailId && (
        <EmailDetailModal
          emailId={selectedEmailId}
          onClose={() => {
            setSelectedEmailId(null)
            qc.invalidateQueries({ queryKey: ['inbox-emails'] })
          }}
        />
      )}
    </div>
  )
}

function AccountChip({
  label,
  count,
  active,
  onClick,
}: {
  label: string
  count?: number
  active: boolean
  onClick: () => void
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium transition-all',
        active
          ? 'bg-purple-50 border-purple-300 text-purple-800 dark:bg-purple-950 dark:border-purple-700 dark:text-purple-200'
          : 'border-zinc-200 text-zinc-500 hover:border-zinc-300 dark:border-zinc-800 dark:hover:border-zinc-700'
      )}
    >
      {label}
      {typeof count === 'number' && <span className="opacity-60">· {count}</span>}
    </button>
  )
}

function EmailRowView({ email, onClick }: { email: EmailRow; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="flex w-full items-start gap-4 px-5 py-3 text-left transition-colors hover:bg-zinc-50 dark:hover:bg-zinc-800/50"
    >
      <div
        className={cn(
          'h-2 w-2 rounded-full flex-shrink-0 mt-2',
          email.isRead ? 'bg-transparent' : 'bg-purple-500'
        )}
      />
      <div className="rounded-full bg-zinc-100 p-2 flex-shrink-0 dark:bg-zinc-800">
        <User className="h-4 w-4 text-zinc-500" />
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span
            className={cn(
              'text-sm truncate',
              !email.isRead ? 'font-semibold' : 'font-medium'
            )}
          >
            {email.fromName || email.from}
          </span>
          <span className="text-[10px] text-zinc-400 uppercase tracking-wide">
            {email.account.email.split('@')[0]}
          </span>
        </div>
        <p className="text-sm truncate mt-0.5">{email.subject || '(no subject)'}</p>
        <p className="text-xs text-zinc-500 truncate mt-0.5">{email.snippet}</p>
      </div>
      <span className="text-[11px] text-zinc-400 whitespace-nowrap flex-shrink-0">
        {formatDate(email.date)}
      </span>
    </button>
  )
}

function EmailDetailModal({
  emailId,
  onClose,
}: {
  emailId: string
  onClose: () => void
}) {
  const qc = useQueryClient()
  const [replyOpen, setReplyOpen] = useState(false)
  const [replyBody, setReplyBody] = useState('')

  const { data, isLoading, error } = useQuery<{
    email: {
      id: string
      gmailMessageId: string
      threadId: string | null
      from: string
      fromName: string | null
      to: string
      subject: string
      bodyText: string | null
      bodyHtml: string | null
      date: string
      account: { email: string }
    }
  }>({
    queryKey: ['email-detail', emailId],
    queryFn: async () => {
      const res = await fetch(`/api/emails/${emailId}`)
      if (!res.ok) throw new Error('Failed')
      return res.json()
    },
  })

  const sendMutation = useMutation({
    mutationFn: async () => {
      const email = data!.email
      const res = await fetch('/api/emails/send', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          accountEmail: email.account.email,
          to: email.from,
          subject: email.subject.startsWith('Re:') ? email.subject : `Re: ${email.subject}`,
          body: replyBody,
          inReplyTo: email.gmailMessageId,
          threadId: email.threadId,
        }),
      })
      if (!res.ok) {
        const d = await res.json().catch(() => ({}))
        throw new Error(d.error || 'Send failed')
      }
      return res.json()
    },
    onSuccess: () => {
      setReplyOpen(false)
      setReplyBody('')
      qc.invalidateQueries({ queryKey: ['outbox-emails'] })
    },
  })

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/50" onClick={onClose} />
      <div className="relative w-full max-w-3xl max-h-[90vh] flex flex-col rounded-xl bg-white shadow-xl dark:bg-zinc-900">
        <div className="flex items-start justify-between p-5 border-b border-zinc-200 dark:border-zinc-800">
          <div className="min-w-0">
            {isLoading ? (
              <div className="h-6 w-64 bg-zinc-100 dark:bg-zinc-800 rounded" />
            ) : data ? (
              <>
                <h3 className="text-lg font-semibold truncate">
                  {data.email.subject || '(no subject)'}
                </h3>
                <div className="flex items-center gap-2 mt-1 text-xs text-zinc-500">
                  <span className="font-medium text-zinc-700 dark:text-zinc-300">
                    {data.email.fromName || data.email.from}
                  </span>
                  {data.email.fromName && <span>&lt;{data.email.from}&gt;</span>}
                  <span>·</span>
                  <span>to {data.email.to}</span>
                  <span>·</span>
                  <span>{new Date(data.email.date).toLocaleString()}</span>
                </div>
                <div className="text-[10px] text-zinc-400 mt-0.5">
                  received by {data.email.account.email}
                </div>
              </>
            ) : null}
          </div>
          <button
            onClick={onClose}
            className="rounded-md p-1 text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-5">
          {isLoading ? (
            <div className="text-sm text-zinc-500">Loading…</div>
          ) : error ? (
            <div className="text-sm text-red-600">Failed to load email.</div>
          ) : data?.email.bodyHtml ? (
            <div
              className="prose prose-sm dark:prose-invert max-w-none"
              dangerouslySetInnerHTML={{ __html: data.email.bodyHtml }}
            />
          ) : data?.email.bodyText ? (
            <pre className="whitespace-pre-wrap font-sans text-sm">{data.email.bodyText}</pre>
          ) : (
            <p className="text-sm text-zinc-500">No body content.</p>
          )}
        </div>

        <div className="border-t border-zinc-200 p-4 dark:border-zinc-800">
          {!replyOpen ? (
            <button
              onClick={() => setReplyOpen(true)}
              className="inline-flex items-center gap-2 rounded-lg bg-purple-600 px-4 py-2 text-sm font-medium text-white hover:bg-purple-700"
            >
              <Reply className="h-4 w-4" /> Reply
            </button>
          ) : (
            <div className="space-y-2">
              <textarea
                value={replyBody}
                onChange={(e) => setReplyBody(e.target.value)}
                placeholder="Type your reply…"
                rows={5}
                className="w-full rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm focus:border-purple-500 focus:outline-none dark:border-zinc-800 dark:bg-zinc-950"
              />
              <div className="flex items-center justify-end gap-2">
                <button
                  onClick={() => {
                    setReplyOpen(false)
                    setReplyBody('')
                  }}
                  className="rounded-md px-3 py-2 text-sm font-medium text-zinc-600 hover:bg-zinc-100 dark:hover:bg-zinc-800"
                >
                  Cancel
                </button>
                <button
                  onClick={() => sendMutation.mutate()}
                  disabled={sendMutation.isPending || !replyBody.trim()}
                  className="inline-flex items-center gap-2 rounded-lg bg-purple-600 px-4 py-2 text-sm font-medium text-white hover:bg-purple-700 disabled:opacity-50"
                >
                  {sendMutation.isPending ? 'Sending…' : 'Send reply'}
                </button>
              </div>
              {sendMutation.isError && (
                <p className="text-xs text-red-600">
                  {(sendMutation.error as Error).message}
                </p>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
