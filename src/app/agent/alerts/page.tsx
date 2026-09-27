'use client'

/**
 * Agent Alerts — the booking agent's feedback feed. Surfaces when a
 * customer declined / asked to reschedule a reminder, or a client
 * marked one of this agent's appointments no-show / cancelled. Each
 * card links to logging a callback so Mary can re-engage in one hop.
 */
import { useMemo, useState } from 'react'
import Link from 'next/link'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  Loader2,
  BellRing,
  CalendarX,
  CalendarClock,
  XCircle,
  PhoneOff,
  Check,
  PhoneForwarded,
} from 'lucide-react'

type AgentAlert = {
  id: string
  type: 'negative_reply' | 'reschedule' | 'no_show' | 'cancelled'
  appointmentId: string | null
  customerName: string | null
  customerPhone: string | null
  clientName: string | null
  apptDateTime: string | null
  detail: string | null
  status: 'unread' | 'read' | 'actioned'
  createdAt: string
}

const TYPE_META: Record<
  AgentAlert['type'],
  { label: string; icon: typeof CalendarX; tone: string }
> = {
  negative_reply: {
    label: "Customer replied “N”",
    icon: PhoneOff,
    tone: 'text-destructive',
  },
  reschedule: {
    label: 'Wants to reschedule',
    icon: CalendarClock,
    tone: 'text-warning',
  },
  no_show: {
    label: 'No-show',
    icon: CalendarX,
    tone: 'text-destructive',
  },
  cancelled: {
    label: 'Cancelled',
    icon: XCircle,
    tone: 'text-muted-foreground',
  },
}

export default function AgentAlertsPage() {
  const qc = useQueryClient()
  const [filter, setFilter] = useState<'all' | 'unread'>('unread')

  const query = useQuery<{ alerts: AgentAlert[]; unreadCount: number }>({
    queryKey: ['agent-alerts', filter],
    queryFn: async () => {
      const sp = filter === 'unread' ? '?status=unread' : ''
      const res = await fetch(`/api/agent/alerts${sp}`)
      if (!res.ok) throw new Error('Failed to load alerts')
      return res.json()
    },
    refetchInterval: 60_000,
  })

  const mark = useMutation({
    mutationFn: async (vars: { id: string; status: string }) => {
      const res = await fetch('/api/agent/alerts', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(vars),
      })
      if (!res.ok) throw new Error('Failed to update')
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['agent-alerts'] }),
  })

  const alerts = query.data?.alerts ?? []
  const unread = query.data?.unreadCount ?? 0

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-5 px-4 py-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <BellRing className="h-5 w-5 text-primary" />
          <h1 className="text-lg font-semibold">Alerts</h1>
          {unread > 0 && (
            <span className="rounded-md bg-destructive px-2 py-0.5 text-xs font-semibold text-destructive-foreground">
              {unread}
            </span>
          )}
        </div>
        <div className="flex gap-1 rounded-lg border border-border p-0.5 text-xs border-border">
          {(['unread', 'all'] as const).map((f) => (
            <button
              key={f}
              type="button"
              onClick={() => setFilter(f)}
              className={`rounded-md px-3 py-1 font-medium capitalize transition ${
                filter === f
                  ? 'bg-foreground text-background'
                  : 'text-muted-foreground hover:bg-muted text-foreground/85 hover:bg-muted'
              }`}
            >
              {f}
            </button>
          ))}
        </div>
      </div>

      <p className="text-xs text-muted-foreground">
        When a customer says they can&apos;t make it or wants to
        reschedule, or a client marks one of your appointments
        no-show / cancelled, it shows up here. Log a callback to
        re-engage them.
      </p>

      {query.isLoading ? (
        <div className="flex justify-center py-16">
          <Loader2 className="h-6 w-6 animate-spin text-primary" />
        </div>
      ) : alerts.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border py-14 text-center border-border">
          <BellRing className="mx-auto h-9 w-9 text-muted-foreground/50 dark:text-zinc-700" />
          <p className="mt-3 text-sm font-medium">
            {filter === 'unread' ? 'No new alerts' : 'No alerts yet'}
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            You&apos;re all caught up.
          </p>
        </div>
      ) : (
        <ul className="flex flex-col gap-2.5">
          {alerts.map((a) => (
            <AlertCard
              key={a.id}
              alert={a}
              onMark={(status) => mark.mutate({ id: a.id, status })}
              marking={mark.isPending}
            />
          ))}
        </ul>
      )}
    </div>
  )
}

function AlertCard({
  alert,
  onMark,
  marking,
}: {
  alert: AgentAlert
  onMark: (status: string) => void
  marking: boolean
}) {
  const meta = TYPE_META[alert.type]
  const Icon = meta.icon
  const apptStr = useMemo(() => {
    if (!alert.apptDateTime) return null
    return new Date(alert.apptDateTime).toLocaleString('en-US', {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    })
  }, [alert.apptDateTime])

  const callbackHref = `/agent/callbacks/new?name=${encodeURIComponent(
    alert.customerName ?? '',
  )}&phone=${encodeURIComponent(alert.customerPhone ?? '')}`

  const isOpen = alert.status !== 'actioned'

  return (
    <li
      className={`rounded-xl border p-4 transition ${
        alert.status === 'unread'
          ? 'border-primary/30 bg-primary-soft/40 border-primary/30 bg-primary-soft/20'
          : 'border-border bg-card border-border bg-card'
      }`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <Icon className={`h-4 w-4 flex-shrink-0 ${meta.tone}`} />
            <span className={`text-sm font-semibold ${meta.tone}`}>
              {meta.label}
            </span>
            {alert.status === 'actioned' && (
              <span className="rounded-md bg-success/15 px-2 py-0.5 text-[10px] font-semibold text-success bg-success/15 text-success">
                Handled
              </span>
            )}
          </div>
          <p className="mt-1.5 text-sm font-medium">
            {alert.customerName || 'Customer'}
            {alert.customerPhone && (
              <span className="ml-2 font-normal text-muted-foreground">
                {alert.customerPhone}
              </span>
            )}
          </p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {alert.clientName && <>{alert.clientName} · </>}
            {apptStr ? `Appt ${apptStr}` : 'No appointment time'}
          </p>
          {alert.detail && (
            <p className="mt-2 rounded-md bg-muted px-2.5 py-1.5 text-xs text-foreground/85 bg-surface-muted text-foreground/85">
              {alert.detail}
            </p>
          )}
        </div>
      </div>

      <div className="mt-3 flex items-center gap-2">
        <Link
          href={callbackHref}
          onClick={() => onMark('actioned')}
          className="inline-flex items-center gap-1.5 rounded-md bg-foreground px-3 py-1.5 text-xs font-semibold text-background transition hover:bg-foreground/90"
        >
          <PhoneForwarded className="h-3 w-3" />
          Log callback
        </Link>
        {isOpen ? (
          <button
            type="button"
            disabled={marking}
            onClick={() => onMark('actioned')}
            className="inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-xs font-medium text-muted-foreground transition hover:bg-muted disabled:opacity-50 border-border text-foreground/85 hover:bg-muted"
          >
            <Check className="h-3 w-3" />
            Mark handled
          </button>
        ) : (
          <button
            type="button"
            disabled={marking}
            onClick={() => onMark('unread')}
            className="rounded-md px-3 py-1.5 text-xs font-medium text-muted-foreground transition hover:bg-muted disabled:opacity-50 hover:bg-muted"
          >
            Reopen
          </button>
        )}
      </div>
    </li>
  )
}
