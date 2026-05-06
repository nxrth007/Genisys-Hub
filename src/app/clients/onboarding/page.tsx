'use client'

/**
 * Client onboarding hub.
 *
 * Two tabs (per Alex's spec):
 *   - "Pending" — self-registered clients awaiting approval (Phase 2;
 *     placeholder content for Phase 1 so the tab exists and the user
 *     understands what's coming).
 *   - "Credentials" — admin manages /client login accounts. Phase 1
 *     scope: pick a client, click "Generate login", we provision a
 *     temp password and email it to them. Same button works as a
 *     password reset.
 */
import { useState } from 'react'
import Link from 'next/link'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  ArrowLeft,
  KeyRound,
  Loader2,
  Mail,
  Send,
  Hourglass,
  AlertCircle,
  CheckCircle2,
  RefreshCcw,
  Copy,
  Check,
} from 'lucide-react'
import { PageHeader } from '@/components/ui/page-header'

type Client = {
  id: string
  name: string
  state: string | null
  color: string
  contactName: string | null
  contactEmail: string | null
  package: string
  lifecycle: string
}

type ClientUser = {
  id: string
  email: string
  name: string | null
  role: string
  mustChangePassword: boolean
  createdAt: string
  updatedAt: string
} | null

type Tab = 'pending' | 'credentials'

export default function ClientOnboardingPage() {
  const [tab, setTab] = useState<Tab>('credentials')

  return (
    <div className="mx-auto flex max-w-[1280px] flex-col gap-6">
      <PageHeader
        title="Client onboarding"
        breadcrumbs={[
          { label: 'Genisys' },
          { label: 'Clients', href: '/clients' },
          { label: 'Onboarding' },
        ]}
        actions={
          <Link
            href="/clients"
            className="inline-flex items-center gap-1.5 rounded-full border border-border bg-card px-4 py-2 text-sm font-medium text-foreground transition hover:bg-muted"
          >
            <ArrowLeft className="h-4 w-4" /> Back to clients
          </Link>
        }
      />

      {/* Tab strip */}
      <div className="flex items-center gap-1 border-b border-border">
        <TabButton
          active={tab === 'pending'}
          onClick={() => setTab('pending')}
          icon={Hourglass}
        >
          Pending
        </TabButton>
        <TabButton
          active={tab === 'credentials'}
          onClick={() => setTab('credentials')}
          icon={KeyRound}
        >
          Credentials
        </TabButton>
      </div>

      {tab === 'pending' ? <PendingTab /> : <CredentialsTab />}
    </div>
  )
}

function TabButton({
  active,
  onClick,
  icon: Icon,
  children,
}: {
  active: boolean
  onClick: () => void
  icon: React.ComponentType<{ className?: string }>
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`-mb-px inline-flex items-center gap-2 border-b-2 px-4 py-2.5 text-sm font-medium transition ${
        active
          ? 'border-primary text-primary'
          : 'border-transparent text-muted-foreground hover:text-foreground'
      }`}
    >
      <Icon className="h-4 w-4" />
      {children}
    </button>
  )
}

/** Phase-2 placeholder. Self-registration form + approve/deny flow
 *  ships in the next iteration; for Phase 1 we just signal that the
 *  tab is reserved so admin doesn't think it's broken. */
function PendingTab() {
  return (
    <div className="rounded-2xl border border-dashed border-border bg-card p-10 text-center">
      <Hourglass className="mx-auto h-10 w-10 text-muted-foreground/50" />
      <p className="mt-3 text-sm font-medium">
        Self-onboarding launches next phase
      </p>
      <p className="mt-1 max-w-md mx-auto text-xs text-muted-foreground">
        Once clients can self-register at /signin/client/register, their
        applications will appear here for you to approve or deny — same
        flow as the agents page. For now, use the Credentials tab to
        provision logins for existing clients.
      </p>
    </div>
  )
}

function CredentialsTab() {
  const { data, isLoading, error } = useQuery<{
    clients: Client[]
  }>({
    queryKey: ['clients-onboarding'],
    queryFn: async () => {
      const res = await fetch('/api/clients/with-counts')
      if (!res.ok) throw new Error('Failed to load clients')
      const json = (await res.json()) as { clients: Client[] }
      return json
    },
  })

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-16">
        <Loader2 className="h-6 w-6 animate-spin text-primary" />
      </div>
    )
  }
  if (error) {
    return (
      <div className="rounded-2xl border border-border bg-card p-6 text-sm text-destructive">
        Couldn&apos;t load clients. Try refreshing.
      </div>
    )
  }
  const clients = (data?.clients ?? []).filter(
    (c) => c.lifecycle !== 'churned',
  )

  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground">
        Generate a /client login for any client below. We email the
        temporary password to the client&apos;s contact email; on first
        sign-in they&apos;re forced to pick their own. Click the same
        button later to reset a forgotten password.
      </p>
      <div className="overflow-hidden rounded-2xl border border-border bg-card">
        <ul className="divide-y divide-border">
          {clients.map((c) => (
            <CredentialsRow key={c.id} client={c} />
          ))}
        </ul>
        {clients.length === 0 && (
          <div className="py-12 text-center text-sm text-muted-foreground">
            No active clients. Add one from /clients first.
          </div>
        )}
      </div>
    </div>
  )
}

