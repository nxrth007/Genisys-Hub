'use client'

import { useState, useEffect, useRef } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
// Note: useSearchParams avoided here — causes Next.js 16 prerender OOM/failure.
// Reading query params via window.location.search in useEffect instead.
import {
  Settings,
  MessageSquare,
  Hash,
  Send,
  Check,
  AlertCircle,
  Mail,
  Calendar,
  Plus,
  Trash2,
  HardDrive,
  Bell,
  Phone as PhoneIcon,
  FileSpreadsheet,
  Wrench,
  Pause,
  Play,
  MessagesSquare,
  RefreshCw,
  Sun,
  Loader2,
  CheckCircle2,
} from 'lucide-react'
import { cn } from '@/lib/utils'
// Importing from the client-safe constants module — pulling from
// `lib/reminders` would drag Prisma + Drive helpers into the browser
// bundle.
import {
  REMINDER_LABELS,
  REMINDER_TYPES,
  TEMPLATE_VARIABLES,
  VALID_PLACEHOLDER_KEYS,
  SAMPLE_FILLS,
  type ReminderType,
} from '@/lib/reminders-constants'

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

      <GmailConnectSection />

      <DriveConnectSection />

      <CalendarConnectionsSection />

      <ScheduledBriefsSection />

      <SlackTestSection />

      <ClientSlackDeliverySection />

      <ClientAlertsSection />

      <TwilioTestSection />

      <SheetMaintenanceSection />

      <AppointmentRemindersSection />

      <SolarApiUsageSection />

      <ComingSoonSection />
    </div>
  )
}

function GmailConnectSection() {
  const qc = useQueryClient()
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

  // Surface callback query params from the Gmail OAuth redirect.
  // Using window.location instead of useSearchParams to avoid Next.js 16
  // prerender failures (useSearchParams requires Suspense boundaries).
  useEffect(() => {
    if (typeof window === 'undefined') return
    const params = new URLSearchParams(window.location.search)
    const connected = params.get('gmail_connected')
    const error = params.get('gmail_error')
    if (connected) setNotice({ type: 'success', text: `Connected ${connected}` })
    if (error) setNotice({ type: 'error', text: `Gmail connect failed: ${error}` })
  }, [])

  const accounts = data?.accounts ?? []

  return (
    <section className="rounded-xl border border-zinc-200 bg-white p-6 dark:border-zinc-800 dark:bg-zinc-900">
      <div className="flex items-center justify-between mb-1">
        <div className="flex items-center gap-3">
          <Mail className="h-5 w-5 text-blue-600" />
          <h3 className="font-semibold">Gmail accounts</h3>
        </div>
        <a
          href="/api/gmail/connect"
          className="inline-flex items-center gap-1.5 rounded-md bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-700"
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

function DriveConnectSection() {
  const qc = useQueryClient()
  const [notice, setNotice] = useState<{ type: 'success' | 'error'; text: string } | null>(null)

  const { data } = useQuery<{
    accounts: Array<{ id: string; email: string; lastSyncedAt: string | null }>
  }>({
    queryKey: ['drive-accounts'],
    queryFn: async () => {
      const res = await fetch('/api/drive/accounts')
      if (!res.ok) throw new Error('Failed to load accounts')
      return res.json()
    },
  })

  const disconnectMutation = useMutation({
    mutationFn: async (email: string) => {
      const res = await fetch(`/api/drive/accounts?email=${encodeURIComponent(email)}`, {
        method: 'DELETE',
      })
      if (!res.ok) throw new Error('Disconnect failed')
      return res.json()
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['drive-accounts'] }),
  })

  useEffect(() => {
    if (typeof window === 'undefined') return
    const params = new URLSearchParams(window.location.search)
    const connected = params.get('drive_connected')
    const error = params.get('drive_error')
    if (connected) setNotice({ type: 'success', text: `Connected ${connected}` })
    if (error) setNotice({ type: 'error', text: `Drive connect failed: ${error}` })
  }, [])

  const accounts = data?.accounts ?? []

  return (
    <section className="rounded-xl border border-zinc-200 bg-white p-6 dark:border-zinc-800 dark:bg-zinc-900">
      <div className="flex items-center justify-between mb-1">
        <div className="flex items-center gap-3">
          <HardDrive className="h-5 w-5 text-blue-600" />
          <h3 className="font-semibold">Google Drive accounts</h3>
        </div>
        <a
          href="/api/drive/connect"
          className="inline-flex items-center gap-1.5 rounded-md bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-700"
        >
          <Plus className="h-3.5 w-3.5" /> Connect account
        </a>
      </div>
      <p className="text-sm text-zinc-500 mb-4">
        Read-only access to files owned by or shared with{' '}
        <code className="text-xs bg-zinc-100 dark:bg-zinc-800 px-1 py-0.5 rounded">alex@leadgenisys.com</code>{' '}
        and{' '}
        <code className="text-xs bg-zinc-100 dark:bg-zinc-800 px-1 py-0.5 rounded">ethan@leadgenisys.com</code>.
        Connect both accounts — the Drive page merges results so you see every file either of you can reach.
      </p>

      {notice && <Alert variant={notice.type}>{notice.text}</Alert>}

      {accounts.length === 0 ? (
        <p className="text-xs text-zinc-400 py-2">No Drive accounts connected yet.</p>
      ) : (
        <div className="space-y-2">
          {accounts.map((a) => (
            <div
              key={a.id}
              className="flex items-center justify-between rounded-md border border-zinc-200 px-3 py-2 dark:border-zinc-800"
            >
              <div className="min-w-0">
                <p className="text-sm font-medium truncate">{a.email}</p>
                <p className="text-xs text-zinc-500">Read-only Drive access</p>
              </div>
              <button
                onClick={() => disconnectMutation.mutate(a.email)}
                disabled={disconnectMutation.isPending}
                className="rounded-md p-1 text-zinc-400 hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-950"
                title="Disconnect"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </div>
          ))}
        </div>
      )}
    </section>
  )
}

function CalendarConnectionsSection() {
  const qc = useQueryClient()
  const [showAdd, setShowAdd] = useState(false)
  const [label, setLabel] = useState('')
  const [icalUrl, setIcalUrl] = useState('')

  const { data } = useQuery<{
    connections: Array<{ id: string; label: string; provider: string; email: string | null; icalUrl: string | null; createdAt: string }>
  }>({
    queryKey: ['calendar-connections'],
    queryFn: async () => {
      const res = await fetch('/api/calendar/connections')
      if (!res.ok) throw new Error('Failed')
      return res.json()
    },
  })

  const addMutation = useMutation({
    mutationFn: async (params: { label: string; icalUrl: string }) => {
      const res = await fetch('/api/calendar/connections', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(params),
      })
      if (!res.ok) {
        const d = await res.json().catch(() => ({}))
        throw new Error(d.error || 'Failed')
      }
      return res.json()
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['calendar-connections'] })
      setShowAdd(false)
      setLabel('')
      setIcalUrl('')
    },
  })

  const deleteMutation = useMutation({
    mutationFn: async (id: string) => {
      const res = await fetch(`/api/calendar/connections?id=${id}`, { method: 'DELETE' })
      if (!res.ok) throw new Error('Failed')
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['calendar-connections'] }),
  })

  const connections = data?.connections ?? []

  return (
    <section className="rounded-xl border border-zinc-200 bg-white p-6 dark:border-zinc-800 dark:bg-zinc-900">
      <div className="flex items-center justify-between mb-1">
        <div className="flex items-center gap-3">
          <Calendar className="h-5 w-5 text-blue-600" />
          <h3 className="font-semibold">Calendar connections</h3>
        </div>
        <button
          onClick={() => setShowAdd(!showAdd)}
          className="inline-flex items-center gap-1.5 rounded-md bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-700"
        >
          <Plus className="h-3.5 w-3.5" /> Add iCal feed
        </button>
      </div>
      <p className="text-sm text-zinc-500 mb-4">
        Add external calendars via iCal URL. Events appear on the Calendar page with their own color.
        Get the URL from Google Calendar → Settings → Integrate calendar → Secret address in iCal format.
      </p>

      {showAdd && (
        <div className="mb-4 rounded-lg border border-blue-200 bg-blue-50 p-4 dark:border-blue-800 dark:bg-blue-950/30 space-y-3">
          <div>
            <label className="mb-1 block text-xs font-medium">Label</label>
            <input
              type="text"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder='e.g. "Solar Meetings" or "Trustware (Ethan)"'
              className="w-full rounded-md border border-zinc-200 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none dark:border-zinc-800 dark:bg-zinc-950"
            />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium">iCal URL</label>
            <input
              type="url"
              value={icalUrl}
              onChange={(e) => setIcalUrl(e.target.value)}
              placeholder="https://calendar.google.com/calendar/ical/..."
              className="w-full rounded-md border border-zinc-200 px-3 py-2 text-sm font-mono text-xs focus:border-blue-500 focus:outline-none dark:border-zinc-800 dark:bg-zinc-950"
            />
          </div>
          <div className="flex gap-2">
            <button
              onClick={() => addMutation.mutate({ label, icalUrl })}
              disabled={addMutation.isPending || !label || !icalUrl}
              className="rounded-md bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-50"
            >
              {addMutation.isPending ? 'Adding…' : 'Add'}
            </button>
            <button
              onClick={() => setShowAdd(false)}
              className="rounded-md px-3 py-1.5 text-xs text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800"
            >
              Cancel
            </button>
          </div>
          {addMutation.isError && (
            <p className="text-xs text-red-600">{(addMutation.error as Error).message}</p>
          )}
        </div>
      )}

      {connections.length === 0 ? (
        <p className="text-xs text-zinc-400 py-2">No external calendars connected yet.</p>
      ) : (
        <div className="space-y-2">
          {connections.map((c) => (
            <div
              key={c.id}
              className="flex items-center justify-between rounded-md border border-zinc-200 px-3 py-2 dark:border-zinc-800"
            >
              <div className="min-w-0">
                <p className="text-sm font-medium">{c.label}</p>
                <p className="text-xs text-zinc-500 truncate">{c.provider === 'ical' ? 'iCal feed' : c.provider}</p>
              </div>
              <button
                onClick={() => deleteMutation.mutate(c.id)}
                disabled={deleteMutation.isPending}
                className="rounded-md p-1 text-zinc-400 hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-950"
                title="Remove"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </div>
          ))}
        </div>
      )}
    </section>
  )
}

type Schedule = {
  id: string
  userId: string
  timeOfDay: string
  channel: 'slack' | 'ghl_sms' | string
  recipientPhone: string | null
  notionAssignee: string | null
  timezone: string | null
  includeTasks: boolean
  includeMeetings: boolean
  enabled: boolean
  lastSentAt: string | null
  user: { id: string; email: string; name: string | null }
}

const TIMEZONE_OPTIONS: Array<{ value: string; label: string }> = [
  { value: 'America/New_York', label: 'Eastern (New York)' },
  { value: 'America/Chicago', label: 'Central (Chicago)' },
  { value: 'America/Denver', label: 'Mountain (Denver)' },
  { value: 'America/Phoenix', label: 'Mountain — no DST (Phoenix)' },
  { value: 'America/Los_Angeles', label: 'Pacific (Los Angeles)' },
  { value: 'America/Anchorage', label: 'Alaska' },
  { value: 'Pacific/Honolulu', label: 'Hawaii' },
  { value: 'UTC', label: 'UTC' },
]

