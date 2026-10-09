'use client'

import { Suspense, useEffect, useMemo, useRef, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  AlertTriangle,
  Archive,
  ArchiveRestore,
  Building2,
  Check,
  ChevronDown,
  ChevronRight,
  ExternalLink,
  FileText,
  FolderGit2,
  Globe,
  Loader2,
  Pencil,
  Search,
  Trash2,
  TrendingUp,
  X,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { PageHeader } from '@/components/ui/page-header'
import { OnboardingHealth } from '@/components/clients/onboarding-health'
import { Chip } from '@/components/ui/chip'
import { DropdownPill } from '@/components/ui/dropdown-pill'
import {
  ClientEditDialog,
  LIFECYCLES,
  type ClientEditValues,
} from '@/components/clients/client-edit-dialog'

/**
 * Clients — every client the agency has onboarded.
 *
 * Clients arrive through the onboarding form at
 * clientonboarding.leadgenisys.com; the webhook stores the answers as
 * a ClientIntake and creates the Client. This page is built around
 * those answers: what they told us (read-only, as submitted) next to
 * what we manage — status, the site we built for them, internal notes.
 *
 * The appointment-era columns (packages, caps, sit-downs) are gone
 * with the booking business. Archive tucks a client away without
 * deleting anything.
 */

const ONBOARDING_FORM_URL = 'https://clientonboarding.leadgenisys.com/'

type Intake = {
  id: string
  receivedAt: string
  ein: string | null
  fullName: string | null
  businessName: string | null
  businessContact: string | null
  businessAddress: string | null
  customerPhone: string | null
  areaCode: string | null
  timeZone: string | null
  leadEmail: string | null
  cities: string | null
  website: string | null
  aboutBusiness: string | null
  mainServices: string | null
  promotions: string | null
  socialLinks: string | null
  whyChooseYou: string | null
  brandColors: string | null
  faqs: string | null
  bringingOwnDomain: string | null
  domainName: string | null
  hasGoogleProfile: string | null
  googleProfileLink: string | null
  yearStarted: string | null
  licenseInfo: string | null
  reviewLinks: string | null
  files: string[]
}

type RosterClient = {
  id: string
  name: string
  lifecycle: string
  contactName: string | null
  contactEmail: string | null
  contactPhone: string | null
  address: string | null
  website: string | null
  siteUrl: string | null
  notes: string | null
  onboardingNotes: string | null
  ghlSubaccountUrl: string | null
  createdAt: string
  archivedAt: string | null
  intake: Intake | null
  /** The client's own GHL sub-account, when the vault holds its token. */
  ghlSubAccount: { vaultName: string; locationId: string; locationName: string } | null
  /** The GitHub repo the client's site lives in, via their SEO site. */
  seo: { siteId: string; repoFullName: string | null } | null
}

type StatusFilter = 'all' | 'onboarding' | 'active' | 'paused' | 'churned'

const LIFECYCLE_LABEL: Record<string, string> = {
  active: 'Active',
  onboarding: 'Onboarding',
  paused: 'Paused',
  churned: 'Churned',
  pending: 'Pending review',
  denied: 'Denied',
}

/** Email allowed to delete clients. Mirrors the server gate in
 *  /api/clients/[id] DELETE; this only decides whether the button shows. */
const CLIENT_DELETE_AUTHORIZED_EMAIL = 'alex@leadgenisys.com'

const dateFmt = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  year: 'numeric',
})

function initials(name: string): string {
  const words = name.split(/\s+/).filter(Boolean)
  if (words.length === 0) return '?'
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase()
  return (words[0][0] + words[1][0]).toUpperCase()
}

function ownsDomain(i: Intake | null): boolean {
  return /^y(es)?$/i.test(i?.bringingOwnDomain ?? '')
}

function hostOf(url: string): string {
  try {
    return new URL(url).host.replace(/^www\./, '')
  } catch {
    return url
  }
}

function fileLabel(url: string, index: number): string {
  try {
    const name = decodeURIComponent(new URL(url).pathname.split('/').pop() ?? '')
    return name || `File ${index + 1}`
  } catch {
    return `File ${index + 1}`
  }
}

export default function ClientsPageRoute() {
  // useSearchParams needs a Suspense boundary for the static shell.
  return (
    <Suspense fallback={null}>
      <ClientsPage />
    </Suspense>
  )
}