function CredentialsRow({ client }: { client: Client }) {
  const qc = useQueryClient()
  const [tempPassword, setTempPassword] = useState<string | null>(null)
  const [emailSent, setEmailSent] = useState<boolean | null>(null)
  const [copied, setCopied] = useState(false)

  const userQuery = useQuery<{ user: ClientUser }>({
    queryKey: ['client-user', client.id],
    queryFn: async () => {
      const res = await fetch(`/api/clients/${client.id}/credentials`)
      if (!res.ok) throw new Error('Failed to load login info')
      return res.json()
    },
  })

  const generate = useMutation({
    mutationFn: async () => {
      const res = await fetch(`/api/clients/${client.id}/credentials`, {
        method: 'POST',
      })
      const json = (await res.json().catch(() => ({}))) as {
        tempPassword?: string
        emailSent?: boolean
        error?: string
      }
      if (!res.ok) throw new Error(json.error || 'Failed to generate login')
      return json
    },
    onSuccess: (data) => {
      setTempPassword(data.tempPassword ?? null)
      setEmailSent(data.emailSent ?? false)
      qc.invalidateQueries({ queryKey: ['client-user', client.id] })
    },
  })

  const user = userQuery.data?.user
  const hasLogin = !!user

  function copyPassword() {
    if (!tempPassword) return
    navigator.clipboard.writeText(tempPassword).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    })
  }

  return (
    <li className="px-5 py-4">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span
              className="h-2.5 w-2.5 rounded-full"
              style={{ backgroundColor: client.color }}
              aria-hidden
            />
            <p className="truncate text-sm font-semibold">{client.name}</p>
            {client.state && (
              <span className="text-xs text-muted-foreground">
                · {client.state}
              </span>
            )}
            <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
              {client.package}
            </span>
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
            <span className="inline-flex items-center gap-1">
              <Mail className="h-3 w-3" />
              {client.contactEmail || (
                <span className="italic">no contact email on file</span>
              )}
            </span>
            {client.contactName && (
              <span>· {client.contactName}</span>
            )}
          </div>
          {/* Login state pill */}
          <div className="mt-2 flex items-center gap-2">
            {userQuery.isLoading ? (
              <span className="text-[11px] text-muted-foreground">
                Checking login status…
              </span>
            ) : hasLogin ? (
              <span className="inline-flex items-center gap-1.5 rounded-full border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-[11px] font-medium text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950 dark:text-emerald-300">
                <CheckCircle2 className="h-3 w-3" />
                {user!.mustChangePassword
                  ? 'Login active · awaiting first sign-in'
                  : 'Login active'}
              </span>
            ) : (
              <span className="inline-flex items-center gap-1.5 rounded-full border border-zinc-200 bg-zinc-50 px-2 py-0.5 text-[11px] font-medium text-zinc-600 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-300">
                No login yet
              </span>
            )}
            {user && (
              <span className="text-[11px] text-muted-foreground">
                {user.email}
              </span>
            )}
          </div>
        </div>

        <div className="flex flex-shrink-0 items-center gap-2">
          <button
            type="button"
            onClick={() => generate.mutate()}
            disabled={generate.isPending || !client.contactEmail}
            className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground transition hover:bg-primary/90 disabled:opacity-50"
            title={
              !client.contactEmail
                ? 'Add a contact email first'
                : hasLogin
                  ? 'Reset password and re-email it'
                  : 'Generate login and email password'
            }
          >
            {generate.isPending ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : hasLogin ? (
              <RefreshCcw className="h-3 w-3" />
            ) : (
              <Send className="h-3 w-3" />
            )}
            {hasLogin ? 'Reset password' : 'Generate login'}
          </button>
        </div>
      </div>

      {/* Just-generated password — surfaced inline so admin can copy
          it if the email send failed for any reason. Clears as soon
          as admin navigates away or generates a new one. */}
      {tempPassword && (
        <div className="mt-3 rounded-md border border-blue-200 bg-blue-50 p-3 text-xs dark:border-blue-900 dark:bg-blue-950">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2 font-medium text-blue-800 dark:text-blue-200">
              <KeyRound className="h-3.5 w-3.5" />
              Temporary password generated
            </div>
            {emailSent === false && (
              <span className="inline-flex items-center gap-1 text-amber-700 dark:text-amber-300">
                <AlertCircle className="h-3 w-3" />
                Email send failed — copy and send manually
              </span>
            )}
            {emailSent === true && (
              <span className="text-blue-700 dark:text-blue-300">
                Emailed to {client.contactEmail}
              </span>
            )}
          </div>
          <div className="mt-2 flex items-center gap-2">
            <code className="flex-1 rounded bg-white px-2 py-1 font-mono text-xs dark:bg-blue-900">
              {tempPassword}
            </code>
            <button
              type="button"
              onClick={copyPassword}
              className="inline-flex items-center gap-1 rounded-md border border-blue-200 bg-white px-2 py-1 text-[11px] font-medium text-blue-700 hover:bg-blue-100 dark:border-blue-800 dark:bg-blue-900 dark:text-blue-200"
            >
              {copied ? (
                <Check className="h-3 w-3" />
              ) : (
                <Copy className="h-3 w-3" />
              )}
              {copied ? 'Copied' : 'Copy'}
            </button>
          </div>
        </div>
      )}
      {generate.isError && (
        <div className="mt-3 rounded-md border border-red-200 bg-red-50 p-2 text-xs text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-300">
          {(generate.error as Error).message}
        </div>
      )}
    </li>
  )
}
