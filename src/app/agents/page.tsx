'use client'

import { useState } from 'react'
import Link from 'next/link'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  Headphones,
  Check,
  X,
  KeyRound,
  Trash2,
  AlertCircle,
  Clock,
  UserX,
  Loader2,
  History,
  FileSpreadsheet,
  PencilLine,
  Users,
  MessageSquare,
  Activity,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { PageHeader } from '@/components/ui/page-header'

type Agent = {
  id: string
  name: string | null
  email: string
  role: 'agent_pending' | 'agent' | 'agent_denied'
  agentSheetTab: string | null
  approvedAt: string | null
  /** Set when admin has delegated team-manager rights to this
   *  agent — they can approve Team #N registrations + assign
   *  initial call-center numbers from /team/manage without admin
   *  acting as a bottleneck. */
  managesTeamNumber: number | null
  createdAt: string
  updatedAt: string
  _count: { appointments: number }
}

export default function AgentsAdminPage() {
  const qc = useQueryClient()
  const [tab, setTab] = useState<
    'pending' | 'approved' | 'denied' | 'edits'
  >('pending')

  const agentsQuery = useQuery<{ agents: Agent[] }>({
    queryKey: ['admin-agents'],
    queryFn: async () => {
      const res = await fetch('/api/admin/agents')
      if (!res.ok) throw new Error('Failed to load agents')
      return res.json()
    },
  })

  const agents = agentsQuery.data?.agents ?? []
  const pending = agents.filter((a) => a.role === 'agent_pending')
  const approved = agents.filter((a) => a.role === 'agent')
  const denied = agents.filter((a) => a.role === 'agent_denied')

  const visible = tab === 'pending' ? pending : tab === 'approved' ? approved : denied

  const refetch = () => qc.invalidateQueries({ queryKey: ['admin-agents'] })

  return (
    <div className="max-w-5xl space-y-6">
      <PageHeader
        icon={Headphones}
        title="Agents"
        subtitle="Review registrations, manage agent accounts, and reset passwords."
        actions={
          <>
            <Link
              href="/team/live-report"
              className="inline-flex items-center gap-2 rounded-full border border-border bg-card px-4 py-2 text-sm font-semibold text-foreground transition hover:bg-muted"
              title="Live mirror of the Vicidial admin dashboard — read-only stats refreshing every minute"
            >
              <Activity className="h-4 w-4" />
              Live report
            </Link>
            <Link
              href="/team/chat"
              className="inline-flex items-center gap-2 rounded-full border border-border bg-card px-4 py-2 text-sm font-semibold text-foreground transition hover:bg-muted"
              title="Open the Team #1 chat — you appear with an animated Admin chip next to your name"
            >
              <MessageSquare className="h-4 w-4" />
              Team #1 chat
            </Link>
            <Link
              href="/admin/team-members"
              className="inline-flex items-center gap-2 rounded-full border border-border bg-card px-4 py-2 text-sm font-semibold text-foreground transition hover:bg-muted"
            >
              <Users className="h-4 w-4" />
              Team #1 members
            </Link>
          </>
        }
      />

      <div className="flex flex-wrap items-center gap-1">
        <TabButton active={tab === 'pending'} onClick={() => setTab('pending')}>
          <Clock className="h-3.5 w-3.5" />
          Pending
          {pending.length > 0 && (
            <span className="ml-1 rounded-full bg-amber-500 px-1.5 py-0.5 text-[10px] font-semibold text-white">
              {pending.length}
            </span>
          )}
        </TabButton>
        <TabButton active={tab === 'approved'} onClick={() => setTab('approved')}>
          <Check className="h-3.5 w-3.5" />
          Approved ({approved.length})
        </TabButton>
        <TabButton active={tab === 'denied'} onClick={() => setTab('denied')}>
          <UserX className="h-3.5 w-3.5" />
          Denied ({denied.length})
        </TabButton>
        <TabButton active={tab === 'edits'} onClick={() => setTab('edits')}>
          <History className="h-3.5 w-3.5" />
          Appointment edits
        </TabButton>
      </div>

      {tab === 'edits' ? (
        <AppointmentEditsTab />
      ) : agentsQuery.isLoading ? (
        <div className="flex items-center justify-center py-16">
          <Loader2 className="h-6 w-6 animate-spin text-blue-600" />
        </div>
      ) : visible.length === 0 ? (
        <div className="rounded-xl border border-dashed border-zinc-200 py-16 text-center dark:border-zinc-800">
          <p className="text-sm text-zinc-500">
            {tab === 'pending'
              ? 'No pending registrations.'
              : tab === 'approved'
                ? 'No approved agents yet.'
                : 'No denied registrations.'}
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {visible.map((a) => (
            <AgentCard key={a.id} agent={a} onChange={refetch} />
          ))}
        </div>
      )}
    </div>
  )
}

