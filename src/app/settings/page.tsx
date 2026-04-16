'use client'

import { useState, useEffect } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useSearchParams } from 'next/navigation'
import {
  Settings,
  MessageSquare,
  Hash,
  Send,
  Check,
  AlertCircle,
  Mail,
  Plus,
  Trash2,
} from 'lucide-react'
import { cn } from '@/lib/utils'

export default function SettingsPage() {
  return (
    <div className="max-w-3xl space-y-8">
      <div>
        <div className="flex items-center gap-3">
          <div className="rounded-lg bg-purple-50 p-2.5 dark:bg-purple-950">
            <Settings className="h-6 w-6 text-purple-600" />
          </div>
          <h2 className="text-2xl font-bold tracking-tight">Settings</h2>
        </div>
        <p className="mt-2 text-sm text-zinc-500">
          Configure integrations, connect accounts, and verify things are working.
        </p>
      </div>

      <GmailConnectSection />

      <SlackTestSection />

      <TwilioTestSection />

      <ComingSoonSection />
    </div>
  )
}

function GmailConnectSection() {
  const qc = useQueryClient()
  const searchParams = useSearchParams()
  const [notice, setNotice] = useState<{ type: 'success' | 'error'; text: string } | null>(null)

  const { data } = useQuery<{
    accounts: Array<{ id: string; email: string; _count?: { emails: number } }>
  }>({
    queryKey: ['gmail-accounts'],
    queryFn: async () => {
      const res = await fetch('/api/gmail/accounts')
      if (!res.ok) throw new Error('Failed to load accounts')
      return res.json()
    },
  })

  const disconnectMutation = useMutation({
    mutationFn: async (email: string) => {
      const res = await fetch(`/api/gmail/accounts?email=${encodeURIComponent(email)}`, {
        method: 'DELETE',
      })
      if (!res.ok) throw new Error('Disconnect failed')
      return res.json()
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['gmail-accounts'] }),
  })

  const syncMutation = useMutation({
    mutationFn: async (email: string) => {
      const res = await fetch('/api/gmail/sync', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email, folder: 'both' }),
      })
      if (!res.ok) {
        const d = await res.json().catch(() => ({}))
        throw new Error(d.error || 'Sync failed')
      }
      return res.json()
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['gmail-accounts'] }),
  })

  // Surface callback query params from the OAuth redirect
  useEffect(() => {
    const connected = searchParams.get('gmail_connected')
    const error = searchParams.get('gmail_error')
    if (connected) setNotice({ type: 'success', text: `Connected ${connected}` })
    if (error) setNotice({ type: 'error', text: `Gmail connect failed: ${error}` })
  }, [searchParams])

  const accounts = data?.accounts ?? []

  return (
    <section className="rounded-xl border border-zinc-200 bg-white p-6 dark:border-zinc-800 dark:bg-zinc-900">
      <div className="flex items-center justify-between mb-1">
        <div className="flex items-center gap-3">
          <Mail className="h-5 w-5 text-purple-600" />
          <h3 className="font-semibold">Gmail accounts</h3>
        </div>
        <a
          href="/api/gmail/connect"
          className="inline-flex items-center gap-1.5 rounded-md bg-purple-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-purple-700"
        >
          <Plus className="h-3.5 w-3.5" /> Connect account
        </a>
      </div>
      <p className="text-sm text-zinc-500 mb-4">
        Connect <code className="text-xs bg-zinc-100 dark:bg-zinc-800 px-1 py-0.5 rounded">alex@leadgenisys.com</code>{' '}
        and <code className="text-xs bg-zinc-100 dark:bg-zinc-800 px-1 py-0.5 rounded">ethan@leadgenisys.com</code>.
        Each click opens Google&apos;s consent screen — sign in as that specific account.
      </p>

      {notice && (
        <Alert variant={notice.type}>
          {notice.text}
        </Alert>
      )}

      {accounts.length === 0 ? (
        <p className="text-xs text-zinc-400 py-2">No accounts connected yet.</p>
      ) : (
        <div className="space-y-2">
          {accounts.map((a) => (
            <div
              key={a.id}
              className="flex items-center justify-between rounded-md border border-zinc-200 px-3 py-2 dark:border-zinc-800"
            >
              <div className="min-w-0">
                <p className="text-sm font-medium truncate">{a.email}</p>
                <p className="text-xs text-zinc-500">
                  {a._count?.emails ?? 0} email{a._count?.emails === 1 ? '' : 's'} synced
                </p>
              </div>
              <div className="flex items-center gap-1 flex-shrink-0">
                <button
                  onClick={() => syncMutation.mutate(a.email)}
                  disabled={syncMutation.isPending}
                  className="rounded-md px-2 py-1 text-xs text-zinc-600 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800"
                >
                  {syncMutation.isPending && syncMutation.variables === a.email
                    ? 'Syncing…'
                    : 'Sync now'}
                </button>
                <button
                  onClick={() => disconnectMutation.mutate(a.email)}
                  disabled={disconnectMutation.isPending}
                  className="rounded-md p-1 text-zinc-400 hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-950"
                  title="Disconnect"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  )
}

function SlackTestSection() {
  const [email, setEmail] = useState('')
  const [message, setMessage] = useState(
    'Test from Genisys Hub — if you see this DM, the vault → Slack path is working.'
  )

  const mutation = useMutation({
    mutationFn: async (params: { email: string; message: string }) => {
      const res = await fetch('/api/slack/test', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(params),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Send failed')
      return data as { ok: true; channel: string; ts: string }
    },
  })

  function submit(e: React.FormEvent) {
    e.preventDefault()
    mutation.mutate({ email: email.trim(), message: message.trim() })
  }

  return (
    <section className="rounded-xl border border-zinc-200 bg-white p-6 dark:border-zinc-800 dark:bg-zinc-900">
      <div className="flex items-center gap-3 mb-1">
        <Hash className="h-5 w-5 text-purple-600" />
        <h3 className="font-semibold">Slack — Send test DM</h3>
      </div>
      <p className="text-sm text-zinc-500 mb-4">
        Uses <code className="text-xs bg-zinc-100 dark:bg-zinc-800 px-1 py-0.5 rounded">Slack Bot Token</code>{' '}
        from the vault. Looks up the user by email in your Slack workspace and sends a direct message.
        This is how morning briefs will be delivered.
      </p>

      <form onSubmit={submit} className="space-y-4">
        <div>
          <label className="mb-1.5 block text-sm font-medium">Recipient email</label>
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="ethan@leadgenisys.com"
            required
            className="w-full rounded-md border border-zinc-200 px-3 py-2 text-sm focus:border-purple-500 focus:outline-none dark:border-zinc-800 dark:bg-zinc-950"
          />
          <p className="mt-1 text-xs text-zinc-400">
            Must match the email the person uses to sign into your Slack workspace.
          </p>
        </div>

        <div>
          <label className="mb-1.5 block text-sm font-medium">Message</label>
          <textarea
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            rows={3}
            required
            className="w-full rounded-md border border-zinc-200 px-3 py-2 text-sm focus:border-purple-500 focus:outline-none dark:border-zinc-800 dark:bg-zinc-950"
          />
        </div>

        <div className="flex items-center gap-3">
          <button
            type="submit"
            disabled={mutation.isPending || !email || !message}
            className="inline-flex items-center gap-2 rounded-md bg-purple-600 px-4 py-2 text-sm font-medium text-white hover:bg-purple-700 disabled:opacity-50"
          >
            <Send className="h-4 w-4" />
            {mutation.isPending ? 'Sending…' : 'Send test DM'}
          </button>
        </div>
      </form>

      {mutation.isSuccess && (
        <Alert variant="success">
          <div className="font-medium">DM sent.</div>
          <div className="text-xs mt-1 space-y-0.5">
            <div>Channel: <code className="text-xs">{mutation.data.channel}</code></div>
            <div>Timestamp: <code className="text-xs">{mutation.data.ts}</code></div>
          </div>
        </Alert>
      )}

      {mutation.isError && (
        <Alert variant="error">
          <div className="font-medium">Failed to send DM</div>
          <div className="text-xs mt-1">{(mutation.error as Error).message}</div>
        </Alert>
      )}
    </section>
  )
}

function TwilioTestSection() {
  const [to, setTo] = useState('')
  const [body, setBody] = useState('Test from Genisys Hub — if you see this, the vault→Twilio path is working.')

  const mutation = useMutation({
    mutationFn: async (params: { to: string; body: string }) => {
      const res = await fetch('/api/sms/test', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(params),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Send failed')
      return data as { ok: true; sid: string; status: string; from: string }
    },
  })

  function submit(e: React.FormEvent) {
    e.preventDefault()
    mutation.mutate({ to: to.trim(), body: body.trim() })
  }

  return (
    <section className="rounded-xl border border-zinc-200 bg-white p-6 dark:border-zinc-800 dark:bg-zinc-900">
      <div className="flex items-center gap-3 mb-1">
        <MessageSquare className="h-5 w-5 text-purple-600" />
        <h3 className="font-semibold">Twilio — Send test SMS</h3>
      </div>
      <p className="text-sm text-zinc-500 mb-4">
        Uses <code className="text-xs bg-zinc-100 dark:bg-zinc-800 px-1 py-0.5 rounded">Twilio Account SID</code>{' '}
        and <code className="text-xs bg-zinc-100 dark:bg-zinc-800 px-1 py-0.5 rounded">Twilio Auth Token</code>{' '}
        from the vault. On the trial plan, the destination number must be verified in the Twilio console.
      </p>

      <form onSubmit={submit} className="space-y-4">
        <div>
          <label className="mb-1.5 block text-sm font-medium">To (E.164 format)</label>
          <input
            type="tel"
            value={to}
            onChange={(e) => setTo(e.target.value)}
            placeholder="+16035026226"
            required
            className="w-full rounded-md border border-zinc-200 px-3 py-2 text-sm font-mono focus:border-purple-500 focus:outline-none dark:border-zinc-800 dark:bg-zinc-950"
          />
          <p className="mt-1 text-xs text-zinc-400">
            Include the <code>+</code> and country code. Ethan: <code>+16035026226</code>. Alex: <code>+16034185315</code>.
          </p>
        </div>

        <div>
          <label className="mb-1.5 block text-sm font-medium">Message</label>
          <textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            rows={3}
            required
            className="w-full rounded-md border border-zinc-200 px-3 py-2 text-sm focus:border-purple-500 focus:outline-none dark:border-zinc-800 dark:bg-zinc-950"
          />
          <p className="mt-1 text-xs text-zinc-400">
            {body.length} / 1600 characters. Trial messages are prefixed with &quot;Sent from your Twilio trial account -&quot;.
          </p>
        </div>

        <div className="flex items-center gap-3">
          <button
            type="submit"
            disabled={mutation.isPending || !to || !body}
            className="inline-flex items-center gap-2 rounded-md bg-purple-600 px-4 py-2 text-sm font-medium text-white hover:bg-purple-700 disabled:opacity-50"
          >
            <Send className="h-4 w-4" />
            {mutation.isPending ? 'Sending…' : 'Send test SMS'}
          </button>
        </div>
      </form>

      {mutation.isSuccess && (
        <Alert variant="success">
          <div className="font-medium">Sent.</div>
          <div className="text-xs mt-1 space-y-0.5">
            <div>Message SID: <code className="text-xs">{mutation.data.sid}</code></div>
            <div>Status: <code className="text-xs">{mutation.data.status}</code></div>
            <div>From: <code className="text-xs">{mutation.data.from}</code></div>
          </div>
        </Alert>
      )}

      {mutation.isError && (
        <Alert variant="error">
          <div className="font-medium">Failed to send</div>
          <div className="text-xs mt-1">{(mutation.error as Error).message}</div>
        </Alert>
      )}
    </section>
  )
}

function ComingSoonSection() {
  return (
    <section className="rounded-xl border border-zinc-200 bg-zinc-50 p-6 dark:border-zinc-800 dark:bg-zinc-950/50">
      <h3 className="font-semibold mb-2">Coming next</h3>
      <ul className="space-y-2 text-sm text-zinc-600 dark:text-zinc-400">
        <li>• Connect additional Gmail accounts (alex@, ethan@leadgenisys.com)</li>
        <li>• Register each GHL sub-account with its token mapping</li>
        <li>• Per-user morning brief schedule (time of day + what to include)</li>
        <li>• Connect Trustware Google Calendar (OAuth or iCal URL)</li>
        <li>• Team member management (roles, access)</li>
      </ul>
    </section>
  )
}

function Alert({
  variant,
  children,
}: {
  variant: 'success' | 'error'
  children: React.ReactNode
}) {
  const styles =
    variant === 'success'
      ? 'border-green-200 bg-green-50 text-green-800 dark:border-green-900 dark:bg-green-950 dark:text-green-200'
      : 'border-red-200 bg-red-50 text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-200'

  const Icon = variant === 'success' ? Check : AlertCircle

  return (
    <div className={cn('mt-4 flex items-start gap-3 rounded-md border p-3 text-sm', styles)}>
      <Icon className="h-4 w-4 mt-0.5 flex-shrink-0" />
      <div>{children}</div>
    </div>
  )
}