function ScheduledBriefsSection() {
  const qc = useQueryClient()
  const { data } = useQuery<{ schedules: Schedule[] }>({
    queryKey: ['admin-schedules'],
    queryFn: async () => {
      const res = await fetch('/api/admin/schedules')
      if (!res.ok) throw new Error('Failed to load')
      return res.json()
    },
  })
  const schedules = data?.schedules ?? []

  // Prefill the "schedule owner" with the currently signed-in user. The
  // owner is just for record-keeping / Slack routing — the SMS recipient
  // is a separate phone with its own timezone, configured below.
  const { data: session } = useQuery<{ user?: { email?: string } }>({
    queryKey: ['session'],
    queryFn: async () => {
      const res = await fetch('/api/auth/session')
      if (!res.ok) return {}
      return res.json()
    },
  })
  const currentEmail = session?.user?.email || ''

  const [showAdd, setShowAdd] = useState(false)
  const [form, setForm] = useState<{
    userEmail: string
    timeOfDay: string
    channel: 'slack' | 'ghl_sms'
    recipientPhone: string
    notionAssignee: string
    timezone: string
  }>({
    userEmail: '',
    timeOfDay: '09:00',
    channel: 'ghl_sms',
    recipientPhone: '+16035026226',
    notionAssignee: 'Ethan',
    timezone: 'America/Los_Angeles',
  })

  // Derived value — renders current user email as the default when the
  // admin hasn't typed anything yet. Avoids a setState-in-effect pattern.
  const effectiveUserEmail = form.userEmail || currentEmail

  // One-click presets for the two known team members. Alex + Ethan is the
  // common case for a long time, so wiring these up shaves the whole
  // filling-in-the-form step down to a click + save.
  const presets: Array<{ label: string; values: typeof form }> = [
    {
      label: 'Ethan (9 AM PT)',
      values: {
        userEmail: '',
        timeOfDay: '09:00',
        channel: 'ghl_sms',
        recipientPhone: '+16035026226',
        notionAssignee: 'Ethan',
        timezone: 'America/Los_Angeles',
      },
    },
    {
      label: 'Alex (11 AM ET)',
      values: {
        userEmail: '',
        timeOfDay: '11:00',
        channel: 'ghl_sms',
        recipientPhone: '+16034185315',
        notionAssignee: 'Alex',
        timezone: 'America/New_York',
      },
    },
  ]

  const saveMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch('/api/admin/schedules', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          userEmail: effectiveUserEmail.trim(),
          timeOfDay: form.timeOfDay,
          channel: form.channel,
          recipientPhone: form.channel === 'ghl_sms' ? form.recipientPhone.trim() : null,
          notionAssignee: form.notionAssignee.trim() || null,
          timezone: form.timezone,
        }),
      })
      const d = await res.json()
      if (!res.ok) throw new Error(d.error || 'Save failed')
      return d
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['admin-schedules'] })
      setShowAdd(false)
    },
  })

  const deleteMutation = useMutation({
    mutationFn: async (id: string) => {
      const res = await fetch(`/api/admin/schedules?id=${id}`, { method: 'DELETE' })
      if (!res.ok) throw new Error('Delete failed')
      return res.json()
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['admin-schedules'] }),
  })

  // Pause / resume toggle — flips ScheduledSms.enabled. The scheduler
  // already skips disabled schedules on every cron tick, so paused briefs
  // stop firing within a minute of flipping this. Resuming just un-pauses;
  // it doesn't back-fill any missed days.
  const pauseMutation = useMutation({
    mutationFn: async (params: { id: string; enabled: boolean }) => {
      const res = await fetch(`/api/admin/schedules/${params.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ enabled: params.enabled }),
      })
      const d = await res.json()
      if (!res.ok) throw new Error(d.error || 'Update failed')
      return d
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['admin-schedules'] }),
  })

  const testMutation = useMutation({
    mutationFn: async (s: Schedule) => {
      const res = await fetch('/api/admin/schedules/test', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(
          s.channel === 'ghl_sms'
            ? {
                channel: 'ghl_sms',
                phone: s.recipientPhone,
                firstName: s.user.name?.split(' ')[0],
                notionAssignee: s.notionAssignee,
              }
            : { channel: 'slack', email: s.user.email }
        ),
      })
      const d = await res.json()
      if (!res.ok) throw new Error(d.error || 'Send failed')
      return d
    },
  })

  return (
    <section className="rounded-xl border border-zinc-200 bg-white p-6 dark:border-zinc-800 dark:bg-zinc-900">
      <div className="mb-1 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Bell className="h-5 w-5 text-blue-600" />
          <h3 className="font-semibold">Daily brief schedules</h3>
        </div>
        <button
          onClick={() => setShowAdd((v) => !v)}
          className="inline-flex items-center gap-1.5 rounded-md bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-700"
        >
          <Plus className="h-3.5 w-3.5" /> Add schedule
        </button>
      </div>
      <p className="mb-4 text-sm text-zinc-500">
        Scheduled morning briefs run via the in-process cron. For GHL SMS, the
        schedule owner&apos;s timezone decides when 9 AM happens — the{' '}
        <span className="font-medium">phone</span> is the actual recipient and
        doesn&apos;t need a Hub account. Slack DMs route to the schedule owner
        directly.
      </p>

      {showAdd && (
        <form
          onSubmit={(e) => {
            e.preventDefault()
            saveMutation.mutate()
          }}
          className="mb-4 space-y-3 rounded-lg border border-blue-200 bg-blue-50 p-4 dark:border-blue-800 dark:bg-blue-950/30"
        >
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[10px] font-semibold uppercase tracking-wide text-zinc-500">
              Quick preset:
            </span>
            {presets.map((p) => (
              <button
                key={p.label}
                type="button"
                onClick={() => setForm(p.values)}
                className="rounded-full border border-blue-300 bg-white px-3 py-1 text-xs font-medium text-blue-700 hover:bg-blue-100 dark:border-blue-700 dark:bg-zinc-900 dark:text-blue-300 dark:hover:bg-blue-950/50"
              >
                {p.label}
              </button>
            ))}
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label className="mb-1 block text-xs font-medium">
                Schedule owner (Hub user)
              </label>
              <input
                type="email"
                value={effectiveUserEmail}
                onChange={(e) => setForm({ ...form, userEmail: e.target.value })}
                required
                className="w-full rounded-md border border-zinc-200 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none dark:border-zinc-800 dark:bg-zinc-950"
              />
              <p className="mt-1 text-[10px] text-zinc-500">
                Record-keeping only. Defaulted to you. The actual SMS goes to
                the phone below — Ethan does NOT need a Hub account.
              </p>
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium">Time (24-hour)</label>
              <input
                type="time"
                value={form.timeOfDay}
                onChange={(e) => setForm({ ...form, timeOfDay: e.target.value })}
                required
                className="w-full rounded-md border border-zinc-200 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none dark:border-zinc-800 dark:bg-zinc-950"
              />
              <p className="mt-1 text-[10px] text-zinc-500">
                Interpreted in the timezone below.
              </p>
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium">
                Recipient timezone
              </label>
              <select
                value={form.timezone}
                onChange={(e) => setForm({ ...form, timezone: e.target.value })}
                className="w-full rounded-md border border-zinc-200 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none dark:border-zinc-800 dark:bg-zinc-950"
              >
                {TIMEZONE_OPTIONS.map((t) => (
                  <option key={t.value} value={t.value}>
                    {t.label}
                  </option>
                ))}
              </select>
              <p className="mt-1 text-[10px] text-zinc-500">
                When 9:00 AM happens, in the recipient&apos;s local time.
              </p>
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium">Channel</label>
              <select
                value={form.channel}
                onChange={(e) =>
                  setForm({ ...form, channel: e.target.value as 'slack' | 'ghl_sms' })
                }
                className="w-full rounded-md border border-zinc-200 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none dark:border-zinc-800 dark:bg-zinc-950"
              >
                <option value="ghl_sms">GHL SMS</option>
                <option value="slack">Slack DM</option>
              </select>
            </div>
            {form.channel === 'ghl_sms' && (
              <div>
                <label className="mb-1 block text-xs font-medium">
                  SMS recipient phone (E.164)
                </label>
                <input
                  type="tel"
                  value={form.recipientPhone}
                  onChange={(e) => setForm({ ...form, recipientPhone: e.target.value })}
                  placeholder="+16035026226"
                  className="w-full rounded-md border border-zinc-200 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none dark:border-zinc-800 dark:bg-zinc-950"
                />
                <p className="mt-1 text-[10px] text-zinc-500">
                  Who actually gets the text. GHL will auto-create the contact
                  if it doesn&apos;t exist yet.
                </p>
              </div>
            )}
            <div className="sm:col-span-2">
              <label className="mb-1 block text-xs font-medium">
                Notion Kanban assignee (optional)
              </label>
              <input
                type="text"
                value={form.notionAssignee}
                onChange={(e) => setForm({ ...form, notionAssignee: e.target.value })}
                placeholder="Ethan"
                className="w-full rounded-md border border-zinc-200 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none dark:border-zinc-800 dark:bg-zinc-950"
              />
              <p className="mt-1 text-[10px] text-zinc-500">
                If set, the brief pulls To-Do tasks assigned to this name from the
                pinned Notion Kanban (Today page) instead of local Hub tasks.
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="submit"
              disabled={saveMutation.isPending}
              className="rounded-md bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-50"
            >
              {saveMutation.isPending ? 'Saving…' : 'Save'}
            </button>
            <button
              type="button"
              onClick={() => setShowAdd(false)}
              className="rounded-md px-3 py-1.5 text-xs text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800"
            >
              Cancel
            </button>
            {saveMutation.isError && (
              <span className="text-xs text-red-600">
                {(saveMutation.error as Error).message}
              </span>
            )}
          </div>
        </form>
      )}

      {schedules.length === 0 ? (
        <p className="py-2 text-xs text-zinc-400">No scheduled briefs yet.</p>
      ) : (
        <div className="space-y-2">
          {schedules.map((s) => (
            <div
              key={s.id}
              className={cn(
                'flex items-center justify-between rounded-md border border-zinc-200 px-3 py-2 dark:border-zinc-800',
                !s.enabled && 'bg-zinc-50 opacity-70 dark:bg-zinc-950/40'
              )}
            >
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <p className="truncate text-sm font-medium">
                    {s.user.name || s.user.email}
                  </p>
                  <span
                    className={cn(
                      'rounded-full px-2 py-0.5 text-[10px] font-semibold',
                      s.channel === 'ghl_sms'
                        ? 'bg-green-100 text-green-700 dark:bg-green-950 dark:text-green-300'
                        : 'bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-300'
                    )}
                  >
                    {s.channel === 'ghl_sms' ? (
                      <span className="inline-flex items-center gap-1">
                        <PhoneIcon className="h-2.5 w-2.5" /> SMS
                      </span>
                    ) : (
                      'Slack'
                    )}
                  </span>
                  {!s.enabled && (
                    <span className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-semibold text-amber-700 dark:bg-amber-950 dark:text-amber-300">
                      <Pause className="h-2.5 w-2.5" /> Paused
                    </span>
                  )}
                  <span className="text-xs text-zinc-500">
                    {s.timeOfDay}
                    {s.timezone ? ` ${shortTz(s.timezone)}` : ''}
                  </span>
                </div>
                <p className="text-xs text-zinc-500">
                  {s.channel === 'ghl_sms' && s.recipientPhone
                    ? `→ ${s.recipientPhone}`
                    : s.user.email}
                  {s.notionAssignee && ` · Notion: ${s.notionAssignee}`}
                  {s.lastSentAt && ` · last sent ${new Date(s.lastSentAt).toLocaleDateString()}`}
                </p>
              </div>
              <div className="flex items-center gap-1">
                <button
                  onClick={() =>
                    pauseMutation.mutate({ id: s.id, enabled: !s.enabled })
                  }
                  disabled={pauseMutation.isPending}
                  title={
                    s.enabled
                      ? 'Pause this schedule — stops firing until resumed'
                      : 'Resume this schedule'
                  }
                  className={cn(
                    'inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium transition-colors',
                    s.enabled
                      ? 'text-amber-700 hover:bg-amber-50 dark:text-amber-300 dark:hover:bg-amber-950/40'
                      : 'text-green-700 hover:bg-green-50 dark:text-green-300 dark:hover:bg-green-950/40'
                  )}
                >
                  {s.enabled ? (
                    <>
                      <Pause className="h-3 w-3" /> Pause
                    </>
                  ) : (
                    <>
                      <Play className="h-3 w-3" /> Resume
                    </>
                  )}
                </button>
                <button
                  onClick={() => testMutation.mutate(s)}
                  disabled={testMutation.isPending}
                  className="rounded-md px-2 py-1 text-xs text-zinc-600 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800"
                >
                  {testMutation.isPending && testMutation.variables?.id === s.id
                    ? 'Sending…'
                    : 'Send now'}
                </button>
                <button
                  onClick={() => deleteMutation.mutate(s.id)}
                  disabled={deleteMutation.isPending}
                  className="rounded-md p-1 text-zinc-400 hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-950"
                  title="Delete"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {testMutation.isError && (
        <Alert variant="error">
          <div className="font-medium">Test send failed</div>
          <div className="mt-1 text-xs">{(testMutation.error as Error).message}</div>
        </Alert>
      )}
      {testMutation.isSuccess && (
        <Alert variant="success">
          <div className="font-medium">Brief sent.</div>
          <div className="mt-1 text-xs">
            Events: {(testMutation.data as { eventCount?: number }).eventCount ?? 0} ·
            Tasks: {(testMutation.data as { taskCount?: number }).taskCount ?? 0}
          </div>
        </Alert>
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
        <Hash className="h-5 w-5 text-blue-600" />
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
            className="w-full rounded-md border border-zinc-200 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none dark:border-zinc-800 dark:bg-zinc-950"
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
            className="w-full rounded-md border border-zinc-200 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none dark:border-zinc-800 dark:bg-zinc-950"
          />
        </div>

        <div className="flex items-center gap-3">
          <button
            type="submit"
            disabled={mutation.isPending || !email || !message}
            className="inline-flex items-center gap-2 rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
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

/* ------------------------------------------------------------------ */
/*  Client → Slack delivery                                            */
/*  Routes new appointments to the right client channel automatically  */
/* ------------------------------------------------------------------ */

type ClientForRouting = {
  id: string
  name: string
  state: string | null
  color: string
  lifecycle: string
  slackChannelId: string | null
  slackChannelName: string | null
  /** Used by the Client Alerts SMS section to surface which clients
   *  have a phone configured + drive the per-client "Send test SMS"
   *  button. Null when the client form left it blank. */
  contactPhone: string | null
}

type SlackChannelOption = {
  id: string
  name: string
  isPrivate: boolean
  isMember: boolean
}

function ClientSlackDeliverySection() {
  const qc = useQueryClient()
  // include=routable surfaces paused + onboarding clients alongside
  // active ones — admins want to pre-configure routing for clients
  // that aren't booking yet (or are temporarily on hold). Hidden from
  // the agent booking picker, which still uses the default filter.
  const clientsQuery = useQuery<{ clients: ClientForRouting[] }>({
    queryKey: ['clients-for-routing'],
    queryFn: async () => {
      const res = await fetch('/api/clients?include=routable')
      if (!res.ok) throw new Error('Failed to load clients')
      return res.json()
    },
  })
  const channelsQuery = useQuery<{ channels: SlackChannelOption[] }>({
    queryKey: ['slack-channels-for-routing'],
    queryFn: async () => {
      const res = await fetch('/api/slack/channels')
      if (!res.ok) {
        const d = await res.json().catch(() => ({}))
        throw new Error(d.error || 'Failed to load Slack channels')
      }
      return res.json()
    },
    retry: false,
  })

  const clients = clientsQuery.data?.clients ?? []
  const channels = channelsQuery.data?.channels ?? []

  return (
    <section className="rounded-2xl border border-zinc-200 bg-white p-6 shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
      <div className="flex items-start gap-3">
        <div className="rounded-lg bg-emerald-50 p-2 dark:bg-emerald-950">
          <Hash className="h-5 w-5 text-emerald-600" />
        </div>
        <div className="flex-1">
          <h3 className="text-base font-semibold">Client → Slack delivery</h3>
          <p className="mt-1 text-sm text-zinc-500">
            Pick the Slack channel for each client. When a new appointment
            for that client lands on the master sheet (whether a Hub
            booking or a manual entry), the bot posts the appointment
            details to the channel and pings <code>@channel</code> so
            everyone in there gets notified. Agent name is intentionally
            omitted from these posts.
          </p>
        </div>
      </div>

      {channelsQuery.isError && (
        <div className="mt-4">
          <Alert variant="error">
            <div className="font-medium">Couldn&apos;t load Slack channels</div>
            <div className="text-xs mt-1">
              {(channelsQuery.error as Error).message}
            </div>
          </Alert>
        </div>
      )}

      <div className="mt-5 space-y-2">
        {clientsQuery.isLoading ? (
          <p className="text-sm text-zinc-500">Loading clients…</p>
        ) : clients.length === 0 ? (
          <p className="text-sm text-zinc-500">
            No active clients. Add one on the Clients page first.
          </p>
        ) : (
          clients.map((c) => (
            <ClientRoutingRow
              key={c.id}
              client={c}
              channels={channels}
              channelsLoading={channelsQuery.isLoading}
              onSaved={() => {
                qc.invalidateQueries({ queryKey: ['clients-for-routing'] })
              }}
            />
          ))
        )}
      </div>
    </section>
  )
}

/* ------------------------------------------------------------------ */
/*  Client Alerts (SMS to clients on new appointments)                 */
/* ------------------------------------------------------------------ */

type ClientAlertsConfigShape = {
  enabled: boolean
  vaultEntryName: string
  senderPhone: string | null
}

function ClientAlertsSection() {
  const qc = useQueryClient()

  const configQuery = useQuery<{ config: ClientAlertsConfigShape }>({
    queryKey: ['client-alerts-config'],
    queryFn: async () => {
      const res = await fetch('/api/admin/client-alerts/config')
      if (!res.ok) {
        const d = await res.json().catch(() => ({}))
        throw new Error(d.error || 'Failed to load Client Alerts config')
      }
      return res.json()
    },
  })

  const clientsQuery = useQuery<{ clients: ClientForRouting[] }>({
    queryKey: ['clients-for-routing'],
    queryFn: async () => {
      const res = await fetch('/api/clients?include=routable')
      if (!res.ok) throw new Error('Failed to load clients')
      return res.json()
    },
  })

  const config = configQuery.data?.config
  const clients = clientsQuery.data?.clients ?? []
  const enabled = !!config?.enabled

  const [senderDraft, setSenderDraft] = useState<string>('')
  // Sync the local draft from the server config exactly once after the
  // first successful fetch — subsequent server-driven re-renders
  // shouldn't stomp the user's in-progress edits.
  const syncedRef = useRef(false)
  useEffect(() => {
    if (config && !syncedRef.current) {
      setSenderDraft(config.senderPhone ?? '')
      syncedRef.current = true
    }
  }, [config])

  const senderDirty = (config?.senderPhone ?? '') !== senderDraft.trim()

  const updateMutation = useMutation({
    mutationFn: async (
      payload: Partial<ClientAlertsConfigShape>,
    ): Promise<{
      config: ClientAlertsConfigShape
      backfill: { client: string; recorded: number }[] | null
    }> => {
      const res = await fetch('/api/admin/client-alerts/config', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Update failed')
      return data
    },
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: ['client-alerts-config'] })
      if (data.backfill) {
        const total = data.backfill.reduce((s, b) => s + b.recorded, 0)
        window.alert(
          `Client Alerts enabled. Backfilled ${total} historical row${total === 1 ? '' : 's'} as 'already-handled' so the next cron tick won't blast clients with SMS for past bookings. New appointments going forward will fire normally.`,
        )
      }
    },
    onError: (err) => {
      window.alert(`Couldn't save Client Alerts config: ${(err as Error).message}`)
    },
  })

  function handleToggle(next: boolean) {
    if (next && clients.every((c) => !c.contactPhone)) {
      if (
        !window.confirm(
          `No client has a contactPhone configured yet — the cron will run but nothing will send. Enable anyway?`,
        )
      ) {
        return
      }
    }
    if (next) {
      const ok = window.confirm(
        `Enable Client Alerts? This will SMS each client's contactPhone whenever a new appointment lands in the master sheet for them. On first-enable, every existing sheet row is marked 'already-handled' so historical bookings won't fire. Proceed?`,
      )
      if (!ok) return
    }
    updateMutation.mutate({ enabled: next })
  }

  function handleSaveSender() {
    const trimmed = senderDraft.trim()
    updateMutation.mutate({ senderPhone: trimmed.length > 0 ? trimmed : null })
  }

  return (
    <section className="rounded-2xl border border-zinc-200 bg-white p-6 shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
      <div className="flex items-start gap-3">
        <div className="rounded-lg bg-purple-50 p-2 dark:bg-purple-950">
          <PhoneIcon className="h-5 w-5 text-purple-600" />
        </div>
        <div className="flex-1">
          <h3 className="text-base font-semibold">Client Alerts (SMS)</h3>
          <p className="mt-1 text-sm text-zinc-500">
            Sends each client an SMS with the same details that go to
            their Slack channel, whenever a new appointment lands in
            the master sheet for them. Recipient is taken from each
            client&apos;s <code>contactPhone</code> — set on{' '}
            <a href="/clients" className="underline">/clients</a>. Cron
            ticks every 5 minutes; first-enable backfills historical
            rows as &quot;already-handled&quot; so existing bookings
            won&apos;t fire.
          </p>
        </div>
      </div>

      {configQuery.isError && (
        <div className="mt-4">
          <Alert variant="error">
            <div className="font-medium">Couldn&apos;t load config</div>
            <div className="mt-1 text-xs">
              {(configQuery.error as Error).message}
            </div>
          </Alert>
        </div>
      )}

      {/* Master toggle */}
      <div className="mt-5 flex items-center justify-between rounded-lg border border-zinc-200 bg-zinc-50 px-4 py-3 dark:border-zinc-800 dark:bg-zinc-950">
        <div>
          <p className="text-sm font-medium">Master enable</p>
          <p className="text-xs text-zinc-500">
            {enabled
              ? 'Cron is sending SMS to clients with a contactPhone configured.'
              : 'Off — cron logs the heartbeat but sends nothing.'}
          </p>
        </div>
        <button
          type="button"
          disabled={configQuery.isLoading || updateMutation.isPending}
          onClick={() => handleToggle(!enabled)}
          className={cn(
            'inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-semibold transition disabled:opacity-50',
            enabled
              ? 'bg-emerald-100 text-emerald-700 hover:bg-emerald-200 dark:bg-emerald-950 dark:text-emerald-300'
              : 'bg-zinc-200 text-zinc-700 hover:bg-zinc-300 dark:bg-zinc-800 dark:text-zinc-300',
          )}
        >
          {updateMutation.isPending ? (
            <Loader2 className="h-3 w-3 animate-spin" />
          ) : enabled ? (
            <>
              <CheckCircle2 className="h-3 w-3" />
              Enabled
            </>
          ) : (
            'Disabled'
          )}
        </button>
      </div>

      {/* Sender phone */}
      <div className="mt-4 rounded-lg border border-zinc-200 bg-zinc-50 px-4 py-3 dark:border-zinc-800 dark:bg-zinc-950">
        <label className="text-sm font-medium">
          Sender phone (optional)
        </label>
        <p className="mt-0.5 text-xs text-zinc-500">
          E.164 format (e.g. <code>+16038034828</code>). Leave blank to
          fall back to the GHL location&apos;s default. Make sure the
          number is provisioned on the GHL sub-account that the{' '}
          <code>{config?.vaultEntryName ?? 'GHL Genisys Token'}</code>{' '}
          vault entry points to.
        </p>
        <div className="mt-2 flex items-center gap-2">
          <input
            type="text"
            value={senderDraft}
            onChange={(e) => setSenderDraft(e.target.value)}
            placeholder="+16038034828"
            className="flex-1 rounded-md border border-zinc-200 bg-white px-3 py-1.5 text-sm focus:border-purple-500 focus:outline-none dark:border-zinc-700 dark:bg-zinc-900"
          />
          <button
            type="button"
            disabled={!senderDirty || updateMutation.isPending}
            onClick={handleSaveSender}
            className="rounded-md bg-purple-600 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-purple-700 disabled:opacity-50"
          >
            Save
          </button>
        </div>
      </div>

      {/* Direct-test send — fire a sample SMS to any number without
          needing to set up a client first. Useful for "make sure my
          GHL config actually works" smoke tests against your own
          phone before flipping the master toggle on. */}
      <DirectTestSendRow />

      {/* Per-client status + test buttons */}
      <div className="mt-5">
        <p className="mb-2 text-xs font-medium uppercase tracking-wide text-zinc-500">
          Per-client status
        </p>
        {clientsQuery.isLoading ? (
          <p className="text-sm text-zinc-500">Loading clients…</p>
        ) : clients.length === 0 ? (
          <p className="text-sm text-zinc-500">No active clients yet.</p>
        ) : (
          <div className="space-y-2">
            {clients.map((c) => (
              <ClientAlertRow key={c.id} client={c} />
            ))}
          </div>
        )}
      </div>
    </section>
  )
}