/* ------------------------------------------------------------------ */
/*  Appointment edits tab                                              */
/* ------------------------------------------------------------------ */

type AppointmentEdit = {
  id: string
  appointmentId: string | null
  sheetTabTitle: string | null
  sheetRowNumber: number | null
  clientId: string | null
  clientName: string | null
  editorUserId: string | null
  editorEmail: string | null
  editorName: string | null
  customerName: string | null
  customerPhone: string | null
  apptDateTime: string | null
  source: 'agent-form' | 'master-tracker' | string
  changes: Record<string, { from: unknown; to: unknown }>
  createdAt: string
}

type ClientLookup = Record<
  string,
  { id: string; name: string; color: string; state: string | null }
>

function AppointmentEditsTab() {
  const editsQuery = useQuery<{ edits: AppointmentEdit[]; clients: ClientLookup }>({
    queryKey: ['appointment-edits'],
    queryFn: async () => {
      const res = await fetch('/api/admin/appointment-edits')
      if (!res.ok) {
        const d = await res.json().catch(() => ({}))
        throw new Error(d.error || 'Failed to load edits')
      }
      return res.json()
    },
  })

  if (editsQuery.isLoading) {
    return (
      <div className="flex items-center justify-center py-16">
        <Loader2 className="h-6 w-6 animate-spin text-blue-600" />
      </div>
    )
  }

  if (editsQuery.isError) {
    return (
      <div className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-200">
        {(editsQuery.error as Error).message}
      </div>
    )
  }

  const edits = editsQuery.data?.edits ?? []
  const clients = editsQuery.data?.clients ?? {}
  if (edits.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-zinc-200 py-16 text-center dark:border-zinc-800">
        <p className="text-sm text-zinc-500">
          No appointment edits yet. When Mary (or anyone) changes a field on an
          existing appointment, the change shows up here with who / what /
          when.
        </p>
      </div>
    )
  }

  return (
    <div className="space-y-2">
      {edits.map((e) => (
        <AppointmentEditRow key={e.id} edit={e} clients={clients} />
      ))}
    </div>
  )
}

/** Map raw Appointment field names to human-friendly labels for the
 *  edit log display. Anything not in this map renders the raw key
 *  so a new field on Appointment doesn't silently get a worse label
 *  — admin sees the raw name and we add it here. */
const FIELD_LABELS: Record<string, string> = {
  clientId: 'Client',
  status: 'Status',
  customerName: 'Customer name',
  customerPhone: 'Customer phone',
  apptDateTime: 'Appointment time',
  address: 'Address',
  email: 'Email',
  monthlyBill: 'Monthly bill',
  utilityProvider: 'Utility provider',
  roofType: 'Roof type',
  roofAge: 'Roof age',
  estimatedDealValue: 'Estimated deal value',
  notes: 'Notes',
  callRecordingLink: 'Call recording',
  bookedByName: 'Booked by',
  sentToClient: 'Sent to client',
  agentUserId: 'Agent',
}

function fieldLabel(field: string): string {
  return FIELD_LABELS[field] ?? field
}