function ClientsPage() {
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all')
  const [search, setSearch] = useState('')
  const [active, setActive] = useState<RosterClient | null>(null)
  const [editing, setEditing] = useState<ClientEditValues | null>(null)
  const [deleting, setDeleting] = useState<RosterClient | null>(null)
  const [archivedOpen, setArchivedOpen] = useState(false)
  const searchParams = useSearchParams()
  const router = useRouter()

  const sessionQuery = useQuery<{ user?: { email?: string | null } }>({
    queryKey: ['session'],
    queryFn: async () => {
      const res = await fetch('/api/auth/session')
      if (!res.ok) return {}
      return res.json()
    },
  })
  const canDelete =
    (sessionQuery.data?.user?.email ?? '').toLowerCase() ===
    CLIENT_DELETE_AUTHORIZED_EMAIL

  const query = useQuery<{ clients: RosterClient[] }>({
    queryKey: ['clients-roster'],
    queryFn: async () => {
      const res = await fetch('/api/clients/roster')
      if (!res.ok) throw new Error('Failed to load clients')
      return res.json()
    },
  })
  const clients = useMemo(() => query.data?.clients ?? [], [query.data])
  // Which client holds which repo, so the Repo dropdown can grey out taken ones.
  const repoOwners = useMemo(() => {
    const m = new Map<string, string>()
    for (const c of clients) if (c.seo?.repoFullName) m.set(c.seo.repoFullName.toLowerCase(), c.name)
    return m
  }, [clients])

  // ?focus=<id> (from the ⌘K palette) opens that client on arrival. It
  // is derived from the URL rather than copied into state; closing the
  // dialog clears the param so it doesn't reopen.
  const focusId = searchParams.get('focus')
  const focused = useMemo(
    () => (focusId ? clients.find((c) => c.id === focusId) ?? null : null),
    [focusId, clients],
  )
  const shown = active ?? focused
  const closeDetail = () => {
    setActive(null)
    if (focusId) router.replace('/clients')
  }

  const filtered = useMemo(() => {
    let list = clients
    if (statusFilter !== 'all') list = list.filter((c) => c.lifecycle === statusFilter)
    const tokens = search.trim().toLowerCase().split(/\s+/).filter(Boolean)
    if (tokens.length > 0) {
      list = list.filter((c) => {
        const i = c.intake
        const hay = [
          c.name, c.contactName, c.contactEmail, c.contactPhone,
          (c.contactPhone ?? '').replace(/\D/g, ''),
          c.address, c.website, c.siteUrl, c.lifecycle, c.notes,
          i?.cities, i?.timeZone, i?.domainName, i?.mainServices, i?.brandColors,
        ]
          .filter(Boolean)
          .join(' ')
          .toLowerCase()
        return tokens.every((t) => hay.includes(t))
      })
    }
    return list
  }, [clients, statusFilter, search])

  const roster = useMemo(() => filtered.filter((c) => !c.archivedAt), [filtered])
  const archived = useMemo(() => filtered.filter((c) => c.archivedAt), [filtered])

  // Stats describe the roster (archived excluded), unaffected by filters.
  const live = useMemo(() => clients.filter((c) => !c.archivedAt), [clients])
  const activeCount = live.filter((c) => c.lifecycle === 'active').length
  const onboardingCount = live.filter((c) => c.lifecycle === 'onboarding').length
  const sitesLive = live.filter((c) => c.siteUrl).length

  return (
    <div className="mx-auto flex max-w-[1320px] flex-col gap-6">
      <PageHeader
        title="Clients"
        subtitle="Onboarded through the client onboarding form."
        breadcrumbs={[{ label: 'Genisys' }, { label: 'Clients' }]}
        actions={
          <a
            href={ONBOARDING_FORM_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex h-9 items-center gap-2 rounded-lg border border-border bg-card px-3.5 text-[13px] font-medium text-foreground transition hover:bg-muted"
          >
            <ExternalLink className="h-3.5 w-3.5" /> Onboarding form
          </a>
        }
      />

      <OnboardingHealth />

      {/* Stats */}
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Stat label="Active" value={activeCount} sub="live and being served" />
        <Stat label="Onboarding" value={onboardingCount} sub="site in progress" />
        <Stat label="Sites live" value={sitesLive} sub={`of ${live.length} client${live.length === 1 ? '' : 's'}`} />
        <Stat label="Clients" value={live.length} sub={`${archived.length || clients.length - live.length} archived`} />
      </div>

      {/* Filters + search */}
      <div className="flex flex-wrap items-center gap-3">
        <DropdownPill
          value={statusFilter}
          options={[
            { id: 'all', label: 'All statuses' },
            { id: 'onboarding', label: 'Onboarding' },
            { id: 'active', label: 'Active' },
            { id: 'paused', label: 'Paused' },
            { id: 'churned', label: 'Churned' },
          ]}
          onChange={setStatusFilter}
        />
        <div className="relative min-w-[16rem] flex-1">
          <Search className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search business, contact, phone, email, cities, domain"
            aria-label="Search clients"
            className="h-9 w-full rounded-lg border border-border bg-card pl-10 pr-9 font-mono text-[12.5px] transition placeholder:text-muted-foreground/60 focus:border-foreground/30 focus:outline-none focus:ring-1 focus:ring-foreground/15"
          />
          {search && (
            <button
              type="button"
              onClick={() => setSearch('')}
              className="absolute right-2 top-1/2 grid h-6 w-6 -translate-y-1/2 place-items-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
              aria-label="Clear search"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
      </div>

      {/* Table */}
      {query.isLoading ? (
        <div className="flex items-center justify-center py-16">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        </div>
      ) : query.isError ? (
        <div className="rounded-xl border border-border bg-card p-6 text-sm text-destructive">
          Couldn&apos;t load the client list. Try refreshing.
        </div>
      ) : filtered.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border bg-card p-10 text-center">
          <Building2 className="mx-auto h-8 w-8 text-muted-foreground/50" />
          <p className="mt-3 text-sm text-muted-foreground">
            {clients.length === 0
              ? 'No clients yet. They appear here the moment someone submits the onboarding form.'
              : search.trim()
                ? `No clients match “${search.trim()}”.`
                : 'No clients match this filter.'}
          </p>
        </div>
      ) : (
        <div className="flex flex-col gap-8">
          <div className="overflow-x-auto rounded-xl border border-border">
            <table className="w-full min-w-[64rem] text-[13px]">
              <thead className="eyebrow bg-surface-muted text-left text-muted-foreground">
                <tr>
                  <th className="px-4 py-2.5">Client</th>
                  <th className="px-3 py-2.5">Contact</th>
                  <th className="px-3 py-2.5">Cities</th>
                  <th className="px-3 py-2.5">Time zone</th>
                  <th className="px-3 py-2.5">Domain</th>
                  <th className="px-3 py-2.5">Site</th>
                  <th className="px-3 py-2.5">Repo</th>
                  <th className="px-3 py-2.5">Status</th>
                  <th className="px-3 py-2.5">Onboarded</th>
                </tr>
              </thead>
              <tbody>
                {roster.length === 0 ? (
                  <tr>
                    <td colSpan={9} className="px-4 py-8 text-center text-muted-foreground">
                      Everything matching is archived.
                    </td>
                  </tr>
                ) : (
                  roster.map((c) => <ClientRow key={c.id} client={c} onOpen={setActive} repoOwners={repoOwners} />)
                )}
              </tbody>
            </table>
          </div>

          {archived.length > 0 && (
            <div>
              <button
                type="button"
                onClick={() => setArchivedOpen((v) => !v)}
                className="mb-3 flex w-full items-center gap-2 text-left"
              >
                {archivedOpen ? (
                  <ChevronDown className="h-4 w-4 text-muted-foreground" />
                ) : (
                  <ChevronRight className="h-4 w-4 text-muted-foreground" />
                )}
                <Archive className="h-3.5 w-3.5 text-muted-foreground/70" />
                <h3 className="eyebrow text-muted-foreground">Archived · {archived.length}</h3>
              </button>
              {archivedOpen && (
                <div className="overflow-x-auto rounded-xl border border-border opacity-60">
                  <table className="w-full min-w-[64rem] text-[13px]">
                    <tbody>
                      {archived.map((c) => (
                        <ClientRow key={c.id} client={c} onOpen={setActive} repoOwners={repoOwners} />
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      <ClientDetailDialog
        client={shown}
        onClose={closeDetail}
        onEdit={(c) => {
          closeDetail()
          setEditing({
            id: c.id,
            name: c.name,
            lifecycle: c.lifecycle,
            contactName: c.contactName ?? '',
            contactEmail: c.contactEmail ?? '',
            contactPhone: c.contactPhone ?? '',
            address: c.address ?? '',
            website: c.website ?? '',
            siteUrl: c.siteUrl ?? '',
            notes: c.notes ?? '',
          })
        }}
        canDelete={canDelete}
        onDelete={(c) => {
          closeDetail()
          setDeleting(c)
        }}
      />
      <ClientEditDialog
        key={editing?.id ?? 'none'}
        initial={editing}
        onClose={() => setEditing(null)}
      />
      <DeleteClientDialog
        key={deleting?.id ?? 'none'}
        client={deleting}
        onClose={() => setDeleting(null)}
      />
    </div>
  )
}

/* -------------------------------------------------------------------------- */

function Stat({ label, value, sub }: { label: string; value: number; sub: string }) {
  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <p className="eyebrow text-muted-foreground">{label}</p>
      <p className="mt-2.5 font-mono text-[26px] font-medium leading-none tracking-tight tabular-nums">
        {value}
      </p>
      <p className="mt-2 text-xs text-muted-foreground">{sub}</p>
    </div>
  )
}

function ClientRow({
  client,
  onOpen,
  repoOwners,
}: {
  client: RosterClient
  onOpen: (c: RosterClient) => void
  repoOwners: Map<string, string>
}) {
  const i = client.intake
  return (
    <tr
      onClick={() => onOpen(client)}
      className="cursor-pointer border-t border-border-soft transition hover:bg-surface-muted"
    >
      <td className="px-4 py-3">
        <div className="flex min-w-0 items-center gap-3">
          <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg border border-border bg-surface font-mono text-[12px] font-semibold">
            {initials(client.name)}
          </span>
          <div className="min-w-0">
            <p className="truncate font-medium">{client.name}</p>
            <p className="truncate text-xs text-muted-foreground">
              {client.contactName ?? i?.fullName ?? '—'}
            </p>
          </div>
        </div>
      </td>
      <td className="px-3 py-3 font-mono text-[12px]">
        <p className="whitespace-nowrap">{client.contactPhone ?? i?.customerPhone ?? '—'}</p>
        <p className="truncate text-muted-foreground">{client.contactEmail ?? i?.leadEmail ?? ''}</p>
      </td>
      <td className="max-w-[16rem] px-3 py-3">
        <span className="line-clamp-2 text-muted-foreground">{i?.cities ?? '—'}</span>
      </td>
      <td className="whitespace-nowrap px-3 py-3 text-muted-foreground">{i?.timeZone ?? '—'}</td>
      <td className="whitespace-nowrap px-3 py-3 font-mono text-[12px]">
        {i ? (
          ownsDomain(i) ? (
            <span>{i.domainName ?? 'Own domain'}</span>
          ) : (
            <span className="text-muted-foreground">We register</span>
          )
        ) : (
          <span className="text-muted-foreground/50">—</span>
        )}
      </td>
      <td className="px-3 py-3" onClick={(e) => e.stopPropagation()}>
        <SiteLink client={client} />
      </td>
      <td className="px-3 py-3" onClick={(e) => e.stopPropagation()}>
        <RepoSelect client={client} repoOwners={repoOwners} />
      </td>
      <td className="px-3 py-3" onClick={(e) => e.stopPropagation()}>
        <InlineStatus client={client} />
      </td>
      <td className="whitespace-nowrap px-3 py-3 font-mono text-[12px] text-muted-foreground">
        {dateFmt.format(new Date(client.intake?.receivedAt ?? client.createdAt))}
      </td>
    </tr>
  )
}

/* -------------------------------------------------------------------------- */

/**
 * The site we built. A link once it is set; an inline field to paste
 * it into until then. Enter saves, Esc cancels, clicking the pencil
 * reopens it for changes.
 */
function SiteLink({ client, size = 'sm' }: { client: RosterClient; size?: 'sm' | 'md' }) {
  const qc = useQueryClient()
  const [editing, setEditing] = useState(false)
  const [value, setValue] = useState(client.siteUrl ?? '')
  const inputRef = useRef<HTMLInputElement>(null)

  const save = useMutation({
    mutationFn: async (siteUrl: string) => {
      const res = await fetch(`/api/clients/${client.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ siteUrl }),
      })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        throw new Error(data.error || 'Failed to save')
      }
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['clients-roster'] })
      qc.invalidateQueries({ queryKey: ['clients'] })
      // The Home globe fires an arc for a newly live site.
      qc.invalidateQueries({ queryKey: ['home-globe'] })
      setEditing(false)
    },
  })

  function open() {
    setValue(client.siteUrl ?? '')
    setEditing(true)
    setTimeout(() => inputRef.current?.focus(), 0)
  }

  if (editing) {
    return (
      <form
        onSubmit={(e) => {
          e.preventDefault()
          save.mutate(value.trim())
        }}
        className="flex items-center gap-1.5"
      >
        <input
          ref={inputRef}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') setEditing(false)
          }}
          placeholder="https://"
          spellCheck={false}
          className={cn(
            'rounded-md border border-border bg-surface px-2 font-mono text-[12px] outline-none focus:border-foreground/30',
            size === 'sm' ? 'h-7 w-44' : 'h-9 w-72',
          )}
        />
        <button
          type="submit"
          disabled={save.isPending}
          className="grid h-7 w-7 place-items-center rounded-md border border-border text-foreground hover:bg-muted disabled:opacity-50"
          title="Save"
        >
          {save.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
        </button>
        <button
          type="button"
          onClick={() => setEditing(false)}
          className="grid h-7 w-7 place-items-center rounded-md text-muted-foreground hover:bg-muted"
          title="Cancel"
        >
          <X className="h-3.5 w-3.5" />
        </button>
        {save.isError && (
          <span className="text-xs text-destructive">{(save.error as Error).message}</span>
        )}
      </form>
    )
  }

  if (client.siteUrl) {
    return (
      <span className="group inline-flex items-center gap-1.5">
        <a
          href={client.siteUrl}
          target="_blank"
          rel="noopener noreferrer"
          className={cn(
            'inline-flex items-center gap-1.5 rounded-md border border-border bg-surface px-2 py-1 font-mono text-[12px] text-foreground transition hover:border-foreground/30',
            size === 'md' && 'px-2.5 py-1.5 text-[13px]',
          )}
          title={client.siteUrl}
        >
          <Globe className="h-3.5 w-3.5 text-muted-foreground" />
          {hostOf(client.siteUrl)}
          <ExternalLink className="h-3 w-3 text-muted-foreground/70" />
        </a>
        <button
          type="button"
          onClick={open}
          className="grid h-6 w-6 place-items-center rounded-md text-muted-foreground opacity-0 transition hover:bg-muted hover:text-foreground group-hover:opacity-100"
          title="Change link"
        >
          <Pencil className="h-3 w-3" />
        </button>
      </span>
    )
  }

  return (
    <button
      type="button"
      onClick={open}
      className={cn(
        'inline-flex items-center gap-1.5 rounded-md border border-dashed border-border px-2 py-1 font-mono text-[12px] text-muted-foreground transition hover:border-foreground/30 hover:text-foreground',
        size === 'md' && 'px-2.5 py-1.5 text-[13px]',
      )}
    >
      <Globe className="h-3.5 w-3.5" /> Add site link
    </button>
  )
}

type GithubRepo = { fullName: string; private: boolean; pushedAt: string | null }

/**
 * The GitHub repo the client's website lives in — a dropdown of the repos
 * on the agency's GitHub account, styled like the Site chip. Picking one
 * links the client's SEO site to it (and moves it from Audit to Review, so
 * the engine can open pull requests that a person approves).
 *
 * A native <select> on purpose: the table scrolls sideways, and a custom
 * popup would be clipped by that scroll area. Only people who can use SEO
 * can load the repo list; everyone else sees the repo as plain text.
 */
function RepoSelect({ client, repoOwners }: { client: RosterClient; repoOwners: Map<string, string> }) {
  const qc = useQueryClient()
  const current = client.seo?.repoFullName ?? ''

  const repos = useQuery<{ repos: GithubRepo[] }>({
    queryKey: ['seo-github-repos'],
    queryFn: async () => {
      const res = await fetch('/api/seo/github/repos')
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || `Could not load repos (${res.status})`)
      return data
    },
    staleTime: 5 * 60_000,
    retry: false,
  })

  const assign = useMutation({
    mutationFn: async (repoFullName: string) => {
      const res = await fetch(`/api/clients/${client.id}/repo`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ repoFullName: repoFullName || null }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || 'Failed to save')
      return data as { siteId: string; repoFullName: string | null }
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['clients-roster'] })
      qc.invalidateQueries({ queryKey: ['seo-overview'] })
    },
  })

  const short = (full: string) => full.split('/').pop() ?? full

  // Not allowed to manage repos (or GitHub isn't connected): show, don't edit.
  if (repos.isError || client.archivedAt) {
    return current ? (
      <span className="inline-flex items-center gap-1.5 rounded-md border border-border bg-surface px-2 py-1 font-mono text-[12px]" title={current}>
        <FolderGit2 className="h-3.5 w-3.5 text-muted-foreground" />
        {short(current)}
      </span>
    ) : (
      <span className="text-muted-foreground/50">—</span>
    )
  }

  const list = repos.data?.repos ?? []
  // Keep the current repo selectable even if the list hasn't loaded or no longer has it.
  const options =
    current && !list.some((r) => r.fullName.toLowerCase() === current.toLowerCase())
      ? [{ fullName: current, private: true, pushedAt: null }, ...list]
      : list
  const busy = assign.isPending || repos.isLoading

  return (
    <span className="group inline-flex items-center gap-1.5">
      <span
        className={cn(
          'relative inline-flex items-center rounded-md border font-mono text-[12px] transition focus-within:border-foreground/30 hover:border-foreground/30',
          current ? 'border-border bg-surface text-foreground' : 'border-dashed border-border text-muted-foreground hover:text-foreground',
          busy && 'opacity-60',
        )}
        title={current || 'Pick the GitHub repo this client’s site lives in'}
      >
        {assign.isPending ? (
          <Loader2 className="pointer-events-none absolute left-2 h-3.5 w-3.5 animate-spin" />
        ) : (
          <FolderGit2 className="pointer-events-none absolute left-2 h-3.5 w-3.5 text-muted-foreground" />
        )}
        <select
          value={current}
          disabled={busy}
          onChange={(e) => {
            const next = e.target.value
            if (next === current) return
            if (!next && !window.confirm(`Unlink ${short(current)} from ${client.name}? The SEO engine goes back to audit-only for this client.`)) return
            assign.mutate(next)
          }}
          className="max-w-[11rem] cursor-pointer appearance-none truncate bg-transparent py-1 pl-7 pr-6 focus:outline-none"
        >
          <option value="">{current ? 'No repo' : 'Assign repo'}</option>
          {options.map((r) => {
            const owner = repoOwners.get(r.fullName.toLowerCase())
            const taken = !!owner && owner !== client.name
            return (
              <option key={r.fullName} value={r.fullName} disabled={taken}>
                {short(r.fullName)}
                {taken ? ` — ${owner}` : ''}
              </option>
            )
          })}
        </select>
        <ChevronDown className="pointer-events-none absolute right-1.5 h-3 w-3 text-muted-foreground" />
      </span>
      {current && client.seo?.siteId && (
        <a
          href={`/seo/${client.seo.siteId}`}
          className="grid h-6 w-6 place-items-center rounded-md text-muted-foreground opacity-0 transition hover:bg-muted hover:text-foreground group-hover:opacity-100"
          title="Open this client in SEO"
        >
          <TrendingUp className="h-3 w-3" />
        </a>
      )}
      {assign.isError && <span className="text-xs text-destructive">{(assign.error as Error).message}</span>}
    </span>
  )
}

/** Native <select> styled as a chip. Optimistic update, revert on error. */
function InlineStatus({ client }: { client: RosterClient }) {
  const qc = useQueryClient()
  const mutation = useMutation({
    mutationFn: async (lifecycle: string) => {
      const res = await fetch(`/api/clients/${client.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ lifecycle }),
      })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        throw new Error(data.error || 'Failed to update status')
      }
      return lifecycle
    },
    onMutate: async (next) => {
      await qc.cancelQueries({ queryKey: ['clients-roster'] })
      const previous = qc.getQueryData<{ clients: RosterClient[] }>(['clients-roster'])
      if (previous) {
        qc.setQueryData<{ clients: RosterClient[] }>(['clients-roster'], {
          clients: previous.clients.map((c) => (c.id === client.id ? { ...c, lifecycle: next } : c)),
        })
      }
      return { previous }
    },
    onError: (_e, _n, ctx) => {
      if (ctx?.previous) qc.setQueryData(['clients-roster'], ctx.previous)
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['clients'] }),
  })

  const pickable = LIFECYCLES.some((l) => l.id === client.lifecycle)
  if (!pickable) {
    return <Chip>{LIFECYCLE_LABEL[client.lifecycle] ?? client.lifecycle}</Chip>
  }

  return (
    <select
      value={client.lifecycle}
      disabled={mutation.isPending}
      onChange={(e) => mutation.mutate(e.target.value)}
      title="Change status"
      className={cn(
        'eyebrow cursor-pointer appearance-none rounded-md border px-2 py-1 focus:outline-none focus:ring-1 focus:ring-foreground/30',
        client.lifecycle === 'active'
          ? 'border-border bg-surface text-foreground'
          : 'border-transparent bg-muted text-muted-foreground',
        mutation.isPending && 'opacity-60',
      )}
    >
      {LIFECYCLES.map((l) => (
        <option key={l.id} value={l.id}>
          {l.label}
        </option>
      ))}
    </select>
  )
}

/* -------------------------------------------------------------------------- */

function ClientDetailDialog({
  client,
  onClose,
  onEdit,
  canDelete,
  onDelete,
}: {
  client: RosterClient | null
  onClose: () => void
  onEdit: (c: RosterClient) => void
  canDelete: boolean
  onDelete: (c: RosterClient) => void
}) {
  const qc = useQueryClient()

  useEffect(() => {
    if (!client) return
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [client, onClose])

  const archive = useMutation({
    mutationFn: async ({ id, archived }: { id: string; archived: boolean }) => {
      const res = await fetch(`/api/clients/${id}/archive`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ archived }),
      })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        throw new Error(data.error || 'Failed to update client')
      }
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['clients-roster'] })
      qc.invalidateQueries({ queryKey: ['clients'] })
      onClose()
    },
  })

  if (!client) return null
  const i = client.intake

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/60 p-4 pt-[6vh] backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="flex w-full max-w-3xl flex-col gap-6 rounded-xl border border-border bg-popover p-6 text-popover-foreground shadow-pop"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex items-center gap-3">
            <span className="grid h-11 w-11 place-items-center rounded-lg border border-border bg-surface font-mono text-[13px] font-semibold">
              {initials(client.name)}
            </span>
            <div>
              <h2 className="text-lg font-semibold tracking-tight">{client.name}</h2>
              <p className="mt-0.5 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                <span>{client.contactName ?? i?.fullName ?? 'No contact name'}</span>
                <span>·</span>
                <Chip>{LIFECYCLE_LABEL[client.lifecycle] ?? client.lifecycle}</Chip>
                {client.archivedAt && <Chip>Archived</Chip>}
              </p>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            <button
              type="button"
              onClick={() => onEdit(client)}
              className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-card px-3 py-1.5 text-xs font-medium transition hover:bg-muted"
            >
              <Pencil className="h-3.5 w-3.5" /> Edit
            </button>
            <button
              type="button"
              disabled={archive.isPending}
              onClick={() => archive.mutate({ id: client.id, archived: !client.archivedAt })}
              className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-card px-3 py-1.5 text-xs font-medium transition hover:bg-muted disabled:opacity-50"
              title={client.archivedAt ? 'Bring this client back onto the roster' : 'Archive — hides from the roster; nothing is deleted'}
            >
              {client.archivedAt ? <ArchiveRestore className="h-3.5 w-3.5" /> : <Archive className="h-3.5 w-3.5" />}
              {client.archivedAt ? 'Unarchive' : 'Archive'}
            </button>
            {canDelete && (
              <button
                type="button"
                onClick={() => onDelete(client)}
                className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-card px-3 py-1.5 text-xs font-medium text-muted-foreground transition hover:border-destructive/40 hover:text-destructive"
                title="Delete this client (admin password required)"
              >
                <Trash2 className="h-3.5 w-3.5" /> Delete
              </button>
            )}
            <button
              type="button"
              onClick={onClose}
              className="grid h-7 w-7 place-items-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
              aria-label="Close"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>

        {/* Website — ours and theirs */}
        <Section label="Website">
          <div className="flex flex-wrap items-center gap-x-8 gap-y-3">
            <Field label="Site we built">
              <SiteLink client={client} size="md" />
            </Field>
            <Field label="Domain">
              {i
                ? ownsDomain(i)
                  ? <span className="font-mono text-[13px]">{i.domainName ?? 'Bringing their own'}</span>
                  : <span className="text-muted-foreground">None — we register one</span>
                : <span className="text-muted-foreground/50">—</span>}
            </Field>
            {(client.website ?? i?.website) && (
              <Field label="Their existing site">
                <span className="font-mono text-[13px]">{client.website ?? i?.website}</span>
              </Field>
            )}
            <Field label="GHL sub-account">
              {client.ghlSubAccount ? (
                <span className="flex flex-col">
                  <span className="font-mono text-[13px]">{client.ghlSubAccount.locationName}</span>
                  <span className="font-mono text-[11px] text-muted-foreground">
                    {client.ghlSubAccount.vaultName}
                  </span>
                </span>
              ) : (
                <span className="text-muted-foreground" title='Add the token to the Vault tagged "ghl" and "client"; name it after the business or put client=<name> in its description.'>
                  Not linked
                </span>
              )}
              {client.ghlSubaccountUrl && (
                <a
                  href={client.ghlSubaccountUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="ml-2 inline-flex items-center gap-1 text-[13px] text-primary hover:underline"
                >
                  Open <ExternalLink className="h-3 w-3" />
                </a>
              )}
            </Field>
          </div>
        </Section>

        {/* Contact */}
        <Section label="Contact">
          <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-2 lg:grid-cols-3">
            <Row label="Contact name" value={client.contactName ?? i?.fullName} />
            <Row label="Phone" value={client.contactPhone ?? i?.customerPhone} mono />
            <Row label="Email" value={client.contactEmail ?? i?.leadEmail} mono />
            <Row label="Business contact" value={i?.businessContact} mono />
            <Row label="Address" value={client.address ?? i?.businessAddress} span />
            <Row label="Area code" value={i?.areaCode} mono />
            <Row label="Time zone" value={i?.timeZone} />
            <Row label="EIN" value={i?.ein} mono />
          </dl>
        </Section>

        {/* What they told us */}
        <Section label="Onboarding answers" hint={i ? `submitted ${dateFmt.format(new Date(i.receivedAt))}` : 'no intake linked'}>
          {i ? (
            <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-2">
              <Row label="Cities served" value={i.cities} span />
              <Row label="Main services" value={i.mainServices} span />
              <Row label="About the business" value={i.aboutBusiness} span />
              <Row label="Why choose them" value={i.whyChooseYou} span />
              <Row label="Promotions" value={i.promotions} />
              <Row label="Brand colours" value={i.brandColors} />
              <Row label="Social" value={i.socialLinks} span />
              <Row
                label="Google Business Profile"
                value={i.googleProfileLink ?? (i.hasGoogleProfile ? `${i.hasGoogleProfile} — no link given` : null)}
                span
              />
              <Row label="Review sites" value={i.reviewLinks} span />
              <Row label="Started" value={i.yearStarted} />
              <Row label="License" value={i.licenseInfo} />
              <Row label="FAQs" value={i.faqs} span />
            </dl>
          ) : (
            <p className="text-sm text-muted-foreground">
              This client was created before the onboarding form existed. Their next
              submission will attach here automatically.
              {client.onboardingNotes && (
                <span className="mt-2 block whitespace-pre-wrap text-foreground/85">{client.onboardingNotes}</span>
              )}
            </p>
          )}
        </Section>

        {/* Files */}
        {i && i.files.length > 0 && (
          <Section label="Files" hint={`${i.files.length} upload${i.files.length === 1 ? '' : 's'}`}>
            <ul className="flex flex-col gap-1.5">
              {i.files.map((url, n) => (
                <li key={url}>
                  <a
                    href={url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-2 font-mono text-[12.5px] text-primary hover:underline"
                  >
                    <FileText className="h-3.5 w-3.5 text-muted-foreground" />
                    {fileLabel(url, n)}
                  </a>
                </li>
              ))}
            </ul>
          </Section>
        )}

        {/* Notes */}
        {client.notes && (
          <Section label="Internal notes">
            <p className="whitespace-pre-wrap text-sm text-foreground/85">{client.notes}</p>
          </Section>
        )}
      </div>
    </div>
  )
}

function Section({
  label,
  hint,
  children,
}: {
  label: string
  hint?: string
  children: React.ReactNode
}) {
  return (
    <section className="rounded-xl border border-border-soft bg-surface p-4">
      <div className="mb-3 flex items-baseline justify-between gap-3">
        <p className="eyebrow text-muted-foreground">{label}</p>
        {hint && <p className="font-mono text-[11px] text-muted-foreground/70">{hint}</p>}
      </div>
      {children}
    </section>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="eyebrow text-muted-foreground/80">{label}</span>
      <span>{children}</span>
    </div>
  )
}

function Row({
  label,
  value,
  mono,
  span,
}: {
  label: string
  value: string | null | undefined
  mono?: boolean
  span?: boolean
}) {
  return (
    <div className={cn(span && 'sm:col-span-2 lg:col-span-3')}>
      <dt className="eyebrow text-muted-foreground/80">{label}</dt>
      <dd
        className={cn(
          'mt-0.5 text-sm',
          mono && 'font-mono text-[13px]',
          value ? 'whitespace-pre-wrap break-words text-foreground' : 'text-muted-foreground/50',
        )}
      >
        {value || 'Not provided'}
      </dd>
    </div>
  )
}

/* -------------------------------------------------------------------------- */

function DeleteClientDialog({
  client,
  onClose,
}: {
  client: RosterClient | null
  onClose: () => void
}) {
  const qc = useQueryClient()
  // Mounted fresh per client (keyed by the parent), so a previous
  // failed attempt's typo never carries over.
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!client) return
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [client, onClose])

  const del = useMutation({
    mutationFn: async (vars: { clientId: string; password: string }) => {
      const res = await fetch(`/api/clients/${vars.clientId}`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: vars.password }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || `Delete failed (${res.status})`)
      return data as { deleted: { name: string } }
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['clients-roster'] })
      qc.invalidateQueries({ queryKey: ['clients'] })
      onClose()
    },
    onError: (err) => setError((err as Error).message),
  })

  if (!client) return null

  return (
    // Backdrop intentionally NOT click-to-close: losing a half-typed
    // password to a stray click is worse than the convenience.
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/60 p-4 pt-[10vh] backdrop-blur-sm">
      <form
        onSubmit={(e) => {
          e.preventDefault()
          if (!password.trim()) {
            setError('Password is required.')
            return
          }
          del.mutate({ clientId: client.id, password: password.trim() })
        }}
        className="flex w-full max-w-md flex-col gap-4 rounded-xl border border-border bg-popover p-6 text-popover-foreground shadow-pop"
      >
        <div className="flex items-start gap-3">
          <div className="rounded-lg bg-destructive/10 p-2">
            <AlertTriangle className="h-5 w-5 text-destructive" />
          </div>
          <div className="flex-1">
            <h3 className="text-base font-semibold">Delete &ldquo;{client.name}&rdquo;?</h3>
            <p className="mt-1 text-xs text-muted-foreground">
              Permanent. The client record, its routing config and its link to the
              onboarding intake all go. If you just want it out of the way, Archive
              does that without losing anything.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="grid h-7 w-7 place-items-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <label className="flex flex-col gap-1.5">
          <span className="eyebrow text-muted-foreground">Admin password</span>
          <input
            autoFocus
            type="password"
            value={password}
            onChange={(e) => {
              setPassword(e.target.value)
              if (error) setError(null)
            }}
            placeholder="From the vault entry “Client Delete Password”"
            className="h-9 rounded-md border border-border bg-surface px-3 text-sm focus:border-destructive/60 focus:outline-none"
            autoComplete="off"
          />
          {error && <p className="text-xs text-destructive">{error}</p>}
        </label>

        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={del.isPending}
            className="rounded-lg px-3 py-2 text-[13px] font-medium text-muted-foreground hover:bg-muted disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={!password.trim() || del.isPending}
            className="inline-flex items-center gap-1.5 rounded-lg bg-destructive px-3 py-2 text-[13px] font-medium text-destructive-foreground transition hover:bg-destructive/90 disabled:opacity-50"
          >
            {del.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
            Delete client
          </button>
        </div>
      </form>
    </div>
  )
}