function DirectTestSendRow() {
  const [phoneDraft, setPhoneDraft] = useState('')
  const testMutation = useMutation({
    mutationFn: async (vars: {
      recipientPhone: string
    }): Promise<{
      ok: true
      clientName: string
      recipientPhone: string
      messageId: string | null
    }> => {
      const res = await fetch('/api/admin/client-alerts/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          recipientPhone: vars.recipientPhone,
          label: 'Test recipient',
        }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Test send failed')
      return data
    },
    onSuccess: (data) => {
      window.alert(
        `Test SMS sent to ${data.recipientPhone}${data.messageId ? ` (GHL messageId: ${data.messageId})` : ''}. Should arrive within ~30 seconds.`,
      )
    },
    onError: (err) => {
      window.alert(`Test SMS failed: ${(err as Error).message}`)
    },
  })

  return (
    <div className="mt-4 rounded-lg border border-purple-200 bg-purple-50/40 px-4 py-3 dark:border-purple-900/50 dark:bg-purple-950/20">
      <label className="text-sm font-medium">Test send to a specific number</label>
      <p className="mt-0.5 text-xs text-zinc-500">
        Fire a sample SMS to any phone using the current GHL config —
        useful for testing against your own number before any client
        is configured. Any common US format works
        (<code>(603) 803-4828</code>, <code>603-803-4828</code>, etc.).
      </p>
      <div className="mt-2 flex items-center gap-2">
        <input
          type="tel"
          value={phoneDraft}
          onChange={(e) => setPhoneDraft(e.target.value)}
          placeholder="(603) 803-4828"
          className="flex-1 rounded-md border border-zinc-200 bg-white px-3 py-1.5 text-sm focus:border-purple-500 focus:outline-none dark:border-zinc-700 dark:bg-zinc-900"
        />
        <button
          type="button"
          disabled={!phoneDraft.trim() || testMutation.isPending}
          onClick={() => {
            const trimmed = phoneDraft.trim()
            if (!trimmed) return
            if (
              window.confirm(
                `Send a test SMS to ${trimmed} from your GHL number? This will burn one message segment.`,
              )
            ) {
              testMutation.mutate({ recipientPhone: trimmed })
            }
          }}
          className="inline-flex items-center gap-1 rounded-md bg-purple-600 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-purple-700 disabled:opacity-50"
        >
          {testMutation.isPending ? (
            <Loader2 className="h-3 w-3 animate-spin" />
          ) : (
            <PhoneIcon className="h-3 w-3" />
          )}
          Send test
        </button>
      </div>
    </div>
  )
}

