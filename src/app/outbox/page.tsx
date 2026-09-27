'use client'

import { useState, useMemo } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  Send,
  RefreshCw,
  Search,
  User,
  AlertCircle,
  Mail,
  Plus,
  X,
} from 'lucide-react'
import { cn, formatDate } from '@/lib/utils'
import { RichEditor } from '@/components/email/rich-editor'

function wrapEmailHtml(html: string): string {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:14px;color:#1a1a1a;line-height:1.6;max-width:600px;">${html}</body></html>`
}

type EmailRow = {
  id: string
  from: string
  fromName: string | null
  to: string
  subject: string
  snippet: string | null
  date: string
  folder: string
  account: { email: string }
}

type GmailAccount = { id: string; email: string }

export default function OutboxPage() {
  const qc = useQueryClient()
  const [activeAccount, setActiveAccount] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [composeOpen, setComposeOpen] = useState(false)

  const accountsQuery = useQuery<{ accounts: GmailAccount[] }>({
    queryKey: ['gmail-accounts'],
    queryFn: async () => {
      const res = await fetch('/api/gmail/accounts')
      if (!res.ok) throw new Error('Failed to load accounts')
      return res.json()
    },
  })

  const emailsQuery = useQuery<{ emails: EmailRow[]; total: number }>({
    queryKey: ['outbox-emails', activeAccount, search],
    queryFn: async () => {
      const params = new URLSearchParams({ folder: 'sent', limit: '100' })
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
          folder: 'sent',
        }),
      })
      if (!res.ok) {
        const d = await res.json().catch(() => ({}))
        throw new Error(d.error || 'Sync failed')
      }
      return res.json()
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['outbox-emails'] }),
  })

  const accounts = accountsQuery.data?.accounts ?? []
  const emails = emailsQuery.data?.emails ?? []

  return (
    <div className="space-y-4 max-w-6xl">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="rounded-lg bg-primary-soft p-2.5 bg-primary-soft">
            <Send className="h-6 w-6 text-primary" />
          </div>
          <div>
            <h2 className="text-2xl font-bold tracking-tight">Outbox</h2>
            <p className="text-sm text-muted-foreground">Sent emails across connected accounts.</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => syncMutation.mutate()}
            disabled={syncMutation.isPending || accounts.length === 0}
            className="inline-flex items-center gap-2 rounded-lg border border-border px-3 py-2 text-sm font-medium hover:bg-muted disabled:opacity-50 border-border hover:bg-muted"
          >
            <RefreshCw className={cn('h-4 w-4', syncMutation.isPending && 'animate-spin')} />
            Sync
          </button>
          <button
            onClick={() => setComposeOpen(true)}
            disabled={accounts.length === 0}
            className="inline-flex items-center gap-2 rounded-lg bg-foreground px-4 py-2 text-sm font-medium text-background hover:bg-foreground/90 disabled:opacity-50"
          >
            <Plus className="h-4 w-4" /> New email
          </button>
        </div>
      </div>

      {accounts.length === 0 ? (
        <div className="rounded-xl border border-warning/30 bg-warning/15 p-6 border-warning/30 bg-warning/15">
          <div className="flex items-start gap-3 text-sm text-warning">
            <AlertCircle className="h-4 w-4 mt-0.5 flex-shrink-0" />
            <div>
              <div className="font-medium">No Gmail accounts connected yet</div>
              <div className="text-xs mt-1">
                Go to <a href="/settings" className="underline">Settings</a> to connect them.
              </div>
            </div>
          </div>
        </div>
      ) : (
        <>
          <div className="flex items-center justify-between flex-wrap gap-3">
            <div className="flex items-center gap-2 flex-wrap">
              <Chip
                label="All accounts"
                active={activeAccount === null}
                onClick={() => setActiveAccount(null)}
              />
              {accounts.map((a) => (
                <Chip
                  key={a.id}
                  label={a.email}
                  active={activeAccount === a.email}
                  onClick={() => setActiveAccount(a.email)}
                />
              ))}
            </div>
            <div className="relative max-w-sm flex-1">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground/70" />
              <input
                type="text"
                placeholder="Search sent emails…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="w-full rounded-lg border border-border bg-card pl-10 pr-3 py-2 text-sm focus:border-primary/50 focus:outline-none border-border bg-card"
              />
            </div>
          </div>

          <div className="rounded-xl border border-border bg-card border-border bg-card overflow-hidden">
            {emailsQuery.isLoading ? (
              <div className="px-6 py-12 text-center text-sm text-muted-foreground">Loading…</div>
            ) : emails.length === 0 ? (
              <div className="px-6 py-12 text-center">
                <Mail className="mx-auto h-8 w-8 text-muted-foreground/50 mb-3" />
                <p className="text-sm text-muted-foreground">
                  {search ? 'No matches.' : 'No sent emails yet. Click Sync or compose a new one.'}
                </p>
              </div>
            ) : (
              <div className="divide-y divide-border-soft">
                {emails.map((email) => (
                  <div key={email.id} className="flex items-start gap-4 px-5 py-3">
                    <div className="rounded-full bg-muted p-2 flex-shrink-0 bg-surface-muted">
                      <User className="h-4 w-4 text-muted-foreground" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium truncate">to {email.to}</span>
                        <span className="text-[10px] text-muted-foreground/70 uppercase tracking-wide">
                          {email.account.email.split('@')[0]}
                        </span>
                      </div>
                      <p className="text-sm truncate mt-0.5">{email.subject || '(no subject)'}</p>
                      <p className="text-xs text-muted-foreground truncate mt-0.5">{email.snippet}</p>
                    </div>
                    <span className="text-[11px] text-muted-foreground/70 whitespace-nowrap flex-shrink-0">
                      {formatDate(email.date)}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </>
      )}

      {composeOpen && (
        <ComposeModal
          accounts={accounts}
          defaultAccount={activeAccount || accounts[0]?.email}
          onClose={() => setComposeOpen(false)}
          onSent={() => {
            setComposeOpen(false)
            qc.invalidateQueries({ queryKey: ['outbox-emails'] })
          }}
        />
      )}
    </div>
  )
}

function Chip({
  label,
  active,
  onClick,
}: {
  label: string
  active: boolean
  onClick: () => void
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        'rounded-md border px-3 py-1 text-xs font-medium transition-all',
        active
          ? 'bg-primary-soft border-primary/30 text-primary bg-primary-soft border-primary/30 text-primary'
          : 'border-border text-muted-foreground hover:border-foreground/30 border-border hover:border-foreground/30'
      )}
    >
      {label}
    </button>
  )
}

function ComposeModal({
  accounts,
  defaultAccount,
  onClose,
  onSent,
}: {
  accounts: GmailAccount[]
  defaultAccount?: string
  onClose: () => void
  onSent: () => void
}) {
  const [fromAccount, setFromAccount] = useState(defaultAccount || '')
  const [to, setTo] = useState('')
  const [subject, setSubject] = useState('')
  const [body, setBody] = useState('')

  const sendMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch('/api/emails/send', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          accountEmail: fromAccount,
          to: to.trim(),
          subject: subject.trim(),
          body: wrapEmailHtml(body),
        }),
      })
      if (!res.ok) {
        const d = await res.json().catch(() => ({}))
        throw new Error(d.error || 'Send failed')
      }
      return res.json()
    },
    onSuccess: onSent,
  })

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/50" onClick={onClose} />
      <div className="relative w-full max-w-2xl rounded-xl bg-card p-6 shadow-pop bg-card">
        <div className="flex items-start justify-between mb-4">
          <h3 className="text-lg font-semibold">New email</h3>
          <button
            onClick={onClose}
            className="rounded-md p-1 text-muted-foreground/70 hover:bg-muted"
          >
            <X className="h-5 w-5" />
          </button>
        </div>
        <div className="space-y-3">
          <div>
            <label className="mb-1.5 block text-sm font-medium">From</label>
            <select
              value={fromAccount}
              onChange={(e) => setFromAccount(e.target.value)}
              className="w-full rounded-md border border-border px-3 py-2 text-sm focus:border-primary/50 focus:outline-none border-border bg-background"
            >
              {accounts.map((a) => (
                <option key={a.id} value={a.email}>
                  {a.email}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="mb-1.5 block text-sm font-medium">To</label>
            <input
              type="text"
              value={to}
              onChange={(e) => setTo(e.target.value)}
              placeholder="recipient@example.com"
              className="w-full rounded-md border border-border px-3 py-2 text-sm focus:border-primary/50 focus:outline-none border-border bg-background"
            />
          </div>
          <div>
            <label className="mb-1.5 block text-sm font-medium">Subject</label>
            <input
              type="text"
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              className="w-full rounded-md border border-border px-3 py-2 text-sm focus:border-primary/50 focus:outline-none border-border bg-background"
            />
          </div>
          <div>
            <label className="mb-1.5 block text-sm font-medium">Body</label>
            <RichEditor
              onChange={setBody}
              placeholder="Write your email…"
              minHeight="250px"
            />
          </div>
          {sendMutation.isError && (
            <p className="text-xs text-destructive">
              {(sendMutation.error as Error).message}
            </p>
          )}
          <div className="flex items-center justify-end gap-2 pt-2">
            <button
              onClick={onClose}
              className="rounded-md px-4 py-2 text-sm font-medium text-muted-foreground hover:bg-muted"
            >
              Cancel
            </button>
            <button
              onClick={() => sendMutation.mutate()}
              disabled={
                sendMutation.isPending || !fromAccount || !to || !subject || !body
              }
              className="rounded-md bg-foreground px-4 py-2 text-sm font-medium text-background hover:bg-foreground/90 disabled:opacity-50"
            >
              {sendMutation.isPending ? 'Sending…' : 'Send'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
