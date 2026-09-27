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
    'bg-success/15 text-success bg-success/15 text-success',
  onboarding:
    'bg-primary-soft text-primary bg-primary-soft text-primary',
  paused:
    'bg-warning/15 text-warning bg-warning/15 text-warning',
  churned:
    'bg-muted text-muted-foreground bg-surface-muted text-muted-foreground',
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
        <div className="rounded-lg bg-primary-soft p-2.5 bg-primary-soft">
          <Building2 className="h-6 w-6 text-primary" />
        </div>
        <div>
          <h2 className="text-2xl font-bold tracking-tight">Clients</h2>
          <p className="text-sm text-muted-foreground">
            Reference info for the clients we book for. Read-only.
          </p>
        </div>
      </div>

      {isLoading ? (
        <div className="flex items-center justify-center py-16">
          <Loader2 className="h-6 w-6 animate-spin text-primary" />
        </div>
      ) : error ? (
        <div className="rounded-xl border border-destructive/30 bg-destructive/10 p-4 text-sm text-destructive border-destructive/30 bg-destructive/10 text-destructive">
          Couldn&apos;t load clients. Try refreshing.
        </div>
      ) : clients.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border bg-card p-10 text-center border-border bg-card">
          <Building2 className="mx-auto h-8 w-8 text-muted-foreground/50" />
          <p className="mt-2 text-sm text-muted-foreground">
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
    <article className="flex flex-col gap-3 rounded-xl border border-border bg-card p-5 border-border bg-card">
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
              <p className="text-[11px] text-muted-foreground">{client.state}</p>
            )}
          </div>
        </div>
        <span
          className={cn(
            'rounded px-2 py-0.5 eyebrow flex-shrink-0',
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
            <p className="font-medium text-foreground">
              {client.contactName}
              {client.contactRole && (
                <span className="ml-1.5 font-normal text-muted-foreground">
                  · {client.contactRole}
                </span>
              )}
            </p>
          )}
          {client.contactEmail && (
            <a
              href={`mailto:${client.contactEmail}`}
              className="flex items-center gap-1.5 text-muted-foreground hover:text-primary text-muted-foreground"
            >
              <Mail className="h-3 w-3" />
              {client.contactEmail}
            </a>
          )}
          {client.contactPhone && (
            <a
              href={`tel:${client.contactPhone.replace(/\D/g, '')}`}
              className="flex items-center gap-1.5 text-muted-foreground hover:text-primary text-muted-foreground"
            >
              <Phone className="h-3 w-3" />
              {client.contactPhone}
            </a>
          )}
        </div>
      )}

      {/* Address */}
      {client.address && (
        <div className="flex items-start gap-1.5 text-[11px] text-muted-foreground">
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
        <div className="rounded-lg border border-border-soft bg-surface-muted p-2.5 border-border bg-background/50">
          <div className="flex items-center gap-1.5 eyebrow text-muted-foreground">
            <StickyNote className="h-3 w-3" />
            Notes
          </div>
          <p className="mt-1 whitespace-pre-line text-xs text-foreground/85">
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
      className="inline-flex items-center gap-1 rounded-md border border-border bg-card px-2 py-1 text-[11px] font-medium text-muted-foreground transition hover:bg-muted hover:text-primary border-border bg-card text-foreground/85 hover:bg-muted"
    >
      <Icon className="h-3 w-3" />
      {label}
    </Link>
  )
}