function ClientAlertRow({ client }: { client: ClientForRouting }) {
  const hasPhone = !!client.contactPhone?.trim()
  const testMutation = useMutation({
    mutationFn: async (): Promise<{
      ok: true
      clientName: string
      messageId: string | null
    }> => {
      const res = await fetch('/api/admin/client-alerts/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clientId: client.id }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Test send failed')
      return data
    },
    onSuccess: (data) => {
      window.alert(
        `Test SMS sent to ${data.clientName}${data.messageId ? ` (GHL messageId: ${data.messageId})` : ''}. Check the phone — should arrive within ~30 seconds.`,
      )
    },
    onError: (err) => {
      window.alert(`Test SMS failed: ${(err as Error).message}`)
    },
  })

  return (
    <div className="flex items-center justify-between rounded-md border border-zinc-200 bg-white px-3 py-2 dark:border-zinc-800 dark:bg-zinc-900">
      <div className="flex items-center gap-3">
        <span
          className="h-2.5 w-2.5 rounded-full"
          style={{ backgroundColor: client.color }}
          aria-hidden
        />
        <div>
          <p className="text-sm font-medium">{client.name}</p>
          {hasPhone ? (
            <p className="font-mono text-xs text-zinc-500">
              {client.contactPhone}
            </p>
          ) : (
            <p className="text-xs text-amber-600 dark:text-amber-400">
              No contactPhone — set in /clients to enable alerts
            </p>
          )}
        </div>
      </div>
      <button
        type="button"
        onClick={() => {
          if (
            window.confirm(
              `Send a test SMS to ${client.name} at ${client.contactPhone}?`,
            )
          ) {
            testMutation.mutate()
          }
        }}
        disabled={!hasPhone || testMutation.isPending}
        className="inline-flex items-center gap-1 rounded-md border border-zinc-200 px-2 py-1 text-[11px] font-medium text-zinc-600 transition hover:bg-zinc-50 disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
        title={
          hasPhone
            ? 'Send a sample SMS using the current Client Alerts config.'
            : 'Add a contactPhone for this client first.'
        }
      >
        {testMutation.isPending ? (
          <Loader2 className="h-3 w-3 animate-spin" />
        ) : (
          <PhoneIcon className="h-3 w-3" />
        )}
        Send test SMS
      </button>
    </div>
  )
}