function AppointmentEditRow({
  edit,
  clients,
}: {
  edit: AppointmentEdit
  clients: ClientLookup
}) {
  const changeEntries = Object.entries(edit.changes ?? {})
  // The clientName snapshot on the edit log row reflects whatever the
  // appointment's client was at the moment the edit was saved —
  // which for an edit that CHANGED the client could be either the
  // pre-edit or the post-edit value depending on the write path.
  // Surface this ambiguity with a tooltip so admins don't have to
  // guess (the field-level diff below is the source of truth on
  // "what was it before vs after").
  return (
    <div className="rounded-xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-semibold">
              {edit.customerName || '(unknown customer)'}
            </span>
            {edit.clientName && (
              <span
                className="rounded-full bg-zinc-100 px-2 py-0.5 text-[10px] font-medium text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300"
                title="Client linked to this appointment when the edit was saved. If the edit changed the client, see the Before/After below for the exact swap."
              >
                {edit.clientName}
              </span>
            )}
            <span className="rounded-full bg-blue-100 px-2 py-0.5 text-[10px] font-medium text-blue-700 dark:bg-blue-950 dark:text-blue-300">
              {edit.source === 'agent-form' ? (
                <>
                  <PencilLine className="mr-0.5 inline h-2.5 w-2.5 align-text-bottom" />
                  Hub form
                </>
              ) : (
                <>
                  <FileSpreadsheet className="mr-0.5 inline h-2.5 w-2.5 align-text-bottom" />
                  Master tracker
                </>
              )}
            </span>
          </div>
          <p className="mt-1 text-xs text-zinc-500">
            <span className="font-medium text-zinc-700 dark:text-zinc-300">
              {edit.editorName || edit.editorEmail || '(unknown editor)'}
            </span>
            {edit.editorName && edit.editorEmail && (
              <span className="text-zinc-400"> &lt;{edit.editorEmail}&gt;</span>
            )}
            {' '}·{' '}
            <span title={new Date(edit.createdAt).toString()}>
              {new Date(edit.createdAt).toLocaleString('en-US', {
                month: 'short',
                day: 'numeric',
                year: 'numeric',
                hour: 'numeric',
                minute: '2-digit',
              })}
            </span>
            {edit.apptDateTime && (
              <>
                {' '}· Appt{' '}
                {new Date(edit.apptDateTime).toLocaleString('en-US', {
                  month: 'short',
                  day: 'numeric',
                  hour: 'numeric',
                  minute: '2-digit',
                })}
              </>
            )}
            {edit.customerPhone && <> · {edit.customerPhone}</>}
          </p>
        </div>
      </div>

      <div className="mt-3 border-t border-zinc-100 pt-3 dark:border-zinc-800">
        {changeEntries.length === 0 ? (
          <p className="text-xs text-zinc-400">No tracked field changes.</p>
        ) : (
          <>
            {/* Header row makes Before/After explicit so admin
                doesn't have to infer direction from the strikethrough
                + arrow. */}
            <div className="mb-1.5 grid grid-cols-[8rem_1fr_1fr] gap-x-3 text-[10px] font-semibold uppercase tracking-wide text-zinc-400">
              <span>Field</span>
              <span>Before</span>
              <span>After</span>
            </div>
            <div className="space-y-1.5">
              {changeEntries.map(([field, change]) => (
                <div
                  key={field}
                  className="grid grid-cols-[8rem_1fr_1fr] items-start gap-x-3 text-xs"
                >
                  <span className="truncate font-medium text-zinc-500 dark:text-zinc-400">
                    {fieldLabel(field)}
                  </span>
                  <div className="min-w-0">
                    <FieldValueChip
                      field={field}
                      value={change.from}
                      tone="before"
                      clients={clients}
                    />
                  </div>
                  <div className="min-w-0">
                    <FieldValueChip
                      field={field}
                      value={change.to}
                      tone="after"
                      clients={clients}
                    />
                  </div>
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  )
}

/** Renders a single Before/After value. Resolves clientId values
 *  against the clients lookup → shows the client name + colored
 *  dot (cuid still available on hover for forensics). Everything
 *  else falls through to formatChangeValue. */
function FieldValueChip({
  field,
  value,
  tone,
  clients,
}: {
  field: string
  value: unknown
  tone: 'before' | 'after'
  clients: ClientLookup
}) {
  const isEmpty =
    value === null ||
    value === undefined ||
    (typeof value === 'string' && value === '')

  const baseClasses =
    tone === 'before'
      ? 'inline-flex items-center gap-1.5 rounded bg-rose-50 px-1.5 py-0.5 text-rose-700 dark:bg-rose-950/40 dark:text-rose-300'
      : 'inline-flex items-center gap-1.5 rounded bg-emerald-50 px-1.5 py-0.5 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300'

  if (isEmpty) {
    return (
      <span className={cn(baseClasses, 'italic opacity-70')}>(empty)</span>
    )
  }

  // Client resolution — when the field is clientId AND we have a
  // matching client in the lookup, swap the cuid for a colored-dot
  // name pill. The raw cuid is preserved as the title so admins
  // can copy it if needed for support / debugging.
  if (field === 'clientId' && typeof value === 'string') {
    const client = clients[value]
    if (client) {
      return (
        <span
          className={cn(baseClasses)}
          title={`Client id: ${value}`}
        >
          <span
            className="h-2 w-2 flex-shrink-0 rounded-full"
            style={{ backgroundColor: client.color }}
            aria-hidden
          />
          <span className="truncate font-semibold">{client.name}</span>
          {client.state && (
            <span className="text-[10px] font-normal opacity-70">
              · {client.state}
            </span>
          )}
        </span>
      )
    }
    // Unknown client (deleted? not in lookup?). Show the cuid but
    // tag it so admin can see something's off.
    return (
      <span className={cn(baseClasses)} title={`Unresolved client id: ${value}`}>
        <span className="font-mono text-[10px]">{value.slice(0, 10)}…</span>
        <span className="text-[10px] opacity-70">(unknown client)</span>
      </span>
    )
  }

  return <span className={baseClasses}>{formatChangeValue(value)}</span>
}

/** Render a from/to value for display. Null/empty → "(empty)" so
 *  admin can tell apart "field was unset" from "field is whitespace."
 *  Dates ISO-ish → human-friendly. Everything else → JSON if it isn't
 *  already a string, so an object value (rare) doesn't render as
 *  "[object Object]". */
function formatChangeValue(v: unknown): string {
  if (v === null || v === undefined || v === '') return '(empty)'
  if (typeof v === 'string') {
    // Best-effort ISO datetime → human-readable. The .endsWith('Z')
    // check is a tight signal for "this is a UTC ISO string we stored
    // in the audit log." Other date-ish strings pass through as-is.
    if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(v)) {
      const d = new Date(v)
      if (!isNaN(d.getTime())) {
        return d.toLocaleString('en-US', {
          month: 'short',
          day: 'numeric',
          year: 'numeric',
          hour: 'numeric',
          minute: '2-digit',
        })
      }
    }
    return v
  }
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  try {
    return JSON.stringify(v)
  } catch {
    return String(v)
  }
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full px-3.5 py-1.5 text-sm font-medium transition-colors',
        active
          ? 'bg-blue-600 text-white shadow-sm'
          : 'text-zinc-600 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-800/80'
      )}
    >
      {children}
    </button>
  )
}

function AgentCard({ agent, onChange }: { agent: Agent; onChange: () => void }) {
  const [showReset, setShowReset] = useState(false)
  const [newPassword, setNewPassword] = useState('')
  const [error, setError] = useState<string | null>(null)

  const mutation = useMutation({
    mutationFn: async (body: Record<string, unknown>) => {
      setError(null)
      const res = await fetch(`/api/admin/agents/${agent.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Failed')
      return data
    },
    onSuccess: () => {
      setShowReset(false)
      setNewPassword('')
      onChange()
    },
    onError: (err) => setError((err as Error).message),
  })

  const deleteMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch(`/api/admin/agents/${agent.id}`, { method: 'DELETE' })
      if (!res.ok) {
        const d = await res.json().catch(() => ({}))
        throw new Error(d.error || 'Failed')
      }
      return res.json()
    },
    onSuccess: onChange,
    onError: (err) => setError((err as Error).message),
  })

  return (
    <div className="rounded-xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <p className="truncate font-semibold">{agent.name || '(no name)'}</p>
            <span
              className={cn(
                'rounded-full px-2 py-0.5 text-[10px] font-semibold',
                agent.role === 'agent_pending'
                  ? 'bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300'
                  : agent.role === 'agent'
                    ? 'bg-green-100 text-green-700 dark:bg-green-950 dark:text-green-300'
                    : 'bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300'
              )}
            >
              {agent.role === 'agent_pending'
                ? 'Pending'
                : agent.role === 'agent'
                  ? 'Approved'
                  : 'Denied'}
            </span>
          </div>
          <p className="mt-0.5 text-sm text-zinc-500">{agent.email}</p>
          <p className="mt-1 text-xs text-zinc-400">
            Registered {new Date(agent.createdAt).toLocaleDateString()}
            {agent.approvedAt &&
              ` · Approved ${new Date(agent.approvedAt).toLocaleDateString()}`}
            {agent._count.appointments > 0 &&
              ` · ${agent._count.appointments} appointment${
                agent._count.appointments === 1 ? '' : 's'
              }`}
          </p>
        </div>

        <div className="flex flex-shrink-0 flex-wrap items-center justify-end gap-1.5">
          {agent.role === 'agent_pending' && (
            <>
              <button
                onClick={() => mutation.mutate({ action: 'approve' })}
                disabled={mutation.isPending}
                className="inline-flex items-center gap-1 rounded-md bg-green-600 px-2.5 py-1.5 text-xs font-medium text-white hover:bg-green-700 disabled:opacity-50"
              >
                <Check className="h-3 w-3" /> Approve
              </button>
              <button
                onClick={() => mutation.mutate({ action: 'deny' })}
                disabled={mutation.isPending}
                className="inline-flex items-center gap-1 rounded-md border border-red-300 bg-white px-2.5 py-1.5 text-xs font-medium text-red-600 hover:bg-red-50 dark:border-red-900 dark:bg-red-950/40"
              >
                <X className="h-3 w-3" /> Deny
              </button>
            </>
          )}
          {agent.role === 'agent' && (
            <>
              {/* Team-manager toggle. Designating an agent (Mary) as
                  the Team #N manager lets her approve registrations
                  + assign call-center numbers from /team/manage
                  without admin acting as a bottleneck. Hardcoded to
                  Team #1 because that's the only team today; future
                  multi-team would replace this with a picker. */}
              <button
                onClick={() =>
                  mutation.mutate({
                    managesTeamNumber: agent.managesTeamNumber ? null : 1,
                  })
                }
                disabled={mutation.isPending}
                className={cn(
                  'inline-flex items-center gap-1 rounded-md border px-2.5 py-1.5 text-xs font-medium',
                  agent.managesTeamNumber
                    ? 'border-blue-300 bg-blue-50 text-blue-700 hover:bg-blue-100 dark:border-blue-800 dark:bg-blue-950 dark:text-blue-300'
                    : 'border-zinc-200 bg-white text-zinc-600 hover:bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-300',
                )}
                title={
                  agent.managesTeamNumber
                    ? `Revoke Team #${agent.managesTeamNumber} manager rights — they can no longer approve Team #1 registrations`
                    : 'Grant Team #1 manager rights — they can approve registrations + assign call-center numbers from /team/manage'
                }
              >
                <Users className="h-3 w-3" />
                {agent.managesTeamNumber
                  ? `Team #${agent.managesTeamNumber} mgr ✓`
                  : 'Make Team #1 mgr'}
              </button>
              <button
                onClick={() => mutation.mutate({ action: 'deny' })}
                disabled={mutation.isPending}
                className="inline-flex items-center gap-1 rounded-md border border-red-300 bg-white px-2.5 py-1.5 text-xs font-medium text-red-600 hover:bg-red-50 dark:border-red-900 dark:bg-red-950/40"
                title="Revoke access"
              >
                <X className="h-3 w-3" /> Revoke
              </button>
            </>
          )}
          {agent.role === 'agent_denied' && (
            <button
              onClick={() => mutation.mutate({ action: 'approve' })}
              disabled={mutation.isPending}
              className="inline-flex items-center gap-1 rounded-md bg-green-600 px-2.5 py-1.5 text-xs font-medium text-white hover:bg-green-700 disabled:opacity-50"
              title="Approve a previously-denied registration"
            >
              <Check className="h-3 w-3" /> Approve
            </button>
          )}
          <button
            onClick={() => setShowReset((v) => !v)}
            className="inline-flex items-center gap-1 rounded-md border border-zinc-200 bg-white px-2.5 py-1.5 text-xs font-medium text-zinc-600 hover:bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-300"
          >
            <KeyRound className="h-3 w-3" /> Password
          </button>
          <button
            onClick={() => {
              if (
                confirm(
                  `Permanently delete ${agent.email}? This removes the account and all their appointments.`
                )
              ) {
                deleteMutation.mutate()
              }
            }}
            disabled={deleteMutation.isPending}
            className="rounded-md p-1.5 text-zinc-400 hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-950"
            title="Delete account"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      {showReset && (
        <form
          onSubmit={(e) => {
            e.preventDefault()
            if (newPassword.length < 8) {
              setError('New password must be at least 8 characters.')
              return
            }
            mutation.mutate({ action: 'reset_password', newPassword })
          }}
          className="mt-3 flex items-end gap-2 border-t border-zinc-100 pt-3 dark:border-zinc-800"
        >
          <div className="flex-1">
            <label className="mb-1 block text-xs font-medium text-zinc-500">
              New password for {agent.email}
            </label>
            <input
              type="text"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              placeholder="At least 8 characters"
              className="w-full rounded-md border border-zinc-200 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none dark:border-zinc-800 dark:bg-zinc-950"
            />
          </div>
          <button
            type="submit"
            disabled={mutation.isPending || !newPassword}
            className="rounded-md bg-blue-600 px-3 py-2 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-50"
          >
            Set password
          </button>
          <button
            type="button"
            onClick={() => {
              setShowReset(false)
              setNewPassword('')
              setError(null)
            }}
            className="rounded-md px-3 py-2 text-xs text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800"
          >
            Cancel
          </button>
        </form>
      )}

      {error && (
        <div className="mt-3 flex items-start gap-2 rounded-md border border-red-200 bg-red-50 p-2 text-xs text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-200">
          <AlertCircle className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" />
          {error}
        </div>
      )}

      {mutation.isSuccess && mutation.variables && !showReset && !error && (
        <p className="mt-2 text-xs text-green-600">Saved.</p>
      )}
    </div>
  )
}
