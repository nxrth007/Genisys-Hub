'use client'

import Link from 'next/link'
import { useQuery } from '@tanstack/react-query'
import {
  Building2,
  Loader2,
  ExternalLink,
  Mail,
  Phone,
  MapPin,
  StickyNote,
  FileText,
} from 'lucide-react'
import { cn } from '@/lib/utils'

/**
 * Agent-facing Clients page. Read-only by design — Mary uses it to
 * see the situation with each client (state, contact, lifecycle,
 * notes) before/during a booking. Editing happens on the staff
 * /clients page; agents don't get destructive actions here.
 *
 * Reads /api/clients with ?include=routable so paused + onboarding
 * clients show up too. Agents should still see those — they need to
 * know "this client is paused, don't book for them" or "this one is
 * onboarding, route questions to Ethan."
 */

type Client = {
  id: string
  name: string
  state: string | null
  color: string
  lifecycle: string
  contactName: string | null
  contactRole: string | null
  contactEmail: string | null
  contactPhone: string | null
  address: string | null
  notes: string | null
  intakeFormUrl: string | null
  ghlSubaccountUrl: string | null
}

const LIFECYCLE_TONE: Record<string, string> = {
  active:
    'bg-emerald-100 text-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-300',
  onboarding:
    'bg-blue-100 text-blue-700 dark:bg-blue-950/50 dark:text-blue-300',
  paused:
    'bg-amber-100 text-amber-700 dark:bg-amber-950/50 dark:text-amber-300',
  churned:
    'bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400',
}

export default function AgentClientsPage() {
  const { data, isLoading, error } = useQuery<{ clients: Client[] }>({
    queryKey: ['agent-clients'],
    queryFn: async () => {
      const res = await fetch('/api/clients?include=routable')
      if (!res.ok) throw new Error('Failed to load clients')
      return res.json()
    },
  })

  const clients = data?.clients ?? []

  return (
    <div className="mx-auto w-full max-w-5xl space-y-6">
      <div className="flex items-center gap-3">
        <div className="rounded-lg bg-blue-50 p-2.5 dark:bg-blue-950">
          <Building2 className="h-6 w-6 text-blue-600" />
        </div>
        <div>
          <h2 className="text-2xl font-bold tracking-tight">Clients</h2>
          <p className="text-sm text-zinc-500">
            Reference info for the clients we book for. Read-only.
          </p>
        </div>
      </div>

      {isLoading ? (
        <div className="flex items-center justify-center py-16">
          <Loader2 className="h-6 w-6 animate-spin text-blue-600" />
        </div>
      ) : error ? (
        <div className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-300">
          Couldn&apos;t load clients. Try refreshing.
        </div>
      ) : clients.length === 0 ? (
        <div className="rounded-xl border border-dashed border-zinc-300 bg-white p-10 text-center dark:border-zinc-700 dark:bg-zinc-900">
          <Building2 className="mx-auto h-8 w-8 text-zinc-300" />
          <p className="mt-2 text-sm text-zinc-500">
            No clients yet. Ask staff to add them.
          </p>
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2">
          {clients.map((c) => (
            <ClientCard key={c.id} client={c} />
          ))}
        </div>
      )}
    </div>
  )
}

function ClientCard({ client }: { client: Client }) {
  return (
    <article className="flex flex-col gap-3 rounded-2xl border border-zinc-200 bg-white p-5 shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
      {/* Header: color dot + name + state + lifecycle badge */}
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2.5">
          <span
            className="h-3 w-3 flex-shrink-0 rounded-full"
            style={{ backgroundColor: client.color }}
            aria-hidden
          />
          <div className="min-w-0">
            <h3 className="truncate text-sm font-semibold">{client.name}</h3>
            {client.state && (
              <p className="text-[11px] text-zinc-500">{client.state}</p>
            )}
          </div>
        </div>
        <span
          className={cn(
            'rounded px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider flex-shrink-0',
            LIFECYCLE_TONE[client.lifecycle] ?? LIFECYCLE_TONE.active
          )}
        >
          {client.lifecycle}
        </span>
      </div>

      {/* Contact block */}
      {(client.contactName || client.contactEmail || client.contactPhone) && (
        <div className="space-y-1 text-xs">
          {client.contactName && (
            <p className="font-medium text-zinc-800 dark:text-zinc-100">
              {client.contactName}
              {client.contactRole && (
                <span className="ml-1.5 font-normal text-zinc-500">
                  · {client.contactRole}
                </span>
              )}
            </p>
          )}
          {client.contactEmail && (
            <a
              href={`mailto:${client.contactEmail}`}
              className="flex items-center gap-1.5 text-zinc-600 hover:text-blue-600 dark:text-zinc-400"
            >
              <Mail className="h-3 w-3" />
              {client.contactEmail}
            </a>
          )}
          {client.contactPhone && (
            <a
              href={`tel:${client.contactPhone.replace(/\D/g, '')}`}
              className="flex items-center gap-1.5 text-zinc-600 hover:text-blue-600 dark:text-zinc-400"
            >
              <Phone className="h-3 w-3" />
              {client.contactPhone}
            </a>
          )}
        </div>
      )}

      {/* Address */}
      {client.address && (
        <div className="flex items-start gap-1.5 text-[11px] text-zinc-500">
          <MapPin className="mt-0.5 h-3 w-3 flex-shrink-0" />
          <span>{client.address}</span>
        </div>
      )}

      {/* External links */}
      {(client.intakeFormUrl || client.ghlSubaccountUrl) && (
        <div className="flex flex-wrap gap-2">
          {client.intakeFormUrl && (
            <ExternalLinkChip
              href={client.intakeFormUrl}
              icon={FileText}
              label="Intake form"
            />
          )}
          {client.ghlSubaccountUrl && (
            <ExternalLinkChip
              href={client.ghlSubaccountUrl}
              icon={ExternalLink}
              label="GHL"
            />
          )}
        </div>
      )}

      {/* Notes */}
      {client.notes && (
        <div className="rounded-lg border border-zinc-100 bg-zinc-50 p-2.5 dark:border-zinc-800 dark:bg-zinc-950/50">
          <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-zinc-500">
            <StickyNote className="h-3 w-3" />
            Notes
          </div>
          <p className="mt-1 whitespace-pre-line text-xs text-zinc-700 dark:text-zinc-300">
            {client.notes}
          </p>
        </div>
      )}
    </article>
  )
}

function ExternalLinkChip({
  href,
  icon: Icon,
  label,
}: {
  href: string
  icon: React.ComponentType<{ className?: string }>
  label: string
}) {
  return (
    <Link
      href={href}
      target="_blank"
      rel="noreferrer"
      className="inline-flex items-center gap-1 rounded-md border border-zinc-200 bg-white px-2 py-1 text-[11px] font-medium text-zinc-600 transition hover:bg-zinc-50 hover:text-blue-600 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300 dark:hover:bg-zinc-800"
    >
      <Icon className="h-3 w-3" />
      {label}
    </Link>
  )
}