function ClientRoutingRow({
  client,
  channels,
  channelsLoading,
  onSaved,
}: {
  client: ClientForRouting
  channels: SlackChannelOption[]
  channelsLoading: boolean
  onSaved: () => void
}) {
  const [draftId, setDraftId] = useState<string>(client.slackChannelId ?? '')
  // Whether the local draft differs from what's persisted on the
  // client record. Drives the Save button's enabled state without
  // forcing every render to do array work.
  const dirty = (client.slackChannelId ?? '') !== draftId

  // Pre-suggest a channel when none is set yet — best-effort
  // fuzzy-match the client name against the channel list. Eth's three
  // channels are exact-name matches (`spring-solar` etc.) so this
  // hits on first load and the admin just confirms with Save.
  const suggestion =
    !client.slackChannelId && channels.length > 0
      ? findBestChannelMatch(client.name, channels)
      : null

  const saveMutation = useMutation({
    mutationFn: async (payload: {
      slackChannelId: string | null
      slackChannelName: string | null
    }) => {
      const res = await fetch(`/api/clients/${client.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      })
      if (!res.ok) {
        const d = await res.json().catch(() => ({}))
        throw new Error(d.error || 'Save failed')
      }
      return res.json()
    },
    onSuccess: () => onSaved(),
  })

  const testMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch('/api/admin/slack-delivery/test', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          channelId: draftId,
          clientName: client.name,
        }),
      })
      if (!res.ok) {
        const d = await res.json().catch(() => ({}))
        throw new Error(d.error || 'Test post failed')
      }
      return res.json()
    },
  })

  const undoMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch('/api/admin/slack-delivery/undo', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ clientId: client.id, sinceHoursAgo: 24 }),
      })
      if (!res.ok) {
        const d = await res.json().catch(() => ({}))
        throw new Error(d.error || 'Undo failed')
      }
      return res.json() as Promise<{
        found: number
        deletedFromSlack: number
        ledgerUpdated: number
        errors: string[]
      }>
    },
  })

  function handleSave() {
    if (!draftId) {
      saveMutation.mutate({ slackChannelId: null, slackChannelName: null })
      return
    }
    const picked = channels.find((ch) => ch.id === draftId)
    saveMutation.mutate({
      slackChannelId: draftId,
      slackChannelName: picked?.name ?? null,
    })
  }

  function handleAcceptSuggestion() {
    if (suggestion) setDraftId(suggestion.id)
  }

  return (
    <div className="flex flex-wrap items-center gap-3 rounded-lg border border-zinc-200 px-3 py-2.5 dark:border-zinc-800">
      <span
        className="h-2.5 w-2.5 flex-shrink-0 rounded-full"
        style={{ backgroundColor: client.color }}
        aria-hidden
      />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium">{client.name}</span>
          {client.state && (
            <span className="text-[11px] text-zinc-500">{client.state}</span>
          )}
          {client.lifecycle !== 'active' && (
            <span
              className={cn(
                'rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider',
                client.lifecycle === 'paused' &&
                  'bg-amber-100 text-amber-700 dark:bg-amber-950/50 dark:text-amber-300',
                client.lifecycle === 'onboarding' &&
                  'bg-blue-100 text-blue-700 dark:bg-blue-950/50 dark:text-blue-300'
              )}
            >
              {client.lifecycle}
            </span>
          )}
        </div>
        {client.slackChannelId && client.slackChannelName && (
          <p className="mt-0.5 text-[11px] text-zinc-500">
            Currently routes to{' '}
            <span className="font-mono">#{client.slackChannelName}</span>
          </p>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <select
          value={draftId}
          onChange={(e) => setDraftId(e.target.value)}
          disabled={channelsLoading || channels.length === 0}
          className="rounded-md border border-zinc-200 bg-white px-2.5 py-1.5 text-sm focus:border-blue-500 focus:outline-none disabled:opacity-50 dark:border-zinc-700 dark:bg-zinc-900"
        >
          <option value="">— No delivery —</option>
          {channels.map((ch) => (
            <option key={ch.id} value={ch.id}>
              {ch.isPrivate ? '🔒 ' : '#'}
              {ch.name}
            </option>
          ))}
        </select>

        {suggestion && draftId === '' && (
          <button
            type="button"
            onClick={handleAcceptSuggestion}
            className="rounded-md border border-blue-200 bg-blue-50 px-2.5 py-1.5 text-xs font-medium text-blue-700 transition hover:bg-blue-100 dark:border-blue-900/50 dark:bg-blue-950/40 dark:text-blue-300"
            title={`We think this matches #${suggestion.name}`}
          >
            Use #{suggestion.name}
          </button>
        )}

        <button
          type="button"
          onClick={handleSave}
          disabled={!dirty || saveMutation.isPending}
          className={cn(
            'rounded-md px-3 py-1.5 text-xs font-semibold transition',
            dirty
              ? 'bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50'
              : 'border border-zinc-200 text-zinc-400 dark:border-zinc-700'
          )}
        >
          {saveMutation.isPending
            ? 'Saving…'
            : saveMutation.isSuccess && !dirty
              ? 'Saved ✓'
              : 'Save'}
        </button>

        <button
          type="button"
          onClick={() => testMutation.mutate()}
          disabled={
            !draftId ||
            dirty ||
            testMutation.isPending ||
            saveMutation.isPending
          }
          className="rounded-md border border-zinc-200 px-2.5 py-1.5 text-xs text-zinc-600 transition hover:bg-zinc-50 disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
          title={
            dirty
              ? 'Save your channel choice before sending a test post'
              : 'Send a sample appointment to this channel'
          }
        >
          Test post
        </button>

        {client.slackChannelId && (
          <button
            type="button"
            onClick={() => {
              if (
                window.confirm(
                  `Delete every appointment post the bot sent to #${client.slackChannelName} in the past 24 hours, and re-mark those rows so they don't re-post? This is meant to recover from a misconfiguration — it can't be undone.`
                )
              ) {
                undoMutation.mutate()
              }
            }}
            disabled={undoMutation.isPending}
            className="rounded-md border border-rose-200 px-2.5 py-1.5 text-xs text-rose-600 transition hover:bg-rose-50 disabled:opacity-50 dark:border-rose-900/50 dark:text-rose-300 dark:hover:bg-rose-950/40"
            title="Delete the last 24h of bot posts in this channel and re-mark those rows as backfilled"
          >
            {undoMutation.isPending ? 'Cleaning…' : 'Undo last 24h'}
          </button>
        )}
      </div>

      {saveMutation.isError && (
        <div className="basis-full text-xs text-red-600">
          Save failed: {(saveMutation.error as Error).message}
        </div>
      )}
      {testMutation.isError && (
        <div className="basis-full text-xs text-red-600">
          Test failed: {(testMutation.error as Error).message}
        </div>
      )}
      {testMutation.isSuccess && (
        <div className="basis-full text-xs text-emerald-600">
          Test post sent. Check the channel to confirm.
        </div>
      )}
      {undoMutation.isError && (
        <div className="basis-full text-xs text-red-600">
          Undo failed: {(undoMutation.error as Error).message}
        </div>
      )}
      {undoMutation.isSuccess && (
        <div className="basis-full text-xs text-emerald-600">
          Cleaned up {undoMutation.data.deletedFromSlack} of{' '}
          {undoMutation.data.found} recent posts. Future syncs will skip
          these rows.
        </div>
      )}
    </div>
  )
}

/**
 * Pick the channel whose name most closely resembles the client name.
 * Strips punctuation/whitespace from both sides and looks for either
 * an exact match (best) or substring containment (acceptable). Returns
 * null if no match is confident enough — better to leave the dropdown
 * empty than to pre-fill the wrong channel.
 */
function findBestChannelMatch(
  clientName: string,
  channels: SlackChannelOption[]
): SlackChannelOption | null {
  const normalize = (s: string) =>
    s.toLowerCase().replace(/[^a-z0-9]+/g, '')
  const target = normalize(clientName)
  if (!target) return null

  // Exact match wins.
  const exact = channels.find((ch) => normalize(ch.name) === target)
  if (exact) return exact

  // Substring match — channel name contains the client name (or vice
  // versa). Returns the longest-name match so "brighton-capital-solar"
  // wins over "brighton" if both exist.
  const candidates = channels.filter((ch) => {
    const n = normalize(ch.name)
    return n.includes(target) || target.includes(n)
  })
  if (candidates.length === 0) return null
  return candidates.reduce((a, b) =>
    a.name.length >= b.name.length ? a : b
  )
}

/* ------------------------------------------------------------------ */
/*  Solar API usage                                                    */
/*  Lightweight monthly counter so admins can spot runaway billing     */
/* ------------------------------------------------------------------ */

function SolarApiUsageSection() {
  const { data, isLoading } = useQuery<{
    calls: number
    cachedTotal: number
  }>({
    queryKey: ['solar-stats'],
    queryFn: async () => {
      const res = await fetch('/api/admin/solar/stats')
      if (!res.ok) throw new Error('failed')
      return res.json()
    },
    refetchInterval: 60_000,
  })

  // ~$0.10 / call is a conservative upper-bound for the
  // buildingInsights endpoint; actual price is tiered. We label the
  // estimate as "approx" so admins know it's a guideline, not an
  // invoice. Real billing lives in Google Cloud Console.
  const estCost = data ? data.calls * 0.1 : 0
  const monthLabel = new Date().toLocaleDateString('en-US', {
    month: 'long',
    year: 'numeric',
  })

  return (
    <section className="rounded-2xl border border-zinc-200 bg-white p-6 shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
      <div className="flex items-start gap-3">
        <div className="rounded-lg bg-amber-50 p-2 dark:bg-amber-950">
          <Sun className="h-5 w-5 text-amber-600" />
        </div>
        <div className="flex-1">
          <h3 className="text-base font-semibold">Solar API usage</h3>
          <p className="mt-1 text-sm text-zinc-500">
            Tracks Google Solar API calls (Project Sunroof) made from
            the booking form. Each unique address is a billable call;
            repeats hit local cache and cost zero.
          </p>
        </div>
      </div>

      {isLoading ? (
        <p className="mt-4 text-sm text-zinc-500">Loading…</p>
      ) : (
        <div className="mt-4 grid grid-cols-3 gap-3">
          <div className="rounded-lg border border-zinc-200 px-3 py-2 dark:border-zinc-800">
            <p className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500">
              Calls in {monthLabel}
            </p>
            <p className="mt-0.5 text-2xl font-bold tabular-nums">
              {data?.calls ?? 0}
            </p>
          </div>
          <div className="rounded-lg border border-zinc-200 px-3 py-2 dark:border-zinc-800">
            <p className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500">
              Approx cost
            </p>
            <p className="mt-0.5 text-2xl font-bold tabular-nums">
              ${estCost.toFixed(2)}
            </p>
            <p className="text-[10px] text-zinc-500">
              ~$0.10/call estimate
            </p>
          </div>
          <div className="rounded-lg border border-zinc-200 px-3 py-2 dark:border-zinc-800">
            <p className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500">
              Cached addresses
            </p>
            <p className="mt-0.5 text-2xl font-bold tabular-nums">
              {data?.cachedTotal ?? 0}
            </p>
            <p className="text-[10px] text-zinc-500">
              future re-checks free
            </p>
          </div>
        </div>
      )}

      <p className="mt-3 text-[11px] text-zinc-500">
        Set a Google Cloud{' '}
        <a
          href="https://console.cloud.google.com/billing"
          target="_blank"
          rel="noreferrer"
          className="underline underline-offset-2 hover:text-blue-600"
        >
          billing alert
        </a>{' '}
        for the authoritative spend cap. The numbers here are derived
        from the cache table — accurate for this Hub instance, but
        Google&apos;s console is the source of truth for charges.
      </p>
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

/**
 * Admin-only one-off migrations against the master appointments sheet.
 * Each migration is its own self-contained row with its own mutation +
 * result feedback so running one doesn't clobber another's status.
 */
function SheetMaintenanceSection() {
  return (
    <section className="rounded-xl border border-zinc-200 bg-white p-6 dark:border-zinc-800 dark:bg-zinc-900">
      <div className="flex items-center gap-3 mb-1">
        <FileSpreadsheet className="h-5 w-5 text-blue-600" />
        <h3 className="font-semibold">Sheet maintenance (admin)</h3>
      </div>
      <p className="text-sm text-zinc-500 mb-4">
        One-off migrations on the master appointments spreadsheet. Safe to
        re-run — each action skips tabs that are already up to date.
      </p>

      <div className="space-y-3">
        <SheetMigrationRow
          title='Add "Client" column to every tab'
          description="Appends a Client header to each tab so new bookings record which Genisys client (Brighton / Spring / Energy Upgrade) they're for. Existing rows keep a blank cell under it until edited."
          endpoint="/api/admin/sheets/migrate-client-column"
          columnLabel="Client"
        />
        <SheetMigrationRow
          title='Add "Agent Name" + "Agent Email" columns'
          description="Adds two columns so when call-center agents start booking through the Hub CRM, their name and email get preserved on the Master Table rollup. Without these the rollup writer drops the agent fields silently."
          endpoint="/api/admin/sheets/migrate-agent-columns"
          columnLabel="Agent"
        />
        <SheetMigrationRow
          title='Add "Sitdown" column (was "Sent to Client?")'
          description='Adds the column that powers the Yes / No / Unassigned select on Master Tracker — used by admin to mark whether the client actually met with the customer (qualified appointment). The internal sheet column header is still "Sent to Client?" for backward compatibility; the canonical alias also matches "Sitdown" so admin can rename the header without breaking the sync.'
          endpoint="/api/admin/sheets/migrate-sent-to-client-column"
          columnLabel="Sitdown"
        />
        <BackfillLoggedAtRow />
        <ReconcileMissingRow />
      </div>

      <AppsScriptSnippet />
    </section>
  )
}

/**
 * Reconcile the gap between the DB Appointment table and the master
 * sheet. Surfaces the count of DB rows missing from the sheet (the
 * source of the "/clients shows 25 booked but master tracker shows
 * 21" confusion) and lets admin one-click retry the sync for all of
 * them.
 */
function ReconcileMissingRow() {
  type MissingResponse = {
    counts: {
      total: number
      neverSynced: number
      syncFailed: number
      sheetRowMissing: number
    }
    sample: Array<{
      id: string
      customerName: string
      customerPhone: string
      apptDateTime: string
      clientName: string | null
      reason: 'never-synced' | 'sync-failed' | 'sheet-row-missing'
      syncError: string | null
    }>
  }
  const qc = useQueryClient()
  const lookup = useQuery<MissingResponse>({
    queryKey: ['sheets-missing-from-sheet'],
    queryFn: async () => {
      const res = await fetch('/api/admin/sheets/missing-from-sheet')
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Lookup failed')
      return data
    },
  })

  const reconcile = useMutation({
    mutationFn: async (): Promise<{
      ok: true
      attempted: number
      succeeded: number
      failed: number
      failures: { id: string; customerName: string; error: string }[]
    }> => {
      const res = await fetch('/api/admin/sheets/reconcile-missing', {
        method: 'POST',
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Reconcile failed')
      return data
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['sheets-missing-from-sheet'] })
      // /clients counts feed off the same data, so refresh those too
      // — the gap should close immediately for any rows that synced.
      qc.invalidateQueries({ queryKey: ['clients-with-counts'] })
    },
  })

  const counts = lookup.data?.counts
  const total = counts?.total ?? 0

  return (
    <div>
      <div className="flex items-start justify-between gap-4 rounded-md border border-zinc-200 p-4 dark:border-zinc-800">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 text-sm font-medium">
            <Wrench className="h-4 w-4 text-zinc-400" />
            Reconcile DB ↔ master sheet
          </div>
          <p className="mt-1 text-xs text-zinc-500">
            Finds Appointments in the database that don&apos;t have a
            matching row in the master sheet — sync failures, never-
            synced rows, and rows that were deleted from the sheet
            directly. Re-runs the sheet sync for each one. Source of
            truth for the &quot;/clients shows 25 booked but master
            tracker shows 21&quot; gap.
          </p>
          {lookup.isLoading ? (
            <p className="mt-2 text-xs text-zinc-500">Checking…</p>
          ) : lookup.isError ? (
            <p className="mt-2 text-xs text-rose-600">
              Couldn&apos;t check: {(lookup.error as Error).message}
            </p>
          ) : counts ? (
            total === 0 ? (
              <p className="mt-2 text-xs text-emerald-600 dark:text-emerald-400">
                ✓ No gap — every DB appointment has a matching sheet row.
              </p>
            ) : (
              <p className="mt-2 text-xs">
                <span className="font-semibold text-amber-600 dark:text-amber-400">
                  {total} DB row{total === 1 ? '' : 's'} missing from sheet
                </span>
                <span className="text-zinc-500">
                  {' '}
                  ({counts.neverSynced} never synced, {counts.syncFailed}{' '}
                  sync failed, {counts.sheetRowMissing} sheet row deleted)
                </span>
              </p>
            )
          ) : null}
        </div>
        <button
          type="button"
          onClick={() => reconcile.mutate()}
          disabled={reconcile.isPending || total === 0}
          className="inline-flex flex-shrink-0 items-center gap-1.5 rounded-md bg-blue-600 px-3 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
          title={
            total === 0
              ? 'Nothing to reconcile.'
              : `Retry the sheet sync for ${total} row${total === 1 ? '' : 's'}.`
          }
        >
          {reconcile.isPending
            ? 'Reconciling…'
            : total > 0
              ? `Reconcile ${total}`
              : 'Reconcile'}
        </button>
      </div>

      {/* Sample list — shows the first few missing rows so admin can
          eyeball what's about to be retried. Only renders when there's
          a gap. */}
      {!lookup.isLoading && counts && counts.total > 0 && lookup.data && (
        <div className="mt-2 rounded-md border border-zinc-200 bg-zinc-50 px-4 py-3 text-xs dark:border-zinc-800 dark:bg-zinc-950">
          <p className="mb-2 font-medium text-zinc-600 dark:text-zinc-400">
            Sample (first {Math.min(lookup.data.sample.length, 25)} of {counts.total}):
          </p>
          <div className="space-y-1">
            {lookup.data.sample.map((m) => (
              <div
                key={m.id}
                className="flex items-center justify-between gap-3"
              >
                <div className="min-w-0 flex-1">
                  <span className="font-medium">{m.customerName}</span>
                  {m.clientName && (
                    <span className="text-zinc-500"> · {m.clientName}</span>
                  )}
                  <span className="text-zinc-500">
                    {' · '}
                    {new Date(m.apptDateTime).toLocaleString('en-US')}
                  </span>
                </div>
                <span
                  className={cn(
                    'rounded-full px-2 py-0.5 text-[10px] font-semibold',
                    m.reason === 'sync-failed' &&
                      'bg-rose-100 text-rose-700 dark:bg-rose-950 dark:text-rose-300',
                    m.reason === 'never-synced' &&
                      'bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300',
                    m.reason === 'sheet-row-missing' &&
                      'bg-zinc-200 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300',
                  )}
                  title={m.syncError ?? undefined}
                >
                  {m.reason}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {reconcile.isSuccess && (
        <Alert
          variant={reconcile.data.failed === 0 ? 'success' : 'error'}
        >
          <div className="font-medium">
            Reconcile complete — <code>{reconcile.data.succeeded}</code> of{' '}
            <code>{reconcile.data.attempted}</code> succeeded
            {reconcile.data.failed > 0 && (
              <>
                , <code>{reconcile.data.failed}</code> still failing
              </>
            )}
            .
          </div>
          {reconcile.data.failures.length > 0 && (
            <div className="mt-1 space-y-0.5 text-xs">
              {reconcile.data.failures.slice(0, 5).map((f) => (
                <div key={f.id}>
                  {f.customerName}:{' '}
                  <span className="text-rose-600">{f.error}</span>
                </div>
              ))}
              {reconcile.data.failures.length > 5 && (
                <div className="text-zinc-500">
                  …{reconcile.data.failures.length - 5} more (check Render
                  logs for the rest)
                </div>
              )}
            </div>
          )}
        </Alert>
      )}
    </div>
  )
}

/**
 * Backfill row — separate from SheetMigrationRow because the result
 * shape is different (per-tab row counts, no header-style stuff).
 */
function BackfillLoggedAtRow() {
  const mutation = useMutation({
    mutationFn: async () => {
      const res = await fetch('/api/admin/sheets/backfill-logged-at', {
        method: 'POST',
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Backfill failed')
      return data as {
        ok: true
        spreadsheetId: string
        tabsBackfilled: Array<{ tab: string; rowsStamped: number }>
        tabsSkipped: Array<{ tab: string; reason: string }>
        stamp: string
      }
    },
  })

  const totalStamped =
    mutation.data?.tabsBackfilled.reduce((s, t) => s + t.rowsStamped, 0) ?? 0

  return (
    <div>
      <div className="flex items-start justify-between gap-4 rounded-md border border-zinc-200 p-4 dark:border-zinc-800">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 text-sm font-medium">
            <Wrench className="h-4 w-4 text-zinc-400" />
            Backfill blank &quot;Logged At&quot; cells
          </div>
          <p className="mt-1 text-xs text-zinc-500">
            Stamps every row that has a customer name but no Logged At
            value with the current timestamp. Only touches blank cells —
            existing values stay put. Honest caveat: the stamp is the
            time of the backfill, not the (unknowable) original time
            the row was added. Use the Apps Script below to auto-stamp
            future manual entries the moment they&apos;re typed.
          </p>
        </div>
        <button
          type="button"
          onClick={() => mutation.mutate()}
          disabled={mutation.isPending}
          className="inline-flex flex-shrink-0 items-center gap-1.5 rounded-md bg-blue-600 px-3 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
        >
          {mutation.isPending ? 'Running…' : 'Run'}
        </button>
      </div>

      {mutation.isSuccess && (
        <Alert variant="success">
          <div className="font-medium">
            Backfill complete — stamped <code>{totalStamped}</code> row
            {totalStamped === 1 ? '' : 's'} with{' '}
            <code className="text-xs">{mutation.data.stamp}</code>.
          </div>
          <div className="text-xs mt-1 space-y-0.5">
            {mutation.data.tabsBackfilled
              .filter((t) => t.rowsStamped > 0)
              .map((t) => (
                <div key={t.tab}>
                  {t.tab}: <code>{t.rowsStamped}</code> stamped
                </div>
              ))}
            {mutation.data.tabsSkipped.length > 0 && (
              <div className="mt-1 text-zinc-500">
                Skipped: {mutation.data.tabsSkipped
                  .map((s) => `${s.tab} (${s.reason})`)
                  .join(', ')}
              </div>
            )}
          </div>
        </Alert>
      )}

      {mutation.isError && (
        <Alert variant="error">
          <div className="font-medium">Backfill failed</div>
          <div className="text-xs mt-1">{(mutation.error as Error).message}</div>
        </Alert>
      )}
    </div>
  )
}

/**
 * One-time setup snippet for the call center — paste this Apps
 * Script into the master spreadsheet (Extensions → Apps Script) and
 * every manual row addition / edit auto-stamps the Logged At column
 * the moment the customer name lands. After this is installed, the
 * backfill button above is only needed for legacy rows.
 */
function AppsScriptSnippet() {
  const [copied, setCopied] = useState(false)
  const SCRIPT = `/**
 * Auto-stamp "Logged At" on the master appointments sheet whenever
 * a row gets a Customer Name typed in. Idempotent: only stamps if
 * Logged At is currently blank, so editing other cells later
 * doesn't overwrite the original timestamp.
 *
 * Setup:
 *   1. In the master spreadsheet, open Extensions → Apps Script.
 *   2. Replace the contents of Code.gs with this whole block.
 *   3. Save (disk icon). The trigger registers automatically.
 *   4. (First save only) authorize the script when prompted.
 */
function onEdit(e) {
  if (!e || !e.range) return;
  var sheet = e.range.getSheet();
  var headerRow = 1;
  var headers = sheet.getRange(headerRow, 1, 1, sheet.getLastColumn())
    .getValues()[0]
    .map(function (h) { return String(h || '').toLowerCase().replace(/[^a-z0-9]/g, ''); });
  var customerNameCol = -1;
  var loggedAtCol = -1;
  headers.forEach(function (h, i) {
    if (h === 'customername' || h === 'customer' || h === 'name') customerNameCol = i + 1;
    if (h === 'loggedat' || h === 'logged' || h === 'timestamp' || h === 'createdat') loggedAtCol = i + 1;
  });
  if (customerNameCol < 0 || loggedAtCol < 0) return;
  // Stamp the row that was just edited (could be any cell on that row).
  var row = e.range.getRow();
  if (row <= headerRow) return;
  var customerName = sheet.getRange(row, customerNameCol).getValue();
  if (!customerName || String(customerName).trim() === '') return;
  var loggedCell = sheet.getRange(row, loggedAtCol);
  if (loggedCell.getValue()) return; // already stamped — leave alone
  loggedCell.setValue(new Date());
  loggedCell.setNumberFormat('M/d/yyyy h:mm:ss am/pm');
}`

  function copyScript() {
    navigator.clipboard.writeText(SCRIPT).then(
      () => {
        setCopied(true)
        setTimeout(() => setCopied(false), 2000)
      },
      () => {
        // ignore — clipboard API failure is rare and the textarea
        // is selectable for manual copy as a fallback.
      }
    )
  }

  return (
    <details className="mt-4 rounded-md border border-zinc-200 p-4 dark:border-zinc-800">
      <summary className="cursor-pointer text-sm font-medium">
        Auto-stamp Logged At for manual sheet entries (Apps Script)
      </summary>
      <p className="mt-2 text-xs text-zinc-500">
        Paste this into <em>Extensions → Apps Script</em> on the master
        spreadsheet. After saving + authorizing once, every row the call
        center types will get a Logged At timestamp the moment the
        customer name is entered. Idempotent — never overwrites an
        existing value.
      </p>
      <div className="mt-3 flex items-start gap-2">
        <textarea
          readOnly
          value={SCRIPT}
          className="flex-1 h-48 rounded-md border border-zinc-200 bg-zinc-50 p-3 font-mono text-[11px] dark:border-zinc-800 dark:bg-zinc-950"
          onClick={(e) => (e.currentTarget as HTMLTextAreaElement).select()}
        />
        <button
          type="button"
          onClick={copyScript}
          className="inline-flex flex-shrink-0 items-center gap-1.5 rounded-md border border-zinc-200 bg-white px-3 py-2 text-xs font-medium hover:bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-900 dark:hover:bg-zinc-800"
        >
          {copied ? 'Copied!' : 'Copy'}
        </button>
      </div>
    </details>
  )
}

type SheetMigrationResult = {
  ok: true
  spreadsheetId: string
  tabsUpdated: string[]
  tabsAlreadyHad: string[]
  tabsNoHeader: string[]
  tablesExtended: string[]
  headersStyled: string[]
}

/**
 * One row in the Sheet Maintenance card: a labeled "Run" button paired
 * with its own success/error feedback. Each instance owns its own
 * mutation hook so adjacent rows don't share status.
 */
function SheetMigrationRow({
  title,
  description,
  endpoint,
  columnLabel,
}: {
  title: string
  description: string
  endpoint: string
  /** Used in the success message ("Tables extended to include {columnLabel}"). */
  columnLabel: string
}) {
  const mutation = useMutation({
    mutationFn: async () => {
      const res = await fetch(endpoint, { method: 'POST' })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Migration failed')
      return data as SheetMigrationResult
    },
  })

  return (
    <div>
      <div className="flex items-start justify-between gap-4 rounded-md border border-zinc-200 p-4 dark:border-zinc-800">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 text-sm font-medium">
            <Wrench className="h-4 w-4 text-zinc-400" />
            {title}
          </div>
          <p className="mt-1 text-xs text-zinc-500">{description}</p>
        </div>
        <button
          type="button"
          onClick={() => mutation.mutate()}
          disabled={mutation.isPending}
          className="inline-flex flex-shrink-0 items-center gap-1.5 rounded-md bg-blue-600 px-3 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
        >
          {mutation.isPending ? 'Running…' : 'Run'}
        </button>
      </div>

      {mutation.isSuccess && (
        <Alert variant="success">
          <div className="font-medium">Migration complete.</div>
          <div className="text-xs mt-1 space-y-0.5">
            <div>
              Headers added on:{' '}
              <code className="text-xs">{mutation.data.tabsUpdated.length}</code>
              {mutation.data.tabsUpdated.length > 0 &&
                ` (${mutation.data.tabsUpdated.join(', ')})`}
            </div>
            <div>
              Already had the column(s):{' '}
              <code className="text-xs">{mutation.data.tabsAlreadyHad.length}</code>
            </div>
            <div>
              Tables extended to include {columnLabel}:{' '}
              <code className="text-xs">{mutation.data.tablesExtended.length}</code>
              {mutation.data.tablesExtended.length > 0 &&
                ` (${mutation.data.tablesExtended.join(', ')})`}
            </div>
            <div>
              Headers styled to match neighbors:{' '}
              <code className="text-xs">{mutation.data.headersStyled.length}</code>
              {mutation.data.headersStyled.length > 0 &&
                ` (${mutation.data.headersStyled.join(', ')})`}
            </div>
            <div>
              Skipped (no header row detected):{' '}
              <code className="text-xs">{mutation.data.tabsNoHeader.length}</code>
            </div>
          </div>
        </Alert>
      )}

      {mutation.isError && (
        <Alert variant="error">
          <div className="font-medium">Migration failed</div>
          <div className="text-xs mt-1">{(mutation.error as Error).message}</div>
        </Alert>
      )}
    </div>
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

/** Compact timezone label (e.g. "ET", "PT") for the schedule row. */
function shortTz(tz: string): string {
  const map: Record<string, string> = {
    'America/New_York': 'ET',
    'America/Chicago': 'CT',
    'America/Denver': 'MT',
    'America/Phoenix': 'MST',
    'America/Los_Angeles': 'PT',
    'America/Anchorage': 'AKT',
    'Pacific/Honolulu': 'HT',
    UTC: 'UTC',
  }
  return map[tz] || tz
}

// ============================================================================
// Appointment SMS reminders — master toggle, per-client templates,
// recent log. The data + cron live in lib/reminders.ts; this section
// is just the admin-facing surface to configure + observe it.
// ============================================================================

type ReminderConfig = {
  enabled: boolean
  vaultEntryName: string
  lookaheadDays: number
  quietHoursStart: string
  quietHoursEnd: string
  senderPhone: string | null
  confirmationEnabled: boolean
  updatedAt: string
}

type TemplateCell = {
  type: ReminderType
  body: string
  enabled: boolean
  source: 'client' | 'global' | 'default'
}

type TemplateRow = {
  clientId: string | null
  clientName: string
  color: string
  state: string | null
  cells: TemplateCell[]
}

type ReminderLogEntry = {
  id: string
  reminderType: string
  scheduledFor: string
  status: string
  sentAt: string | null
  errorMessage: string | null
  customerName: string
  customerPhone: string
  apptDateTime: string
  clientName: string | null
  client: { id: string; name: string; color: string } | null
  messageBody: string | null
}

function AppointmentRemindersSection() {
  const qc = useQueryClient()
  const configQuery = useQuery<{ config: ReminderConfig }>({
    queryKey: ['reminders-config'],
    queryFn: async () => {
      const res = await fetch('/api/admin/reminders/config')
      if (!res.ok) throw new Error('Failed to load config')
      return res.json()
    },
  })
  const config = configQuery.data?.config

  const updateConfig = useMutation({
    mutationFn: async (patch: Partial<ReminderConfig>) => {
      const res = await fetch('/api/admin/reminders/config', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(patch),
      })
      if (!res.ok) throw new Error('Failed to save')
      return res.json()
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['reminders-config'] }),
  })

  const syncMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch('/api/admin/reminders/sync', { method: 'POST' })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Sync failed')
      return data as {
        ok: true
        scanned: number
        upserted: number
        skippedPast: number
        cancelled: number
      }
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['reminders-log'] }),
  })

  return (
    <section className="rounded-xl border border-zinc-200 bg-white p-6 dark:border-zinc-800 dark:bg-zinc-900">
      <div className="mb-1 flex items-center gap-3">
        <MessagesSquare className="h-5 w-5 text-blue-600" />
        <h3 className="font-semibold">Appointment SMS reminders</h3>
        {config?.enabled && (
          <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300">
            Live
          </span>
        )}
      </div>
      <p className="mb-4 text-sm text-zinc-500">
        SMS reminders to customers a day before, 2 hours before, 30 minutes
        before, and at the start of every booked appointment. Pulls from the
        master tracker sheet so manual entries get reminders too. Past
        appointments are guarded — anything already-passed is marked
        &ldquo;skipped&rdquo; and never fires.
      </p>

      {/* Master toggle */}
      <div className="flex items-start justify-between gap-4 rounded-md border border-zinc-200 p-4 dark:border-zinc-800">
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium">
            {config?.enabled ? 'Reminders are sending' : 'Reminders are paused'}
          </p>
          <p className="mt-1 text-xs text-zinc-500">
            Master switch — when off, the cron sync still keeps reminder rows
            up to date, but nothing actually fires. Flip on once you&apos;ve
            confirmed templates look right.
          </p>
        </div>
        <button
          type="button"
          onClick={() => updateConfig.mutate({ enabled: !config?.enabled })}
          disabled={updateConfig.isPending || !config}
          className={cn(
            'inline-flex flex-shrink-0 items-center gap-1.5 rounded-md px-3 py-2 text-sm font-medium disabled:opacity-50',
            config?.enabled
              ? 'bg-rose-600 text-white hover:bg-rose-700'
              : 'bg-emerald-600 text-white hover:bg-emerald-700'
          )}
        >
          {config?.enabled ? (
            <>
              <Pause className="h-3.5 w-3.5" /> Pause
            </>
          ) : (
            <>
              <Play className="h-3.5 w-3.5" /> Enable
            </>
          )}
        </button>
      </div>

      {/* Vault key + lookahead window */}
      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <div>
          <label className="mb-1 block text-xs font-medium">
            GHL vault entry
          </label>
          <input
            type="text"
            defaultValue={config?.vaultEntryName ?? 'GHL Genisys Token'}
            onBlur={(e) => {
              const v = e.target.value.trim()
              if (v && v !== config?.vaultEntryName) {
                updateConfig.mutate({ vaultEntryName: v })
              }
            }}
            className="w-full rounded-md border border-zinc-200 px-3 py-2 text-sm dark:border-zinc-800 dark:bg-zinc-950"
          />
          <p className="mt-1 text-[11px] text-zinc-500">
            Vault entry name holding the GHL Private Integration JWT
            (must include the location id).
          </p>
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium">
            Lookahead days
          </label>
          <input
            type="number"
            min={1}
            max={60}
            defaultValue={config?.lookaheadDays ?? 10}
            onBlur={(e) => {
              const n = parseInt(e.target.value, 10)
              if (Number.isFinite(n) && n > 0 && n !== config?.lookaheadDays) {
                updateConfig.mutate({ lookaheadDays: n })
              }
            }}
            className="w-full rounded-md border border-zinc-200 px-3 py-2 text-sm dark:border-zinc-800 dark:bg-zinc-950"
          />
          <p className="mt-1 text-[11px] text-zinc-500">
            How far ahead to schedule reminders. Re-evaluated on each
            5-minute sync.
          </p>
        </div>
      </div>

      {/* Booking confirmation toggle — separate enable from the
          rest of the reminder cascade because the operational
          impact is different (fires on every new appointment, not
          on a schedule). Backfill on first-enable is server-side
          so admins don't have to think about retroactive blasts. */}
      <div className="mt-3 rounded-lg border border-zinc-200 bg-white p-3 dark:border-zinc-800 dark:bg-zinc-950">
        <div className="flex items-start justify-between gap-3">
          <div className="flex-1">
            <p className="text-xs font-semibold">
              Booking confirmation SMS
            </p>
            <p className="mt-1 text-[11px] text-zinc-500">
              Fires once, right after a booking lands on the master
              sheet (whether typed manually or saved through the Hub
              form). Lands within ~1 minute of the row syncing.
              Edit the copy under the &ldquo;Booking confirmation&rdquo; column
              of the templates editor below.
            </p>
            {config?.confirmationEnabled && (
              <p className="mt-1 text-[11px] text-emerald-600">
                ✓ Active. New appointments will get the confirmation text.
              </p>
            )}
          </div>
          <button
            type="button"
            onClick={() => {
              const next = !config?.confirmationEnabled
              if (
                next &&
                !window.confirm(
                  'Turn on booking confirmations? Existing appointments will be marked skipped automatically — only new bookings going forward will get the text. This is the right move for a clean rollout.',
                )
              ) {
                return
              }
              updateConfig.mutate({ confirmationEnabled: next })
            }}
            className={cn(
              'inline-flex flex-shrink-0 items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-semibold transition',
              config?.confirmationEnabled
                ? 'bg-emerald-100 text-emerald-700 hover:bg-emerald-200 dark:bg-emerald-950 dark:text-emerald-300'
                : 'border border-zinc-200 text-zinc-600 hover:bg-zinc-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800',
            )}
            disabled={updateConfig.isPending}
          >
            {config?.confirmationEnabled ? 'Enabled' : 'Enable'}
          </button>
        </div>
      </div>

      {/* Outbound sender phone — applies to BOTH reminder SMS and
          morning brief SMS so the agency's dedicated line is used
          everywhere. Leave blank to fall back to the GHL location's
          default phone number. */}
      <div className="mt-3">
        <label className="mb-1 block text-xs font-medium">
          Outbound sender phone
        </label>
        <input
          type="tel"
          placeholder="+1 (603) 803-4828"
          defaultValue={config?.senderPhone ?? ''}
          onBlur={(e) => {
            const v = e.target.value.trim()
            // Empty clears (falls back to GHL default); non-empty
            // updates. Skip the call when nothing changed.
            const current = config?.senderPhone ?? ''
            if (v !== current) {
              updateConfig.mutate({ senderPhone: v || null })
            }
          }}
          className="w-full rounded-md border border-zinc-200 px-3 py-2 text-sm dark:border-zinc-800 dark:bg-zinc-950"
        />
        <p className="mt-1 text-[11px] text-zinc-500">
          E.164 phone number SMS reminders + morning briefs are sent
          from. Must already be loaded in your GHL sub-account.
          Leave blank to use GHL&apos;s default location number.
        </p>
      </div>

      {/* Quiet hours — TCPA compliance window. Sends outside the
          window are deferred until the next allowed minute. */}
      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <div>
          <label className="mb-1 block text-xs font-medium">
            Quiet hours start
          </label>
          <input
            type="time"
            defaultValue={config?.quietHoursStart ?? '21:00'}
            onBlur={(e) => {
              const v = e.target.value
              if (v && v !== config?.quietHoursStart) {
                updateConfig.mutate({ quietHoursStart: v })
              }
            }}
            className="w-full rounded-md border border-zinc-200 px-3 py-2 text-sm dark:border-zinc-800 dark:bg-zinc-950"
          />
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium">
            Quiet hours end
          </label>
          <input
            type="time"
            defaultValue={config?.quietHoursEnd ?? '08:00'}
            onBlur={(e) => {
              const v = e.target.value
              if (v && v !== config?.quietHoursEnd) {
                updateConfig.mutate({ quietHoursEnd: v })
              }
            }}
            className="w-full rounded-md border border-zinc-200 px-3 py-2 text-sm dark:border-zinc-800 dark:bg-zinc-950"
          />
        </div>
      </div>
      <p className="mt-1 text-[11px] text-zinc-500">
        TCPA compliance window — sends outside <code>{config?.quietHoursEnd}–
        {config?.quietHoursStart}</code> in the customer&apos;s local
        timezone are deferred until the window opens. Defaults
        align with the TCPA-allowed 8 AM–9 PM band.
      </p>

      {/* Manual sync */}
      <div className="mt-3 flex items-center justify-between rounded-md border border-zinc-200 p-4 dark:border-zinc-800">
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium">Sync from sheet now</p>
          <p className="mt-1 text-xs text-zinc-500">
            Re-reads every row of the master tracker sheet and rebuilds
            the reminder queue. Idempotent — safe to run any time. The
            cron does this every 5 minutes automatically.
          </p>
        </div>
        <button
          type="button"
          onClick={() => syncMutation.mutate()}
          disabled={syncMutation.isPending}
          className="inline-flex flex-shrink-0 items-center gap-1.5 rounded-md bg-blue-600 px-3 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
        >
          <RefreshCw
            className={cn(
              'h-3.5 w-3.5',
              syncMutation.isPending && 'animate-spin'
            )}
          />
          {syncMutation.isPending ? 'Syncing…' : 'Sync now'}
        </button>
      </div>
      {syncMutation.isSuccess && (
        <Alert variant="success">
          <div className="font-medium">
            Synced {syncMutation.data.scanned} appointment
            {syncMutation.data.scanned === 1 ? '' : 's'}.
          </div>
          <div className="mt-1 text-xs">
            New: <code>{syncMutation.data.upserted}</code> · Past
            (skipped): <code>{syncMutation.data.skippedPast}</code> ·
            Cancelled: <code>{syncMutation.data.cancelled}</code>
          </div>
        </Alert>
      )}
      {syncMutation.isError && (
        <Alert variant="error">
          <div className="font-medium">Sync failed</div>
          <div className="mt-1 text-xs">
            {(syncMutation.error as Error).message}
          </div>
        </Alert>
      )}

      {/* Test send — fires a one-off SMS using the template machinery
          so admins can verify GHL config + preview rendered copy
          before flipping the master enable on. */}
      <ReminderTestSendBlock />

      {/* Templates editor */}
      <div className="mt-6">
        <h4 className="mb-1 text-sm font-semibold">Message templates</h4>
        <p className="mb-3 text-xs text-zinc-500">
          Click any variable chip below the editor to insert it at
          the cursor. The live preview shows what the customer will
          actually see. Cells marked{' '}
          <span className="font-mono text-[11px]">default</span> are
          using the built-in fallback — saving any edit creates a
          per-client (or global) override.
        </p>
        <ReminderTemplatesGrid />
      </div>

      {/* Recent log */}
      <div className="mt-6">
        <h4 className="mb-2 text-sm font-semibold">Recent reminders</h4>
        <ReminderRecentLog />
      </div>
    </section>
  )
}

function ReminderTemplatesGrid() {
  const qc = useQueryClient()
  const query = useQuery<{ rows: TemplateRow[] }>({
    queryKey: ['reminders-templates'],
    queryFn: async () => {
      const res = await fetch('/api/admin/reminders/templates')
      if (!res.ok) throw new Error('Failed to load templates')
      return res.json()
    },
  })

  const saveMutation = useMutation({
    mutationFn: async (patch: {
      clientId: string | null
      reminderType: ReminderType
      body: string
      enabled: boolean
    }) => {
      const res = await fetch('/api/admin/reminders/templates', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(patch),
      })
      if (!res.ok) throw new Error('Save failed')
      return res.json()
    },
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: ['reminders-templates'] }),
  })

  const resetMutation = useMutation({
    mutationFn: async (params: {
      clientId: string | null
      reminderType: ReminderType
    }) => {
      const sp = new URLSearchParams()
      if (params.clientId) sp.set('clientId', params.clientId)
      sp.set('reminderType', params.reminderType)
      const res = await fetch(`/api/admin/reminders/templates?${sp}`, {
        method: 'DELETE',
      })
      if (!res.ok) throw new Error('Reset failed')
      return res.json()
    },
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: ['reminders-templates'] }),
  })

  if (query.isLoading)
    return <p className="text-xs text-zinc-500">Loading templates…</p>
  if (query.isError)
    return <p className="text-xs text-rose-600">Couldn&apos;t load templates.</p>
  if (!query.data) return null

  return (
    <div className="space-y-4">
      {query.data.rows.map((row) => (
        <details
          key={row.clientId ?? 'global'}
          open={row.clientId === null}
          className="rounded-md border border-zinc-200 dark:border-zinc-800"
        >
          <summary className="flex cursor-pointer items-center gap-2 px-3 py-2 text-sm font-medium">
            <span
              className="h-2.5 w-2.5 rounded-full"
              style={{ backgroundColor: row.color }}
              aria-hidden
            />
            {row.clientName}
            {row.state && (
              <span className="text-xs font-normal text-zinc-500">
                · {row.state}
              </span>
            )}
          </summary>
          <div className="space-y-3 border-t border-zinc-200 p-3 dark:border-zinc-800">
            {row.cells.map((cell) => (
              <TemplateCellEditor
                key={`${row.clientId ?? 'g'}:${cell.type}`}
                clientId={row.clientId}
                cell={cell}
                onSave={(body, enabled) =>
                  saveMutation.mutate({
                    clientId: row.clientId,
                    reminderType: cell.type,
                    body,
                    enabled,
                  })
                }
                onReset={() =>
                  resetMutation.mutate({
                    clientId: row.clientId,
                    reminderType: cell.type,
                  })
                }
              />
            ))}
          </div>
        </details>
      ))}
    </div>
  )
}

function TemplateCellEditor({
  cell,
  onSave,
  onReset,
}: {
  clientId: string | null
  cell: TemplateCell
  onSave: (body: string, enabled: boolean) => void
  onReset: () => void
}) {
  const [body, setBody] = useState(cell.body)
  const [enabled, setEnabled] = useState(cell.enabled)
  const [dirty, setDirty] = useState(false)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  // Re-sync local draft when the upstream changes (e.g. after the
  // reset round-trip clears the override).
  useEffect(() => {
    setBody(cell.body)
    setEnabled(cell.enabled)
    setDirty(false)
  }, [cell.body, cell.enabled])

  function update(next: { body?: string; enabled?: boolean }) {
    if (next.body !== undefined) setBody(next.body)
    if (next.enabled !== undefined) setEnabled(next.enabled)
    setDirty(true)
  }

  /**
   * Insert a `{placeholder}` at the current cursor position. If the
   * textarea isn't focused (e.g. user just clicked a chip without
   * touching the textarea first), fall back to appending. After
   * insertion we restore focus + place the caret immediately after
   * the inserted variable so admins can keep typing without losing
   * their place.
   */
  function insertVariable(placeholder: string) {
    const ta = textareaRef.current
    if (!ta) {
      update({ body: body + placeholder })
      return
    }
    const start = ta.selectionStart
    const end = ta.selectionEnd
    const next = body.slice(0, start) + placeholder + body.slice(end)
    update({ body: next })
    requestAnimationFrame(() => {
      ta.focus()
      const cursor = start + placeholder.length
      ta.setSelectionRange(cursor, cursor)
    })
  }

  // Detect any `{xyz}` token in the body whose key isn't in our
  // allow-list — typo guard. The dispatcher passes unknown keys
  // through verbatim (so the customer would literally see
  // "{customername}"), which we want admins to catch BEFORE save.
  const unknownVariables = Array.from(
    new Set(
      Array.from(body.matchAll(/\{(\w+)\}/g))
        .map((m) => m[1])
        .filter((key) => !VALID_PLACEHOLDER_KEYS.has(key))
    )
  )

  // Active variables — used to highlight chips that the body
  // currently uses, so admins see at a glance "I've referenced
  // these three" without scanning the textarea.
  const activeVariableKeys = new Set(
    Array.from(body.matchAll(/\{(\w+)\}/g)).map((m) => m[1])
  )

  return (
    <div className="rounded-md border border-zinc-100 p-3 dark:border-zinc-800">
      <div className="mb-1.5 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-xs font-semibold uppercase tracking-wider">
            {REMINDER_LABELS[cell.type]}
          </span>
          <span
            className={cn(
              'rounded-full px-1.5 py-0.5 text-[9px] font-bold uppercase',
              cell.source === 'client' &&
                'bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-300',
              cell.source === 'global' &&
                'bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300',
              cell.source === 'default' &&
                'bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400'
            )}
          >
            {cell.source}
          </span>
        </div>
        <label className="flex items-center gap-1.5 text-xs">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(e) => update({ enabled: e.target.checked })}
            className="h-3.5 w-3.5"
          />
          Enabled
        </label>
      </div>

      <textarea
        ref={textareaRef}
        value={body}
        onChange={(e) => update({ body: e.target.value })}
        rows={3}
        className="w-full resize-y rounded-md border border-zinc-200 px-3 py-2 text-xs font-mono dark:border-zinc-800 dark:bg-zinc-950"
      />
      <SmsLengthHint body={body} />

      {/* Click-to-insert variable chips. Active chips (already
          referenced in the body) get a blue tint so the admin sees
          which variables the template currently uses. */}
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        <span className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500">
          Insert:
        </span>
        {TEMPLATE_VARIABLES.map((v) => {
          const active = activeVariableKeys.has(v.key)
          return (
            <button
              key={v.key}
              type="button"
              onClick={() => insertVariable(v.placeholder)}
              title={`${v.description}\n\nExample: "${v.sample}"`}
              className={cn(
                'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-medium transition',
                active
                  ? 'border-blue-300 bg-blue-50 text-blue-700 dark:border-blue-900 dark:bg-blue-950/40 dark:text-blue-300'
                  : 'border-zinc-200 bg-white text-zinc-600 hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300 dark:hover:bg-zinc-800'
              )}
            >
              <Plus className="h-2.5 w-2.5" />
              {v.label}
            </button>
          )
        })}
      </div>

      {unknownVariables.length > 0 && (
        <div className="mt-2 rounded-md border border-rose-200 bg-rose-50 px-2.5 py-1.5 text-[11px] text-rose-700 dark:border-rose-900 dark:bg-rose-950/40 dark:text-rose-300">
          <strong>Unknown variable{unknownVariables.length === 1 ? '' : 's'}:</strong>{' '}
          {unknownVariables.map((k, i) => (
            <span key={k}>
              <code className="font-mono">{`{${k}}`}</code>
              {i < unknownVariables.length - 1 ? ', ' : ''}
            </span>
          ))}{' '}
          — these will appear literally in the SMS. Pick a chip above
          or fix the typo.
        </div>
      )}

      <TemplatePreview body={body} />

      <div className="mt-2 flex items-center justify-end gap-2">
        {cell.source !== 'default' && (
          <button
            type="button"
            onClick={onReset}
            className="rounded-md px-2.5 py-1 text-[11px] font-medium text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800"
            title="Remove this override and fall back to the next layer"
          >
            Reset
          </button>
        )}
        <button
          type="button"
          onClick={() => {
            onSave(body, enabled)
            setDirty(false)
          }}
          disabled={!dirty || !body.trim()}
          className="rounded-md bg-blue-600 px-2.5 py-1 text-[11px] font-medium text-white hover:bg-blue-700 disabled:opacity-50"
        >
          Save
        </button>
      </div>
    </div>
  )
}

