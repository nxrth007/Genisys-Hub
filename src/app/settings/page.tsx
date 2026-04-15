'use client'

import { useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import { Settings, MessageSquare, Send, Check, AlertCircle } from 'lucide-react'
import { cn } from '@/lib/utils'

export default function SettingsPage() {
  return (
    <div className="max-w-3xl space-y-8">
      <div>
        <div className="flex items-center gap-3">
          <div className="rounded-lg bg-blue-50 p-2.5 dark:bg-blue-950">
            <Settings className="h-6 w-6 text-blue-600" />
          </div>
          <h2 className="text-2xl font-bold tracking-tight">Settings</h2>
        </div>
        <p className="mt-2 text-sm text-zinc-500">
          Configure integrations, connect accounts, and verify things are working.
        </p>
      </div>

      <TwilioTestSection />

      <ComingSoonSection />
    </div>
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
        <MessageSquare className="h-5 w-5 text-blue-600" />
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
            className="w-full rounded-md border border-zinc-200 px-3 py-2 text-sm font-mono focus:border-blue-500 focus:outline-none dark:border-zinc-800 dark:bg-zinc-950"
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
            className="w-full rounded-md border border-zinc-200 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none dark:border-zinc-800 dark:bg-zinc-950"
          />
          <p className="mt-1 text-xs text-zinc-400">
            {body.length} / 1600 characters. Trial messages are prefixed with &quot;Sent from your Twilio trial account -&quot;.
          </p>
        </div>

        <div className="flex items-center gap-3">
          <button
            type="submit"
            disabled={mutation.isPending || !to || !body}
            className="inline-flex items-center gap-2 rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
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
