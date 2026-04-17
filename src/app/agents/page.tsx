'use client'

import { useState } from 'react'
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
} from 'lucide-react'
import { cn } from '@/lib/utils'

type Agent = {
  id: string
  name: string | null
  email: string
  role: 'agent_pending' | 'agent' | 'agent_denied'
  agentSheetTab: string | null
  approvedAt: string | null
  createdAt: string
  updatedAt: string
  _count: { appointments: number }
}

export default function AgentsAdminPage() {
  const qc = useQueryClient()
  const [tab, setTab] = useState<'pending' | 'approved' | 'denied'>('pending')

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
      <div>
        <div className="flex items-center gap-3">
          <div className="rounded-lg bg-purple-50 p-2.5 dark:bg-purple-950">
            <Headphones className="h-6 w-6 text-purple-600" />
          </div>
          <div>
            <h2 className="text-2xl font-bold tracking-tight">Agents</h2>
            <p className="mt-1 text-sm text-zinc-500">
              Review registrations, manage agent accounts, and reset passwords.
            </p>
          </div>
        </div>
      </div>

      <div className="flex items-center gap-1 border-b border-zinc-200 dark:border-zinc-800">
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
      </div>

      {agentsQuery.isLoading ? (
        <div className="flex items-center justify-center py-16">
          <Loader2 className="h-6 w-6 animate-spin text-purple-600" />
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
        '-mb-px flex items-center gap-1.5 border-b-2 px-4 py-2 text-sm font-medium transition-colors',
        active
          ? 'border-purple-600 text-purple-600'
          : 'border-transparent text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100'
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
            <button
              onClick={() => mutation.mutate({ action: 'deny' })}
              disabled={mutation.isPending}
              className="inline-flex items-center gap-1 rounded-md border border-red-300 bg-white px-2.5 py-1.5 text-xs font-medium text-red-600 hover:bg-red-50 dark:border-red-900 dark:bg-red-950/40"
              title="Revoke access"
            >
              <X className="h-3 w-3" /> Revoke
            </button>
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
              className="w-full rounded-md border border-zinc-200 px-3 py-2 text-sm focus:border-purple-500 focus:outline-none dark:border-zinc-800 dark:bg-zinc-950"
            />
          </div>
          <button
            type="submit"
            disabled={mutation.isPending || !newPassword}
            className="rounded-md bg-purple-600 px-3 py-2 text-xs font-medium text-white hover:bg-purple-700 disabled:opacity-50"
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