/**
 * Render the template body with realistic sample fills so admins
 * see exactly what the customer will read. Mirrors the dispatcher's
 * substitution logic — unknown keys pass through as `{foo}` so
 * typos surface visually here too.
 */
function TemplatePreview({ body }: { body: string }) {
  const rendered = body.replace(/\{(\w+)\}/g, (_, key) =>
    SAMPLE_FILLS[key] !== undefined ? SAMPLE_FILLS[key] : `{${key}}`
  )
  return (
    <div className="mt-2 rounded-md border border-blue-100 bg-blue-50/60 px-3 py-2 dark:border-blue-900/40 dark:bg-blue-950/20">
      <p className="mb-0.5 text-[10px] font-semibold uppercase tracking-wider text-blue-700 dark:text-blue-300">
        Preview · what the customer will see
      </p>
      <p className="whitespace-pre-wrap text-xs leading-relaxed text-foreground/90">
        {rendered || (
          <span className="text-zinc-400">
            (empty — pick a chip above to start)
          </span>
        )}
      </p>
    </div>
  )
}

/**
 * Live SMS-length hint under each template textarea. Counts chars
 * AFTER stripping `{placeholder}` tokens (which are usually shorter
 * once filled — "TONY UGAS" → "Tony" is the worst case, not the
 * average). Warns at the segment boundary (160 / 306 / 459) so
 * authors notice multi-segment cost + ordering risk before saving.
 */
function SmsLengthHint({ body }: { body: string }) {
  // Use the shared SAMPLE_FILLS map so the length hint and the
  // preview pane agree exactly on what the rendered message looks
  // like. Unknown keys pass through as {foo} so they get counted
  // (intentional — those characters WILL go out if not fixed).
  const stripped = body.replace(/\{(\w+)\}/g, (_, key) =>
    SAMPLE_FILLS[key] !== undefined ? SAMPLE_FILLS[key] : `{${key}}`
  )
  const chars = stripped.length
  const segments =
    chars === 0 ? 0 : chars <= 160 ? 1 : Math.ceil((chars - 160) / 153) + 1
  const tone =
    segments === 0
      ? 'text-zinc-400'
      : segments === 1
        ? 'text-emerald-600 dark:text-emerald-400'
        : segments === 2
          ? 'text-amber-600 dark:text-amber-400'
          : 'text-rose-600 dark:text-rose-400'
  return (
    <p className={cn('mt-1 text-[10px] tabular-nums', tone)}>
      ~{chars} chars · {segments} SMS segment{segments === 1 ? '' : 's'}
      {segments > 1 && (
        <span className="ml-2 text-zinc-500">
          (long messages cost more + may arrive out of order)
        </span>
      )}
    </p>
  )
}

function ReminderRecentLog() {
  const query = useQuery<{ reminders: ReminderLogEntry[] }>({
    queryKey: ['reminders-log'],
    queryFn: async () => {
      const res = await fetch('/api/admin/reminders?limit=20')
      if (!res.ok) throw new Error('Failed to load')
      return res.json()
    },
    refetchInterval: 30_000,
  })

  if (query.isLoading)
    return <p className="text-xs text-zinc-500">Loading log…</p>
  if (query.isError)
    return <p className="text-xs text-rose-600">Couldn&apos;t load log.</p>

  const reminders = query.data?.reminders ?? []
  if (reminders.length === 0) {
    return (
      <p className="rounded-md border border-dashed border-zinc-200 p-3 text-xs text-zinc-500 dark:border-zinc-800">
        No reminder activity yet. Click &ldquo;Sync now&rdquo; above once your
        master sheet has at least one upcoming appointment.
      </p>
    )
  }

  return (
    <div className="overflow-hidden rounded-md border border-zinc-200 dark:border-zinc-800">
      <table className="w-full text-xs">
        <thead className="bg-zinc-50 dark:bg-zinc-900">
          <tr className="text-left text-[10px] font-semibold uppercase tracking-wider text-zinc-500">
            <th className="px-3 py-2">Status</th>
            <th className="px-3 py-2">Window</th>
            <th className="px-3 py-2">Customer</th>
            <th className="px-3 py-2">Client</th>
            <th className="px-3 py-2">Scheduled</th>
            <th className="px-3 py-2">Sent</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
          {reminders.map((r) => (
            <tr key={r.id} className="hover:bg-zinc-50 dark:hover:bg-zinc-800/40">
              <td className="px-3 py-2">
                <span
                  className={cn(
                    'inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-semibold',
                    r.status === 'sent' &&
                      'bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300',
                    r.status === 'pending' &&
                      'bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-300',
                    r.status === 'failed' &&
                      'bg-rose-100 text-rose-700 dark:bg-rose-950 dark:text-rose-300',
                    r.status === 'skipped' &&
                      'bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400',
                    r.status === 'cancelled' &&
                      'bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400'
                  )}
                  title={r.errorMessage || ''}
                >
                  {r.status}
                </span>
              </td>
              <td className="px-3 py-2 font-medium">
                {REMINDER_LABELS[r.reminderType as ReminderType] ??
                  r.reminderType}
              </td>
              <td className="px-3 py-2">
                <div className="font-medium">{r.customerName}</div>
                <div className="text-[10px] text-zinc-500">
                  {r.customerPhone}
                </div>
              </td>
              <td className="px-3 py-2">{r.clientName ?? '—'}</td>
              <td className="px-3 py-2 tabular-nums text-zinc-500">
                {new Date(r.scheduledFor).toLocaleString('en-US', {
                  month: 'short',
                  day: 'numeric',
                  hour: 'numeric',
                  minute: '2-digit',
                  hour12: true,
                })}
              </td>
              <td className="px-3 py-2 tabular-nums text-zinc-500">
                {r.sentAt
                  ? new Date(r.sentAt).toLocaleString('en-US', {
                      month: 'short',
                      day: 'numeric',
                      hour: 'numeric',
                      minute: '2-digit',
                      hour12: true,
                    })
                  : '—'}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

/**
 * Test-send block — admin enters a phone + picks a template + (optional)
 * client + customer name, server renders the body via the same path
 * the cron uses, and dispatches via GHL. Doesn't write an
 * AppointmentReminder row; great for verifying GHL config + previewing
 * copy before flipping the master enable.
 */
type SimpleClient = { id: string; name: string }
type TestResult =
  | { ok: true; messageBody: string; normalizedPhone?: string }
  | { ok: false; error: string; messageBody?: string }

function ReminderTestSendBlock() {
  const [phone, setPhone] = useState('')
  const [reminderType, setReminderType] = useState<ReminderType>('1day')
  const [clientId, setClientId] = useState<string>('')
  const [customerName, setCustomerName] = useState('Test Customer')
  const [address, setAddress] = useState('')
  const [result, setResult] = useState<TestResult | null>(null)

  const clientsQuery = useQuery<{ clients: SimpleClient[] }>({
    queryKey: ['clients'],
    queryFn: async () => {
      const res = await fetch('/api/clients')
      if (!res.ok) return { clients: [] }
      return res.json()
    },
  })

  const sendMutation = useMutation({
    mutationFn: async () => {
      setResult(null)
      const res = await fetch('/api/admin/reminders/test', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          phone: phone.trim(),
          reminderType,
          clientId: clientId || null,
          customerName: customerName.trim() || undefined,
          address: address.trim() || undefined,
        }),
      })
      const data = await res.json()
      if (!res.ok) {
        return {
          ok: false as const,
          error: data.error || 'Test send failed',
          messageBody: data.messageBody,
        }
      }
      return {
        ok: true as const,
        messageBody: data.messageBody,
        normalizedPhone: data.normalizedPhone,
      }
    },
    onSuccess: (data) => setResult(data),
    onError: (err: Error) =>
      setResult({ ok: false, error: err.message }),
  })

  return (
    <div className="mt-6 rounded-md border border-zinc-200 p-4 dark:border-zinc-800">
      <h4 className="mb-1 text-sm font-semibold">Send a test message</h4>
      <p className="mb-3 text-xs text-zinc-500">
        Renders the active template and fires a one-off SMS via GHL.
        Doesn&apos;t create a reminder row in the log. Use this to
        verify your vault token, preview the customer-facing copy, or
        sanity-check before enabling.
      </p>
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label className="mb-1 block text-xs font-medium">Phone</label>
          <input
            type="tel"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            placeholder="(555) 123-4567"
            className="w-full rounded-md border border-zinc-200 px-3 py-2 text-sm dark:border-zinc-800 dark:bg-zinc-950"
          />
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium">Reminder type</label>
          <select
            value={reminderType}
            onChange={(e) => setReminderType(e.target.value as ReminderType)}
            className="w-full rounded-md border border-zinc-200 px-3 py-2 text-sm dark:border-zinc-800 dark:bg-zinc-950"
          >
            {REMINDER_TYPES.map((t) => (
              <option key={t} value={t}>
                {REMINDER_LABELS[t]}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium">Client (optional)</label>
          <select
            value={clientId}
            onChange={(e) => setClientId(e.target.value)}
            className="w-full rounded-md border border-zinc-200 px-3 py-2 text-sm dark:border-zinc-800 dark:bg-zinc-950"
          >
            <option value="">Use default / global template</option>
            {(clientsQuery.data?.clients ?? []).map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium">Customer name</label>
          <input
            type="text"
            value={customerName}
            onChange={(e) => setCustomerName(e.target.value)}
            className="w-full rounded-md border border-zinc-200 px-3 py-2 text-sm dark:border-zinc-800 dark:bg-zinc-950"
          />
        </div>
        <div className="sm:col-span-2">
          <label className="mb-1 block text-xs font-medium">
            Address (optional — used to derive customer timezone)
          </label>
          <input
            type="text"
            value={address}
            onChange={(e) => setAddress(e.target.value)}
            placeholder="e.g. 1533 218th ST TORRANCE CA 90501"
            className="w-full rounded-md border border-zinc-200 px-3 py-2 text-sm dark:border-zinc-800 dark:bg-zinc-950"
          />
        </div>
      </div>
      <div className="mt-3 flex items-center justify-end">
        <button
          type="button"
          onClick={() => sendMutation.mutate()}
          disabled={sendMutation.isPending || !phone.trim()}
          className="inline-flex items-center gap-1.5 rounded-md bg-blue-600 px-3 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
        >
          {sendMutation.isPending ? 'Sending…' : 'Send test'}
        </button>
      </div>
      {result?.ok && (
        <Alert variant="success">
          <div className="font-medium">
            Test sent
            {result.normalizedPhone && (
              <>
                {' '}
                to <code>{result.normalizedPhone}</code>
              </>
            )}
            .
          </div>
          {result.messageBody && (
            <div className="mt-2 whitespace-pre-wrap rounded-md border border-emerald-200 bg-white/60 p-2 font-mono text-xs dark:border-emerald-900 dark:bg-zinc-900/60">
              {result.messageBody}
            </div>
          )}
        </Alert>
      )}
      {result && !result.ok && (
        <Alert variant="error">
          <div className="font-medium">Test send failed</div>
          <div className="mt-1 text-xs">{result.error}</div>
          {result.messageBody && (
            <>
              <div className="mt-2 text-[11px] text-zinc-500">
                Rendered body (would have been sent):
              </div>
              <div className="mt-1 whitespace-pre-wrap rounded-md border border-rose-200 bg-white/60 p-2 font-mono text-xs dark:border-rose-900 dark:bg-zinc-900/60">
                {result.messageBody}
              </div>
            </>
          )}
        </Alert>
      )}
    </div>
  )
}
