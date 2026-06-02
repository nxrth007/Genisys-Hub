'use client'

/**
 * Client polymorphic dashboard — single destination, content adapts to role.
 *
 * As of 2026-05-11 the flow inverted (Alex + Ethan): payment first,
 * onboarding form AFTER admin approves. So /client now renders one of
 * four states depending on the signed-in user's role + Client state:
 *
 *   client_pending, no Client row yet    → PrePayPlanPicker
 *     "Welcome, pick a plan + business name to get started"
 *
 *   client_pending, Client row exists    → PrePayAwaitingApproval
 *     "We have your plan selection. Pay via the link below, then
 *      admin will approve your account once payment lands."
 *
 *   client_onboarding                    → OnboardingFormView
 *     "You're approved — fill out a few business details so we know
 *      how to qualify leads for you. Submitting takes you live."
 *
 *   client_active                        → TrackerView
 *     The original /client tracker — appointments list, search,
 *     stats, sign-out button.
 *
 * Middleware enforces that only these four roles ever reach this page
 * (client_denied bounces to /signin/client/denied; everyone else
 * doesn't get past the middleware check above this layer).
 */

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Fragment, useEffect, useMemo, useState } from 'react'
import {
  Building2,
  Calendar,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Clock,
  CreditCard,
  ExternalLink,
  Eye,
  Info,
  Loader2,
  LogOut,
  Play,
  Search,
  Sparkles,
  Trophy,
  UserCircle2,
  X,
  XCircle,
} from 'lucide-react'
import Link from 'next/link'
import { signOut } from 'next-auth/react'
import { AddressInput } from '@/components/ui/address-input'
import { formatPhoneInput } from '@/lib/phone'
import { cn } from '@/lib/utils'

/* -------------------------------------------------------------------------- */
/*  Shared types                                                              */
/* -------------------------------------------------------------------------- */

type MeUser = {
  id: string
  email: string | null
  name: string | null
  role: string
}

type MeClient = {
  id: string
  name: string
  state: string | null
  package: string
  lifecycle: string
  contactName: string | null
  apptCap: number | null
  slackChannelId: string | null
  slackChannelName: string | null
}

type MeResponse = {
  user: MeUser
  client: MeClient | null
}

type Appointment = {
  id: string
  apptDateTime: string
  customerName: string
  customerPhone: string
  address: string | null
  email: string | null
  monthlyBill: string | null
  utilityProvider: string | null
  roofType: string | null
  roofAge: string | null
  status: string
  estimatedDealValue: string | null
  notes: string | null
  bookedByName: string | null
  /** Client-side notes captured when they last hit "Update status"
   *  on this appointment from the dashboard. Distinct from `notes`
   *  (which is Mary's notes) so neither perspective overwrites
   *  the other. */
  clientNotes: string | null
  /** Timestamp of the last client-side status update. Drives the
   *  "Updated X ago" line on the appointment card so the client
   *  can tell what they've already touched. Null when they've
   *  never updated this one. */
  clientStatusUpdatedAt: string | null
  /** Client's answer to the "Customer Disqualified?" follow-up
   *  question, asked when outcome === 'showed'. true = sat down
   *  but prospect didn't qualify; false = qualified; null = no
   *  answer yet. Used to pre-fill the modal when the client
   *  re-opens an already-reported appointment. */
  customerDisqualified: boolean | null
  createdAt: string
  /** Signed Hub-proxy URL for the call recording. Null when the
   *  appointment has no recording on file OR the recording proxy
   *  isn't configured yet (RECORDING_PROXY_SECRET unset). The raw
   *  vicitel URL is stripped server-side and never reaches the
   *  client — we only ever see the signed proxy URL. */
  recordingUrl: string | null
}

/* -------------------------------------------------------------------------- */
/*  Root dispatcher                                                           */
/* -------------------------------------------------------------------------- */

export default function ClientHomePage() {
  const meQuery = useQuery<MeResponse>({
    queryKey: ['client-me'],
    queryFn: async () => {
      const res = await fetch('/api/client/me')
      if (!res.ok) {
        const d = await res.json().catch(() => ({}))
        throw new Error(d.error || 'Failed to load your account')
      }
      return res.json()
    },
    // Re-poll every 15s while on a pre-active state so the page can
    // transition to the next view the moment admin approves (or the
    // user re-picks a plan). Doesn't matter once the user is active —
    // the tracker view has its own query that handles refresh.
    refetchInterval: 15_000,
    refetchIntervalInBackground: false,
  })

  if (meQuery.isLoading) {
    return (
      <FullPageState>
        <Loader2 className="h-6 w-6 animate-spin text-zinc-400" />
      </FullPageState>
    )
  }

  if (meQuery.isError || !meQuery.data) {
    return (
      <FullPageState>
        <div className="text-center text-sm text-red-600">
          {(meQuery.error as Error)?.message ?? 'Failed to load your account'}
        </div>
      </FullPageState>
    )
  }

  const { user, client } = meQuery.data

  return (
    <div className="min-h-screen bg-zinc-50 dark:bg-zinc-950">
      <DashboardHeader
        title={client?.name ?? 'Your Lead Genisys account'}
        subtitle={subtitleFor(user.role)}
        slackChannel={
          client?.slackChannelId
            ? {
                id: client.slackChannelId,
                name: client.slackChannelName,
              }
            : null
        }
        showAccountLink={user.role === 'client_active'}
      />
      <main className="mx-auto max-w-7xl px-4 py-6 sm:px-6">
        {user.role === 'client_pending' && !client && (
          <PrePayPlanPicker
            user={user}
            onComplete={() => meQuery.refetch()}
          />
        )}
        {user.role === 'client_pending' && client && (
          <PrePayAwaitingApproval
            client={client}
            onChangePlan={() => meQuery.refetch()}
          />
        )}
        {user.role === 'client_onboarding' && (
          <OnboardingFormView
            user={user}
            client={client}
            onComplete={() => meQuery.refetch()}
          />
        )}
        {user.role === 'client_active' && <TrackerView />}
      </main>
    </div>
  )
}

function subtitleFor(role: string): string {
  switch (role) {
    case 'client_pending':
      return 'Pick a plan to get started'
    case 'client_onboarding':
      return 'One last step before your dashboard goes live'
    case 'client_active':
      return 'Booked appointments delivered to your business'
    default:
      return ''
  }
}

/* -------------------------------------------------------------------------- */
/*  Shared chrome                                                             */
/* -------------------------------------------------------------------------- */

function DashboardHeader({
  title,
  subtitle,
  slackChannel,
  showAccountLink,
}: {
  title: string
  subtitle: string
  slackChannel: { id: string; name: string | null } | null
  /** Hide the My Account pill while the client is mid-funnel
   *  (pending/onboarding) — they don't have a real account view yet
   *  and the page would feel confusing. Only surface it once active. */
  showAccountLink: boolean
}) {
  // Slack universal redirect URL: works in app + browser regardless of
  // which workspace they're signed into. Clients almost always forget
  // they have a private channel with us, so surfacing it here cuts
  // support tickets ("hey how do I reach you?" → "click the pill").
  const slackUrl = slackChannel
    ? `https://slack.com/app_redirect?channel=${slackChannel.id}`
    : null
  return (
    <header className="border-b border-zinc-200 bg-white px-4 py-4 sm:px-6 dark:border-zinc-800 dark:bg-zinc-900">
      <div className="mx-auto flex max-w-7xl items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <Building2 className="h-5 w-5 shrink-0 text-blue-600" />
          <div className="min-w-0">
            <h1 className="truncate text-sm font-semibold">{title}</h1>
            <p className="truncate text-[11px] text-zinc-500">{subtitle}</p>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {slackUrl && (
            <a
              href={slackUrl}
              target="_blank"
              rel="noopener noreferrer"
              title={
                slackChannel?.name
                  ? `Open #${slackChannel.name} in Slack`
                  : 'Open your Slack channel'
              }
              className="hidden items-center gap-1.5 rounded-md border border-violet-200 bg-violet-50 px-3 py-1.5 text-xs font-medium text-violet-700 hover:bg-violet-100 sm:inline-flex dark:border-violet-900 dark:bg-violet-950 dark:text-violet-200 dark:hover:bg-violet-900"
            >
              <span aria-hidden>#</span>
              <span className="max-w-[120px] truncate">
                {slackChannel?.name ?? 'Slack channel'}
              </span>
              <ExternalLink className="h-3 w-3" />
            </a>
          )}
          {slackUrl && (
            <a
              href={slackUrl}
              target="_blank"
              rel="noopener noreferrer"
              title="Open Slack"
              aria-label="Open Slack channel"
              className="inline-flex items-center justify-center rounded-md border border-violet-200 bg-violet-50 px-2 py-1.5 text-violet-700 hover:bg-violet-100 sm:hidden dark:border-violet-900 dark:bg-violet-950 dark:text-violet-200"
            >
              <span className="text-xs font-semibold leading-none" aria-hidden>
                #
              </span>
            </a>
          )}
          {showAccountLink && (
            <Link
              href="/client/account"
              title="My account — profile + change password"
              className="inline-flex items-center gap-1.5 rounded-md border border-zinc-200 bg-white px-3 py-1.5 text-xs font-medium text-zinc-700 hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200 dark:hover:bg-zinc-800"
            >
              <UserCircle2 className="h-3.5 w-3.5" />
              <span className="hidden sm:inline">My account</span>
            </Link>
          )}
          <button
            onClick={() => signOut({ callbackUrl: '/signin/client' })}
            className="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-zinc-200 bg-white px-3 py-1.5 text-xs font-medium text-zinc-700 hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200 dark:hover:bg-zinc-800"
          >
            <LogOut className="h-3.5 w-3.5" />
            <span className="hidden sm:inline">Sign out</span>
          </button>
        </div>
      </div>
    </header>
  )
}

function FullPageState({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-zinc-50 dark:bg-zinc-950">
      {children}
    </div>
  )
}

/* -------------------------------------------------------------------------- */
/*  Pre-pay: pick a plan                                                      */
/* -------------------------------------------------------------------------- */

type PaymentOption = {
  id: 'ppa' | 'growth_full' | 'growth_half'
  tier: 'ppa' | 'growth'
  label: string
  sub: string
  href: string
}

/** QuickBooks payment links — same set the old /signin/client/payment
 *  page used. Surfaced inline in the pre-pay view so the user can pay
 *  without leaving /client. */
const PAYMENT_OPTIONS: PaymentOption[] = [
  {
    id: 'ppa',
    tier: 'ppa',
    label: 'Pay-per-appointment',
    sub: 'Pay only for appointments delivered',
    href: 'https://connect.intuit.com/portal/app/CommerceNetwork/view/scs-v1-79be52eea5f14990ae7878c815bfe43016f70066400b4087900960429a5fec5ad357b2a3317d436ba8641e17294e32b9?locale=EN_US&cta=copylistmultilink',
  },
  {
    id: 'growth_full',
    tier: 'growth',
    label: 'Growth Pack — Pay in full',
    sub: '20 appointments upfront, full payment',
    href: 'https://connect.intuit.com/portal/app/CommerceNetwork/view/scs-v1-0be6ac9dd5284657844ac4bdc6a1979df1225b9fb03e4ef68904c5c7e34e7e514ca7733b77c74779be562b19b1a8d296?locale=EN_US&cta=copylistmultilink',
  },
  {
    id: 'growth_half',
    tier: 'growth',
    label: 'Growth Pack — Pay 50% upfront',
    sub: 'Half upfront, half on delivery',
    href: 'https://connect.intuit.com/portal/app/CommerceNetwork/view/scs-v1-a75df6c170b84feab5937e150c73a7adeedef7763faa4938b1f4a8a457fdcc41fb2c2c1498dc48a193a3b94381cbfacf?locale=EN_US&cta=copylistmultilink',
  },
]

function PrePayPlanPicker({
  user,
  onComplete,
}: {
  user: MeUser
  onComplete: () => void
}) {
  const [businessName, setBusinessName] = useState('')
  const [picked, setPicked] = useState<PaymentOption | null>(null)
  const [error, setError] = useState<string | null>(null)
  /** Set when the prospect ticks "I have already paid" — they still
   *  need to pick which plan they paid for (so admin + the Client
   *  row both know which package to provision), but clicking the
   *  plan button skips the QuickBooks redirect and just marks the
   *  selection for admin to verify against an existing payment. */
  const [alreadyPaid, setAlreadyPaid] = useState(false)

  const submit = useMutation({
    mutationFn: async (opt: PaymentOption) => {
      const res = await fetch('/api/client/select-plan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          businessName,
          tier: opt.tier,
          paymentOption: opt.id,
          alreadyPaid,
        }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Failed to save plan')
      return data
    },
    onSuccess: (_data, opt) => {
      // Default flow: open the QuickBooks link in a new tab right
      // after saving the plan choice. Skipped when the prospect
      // ticked "I have already paid" — they don't need to pay
      // again; admin verifies their existing payment + approves.
      if (!alreadyPaid) {
        window.open(opt.href, '_blank', 'noopener,noreferrer')
      }
      onComplete()
    },
    onError: (err) => {
      setError((err as Error).message)
    },
  })

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <WelcomeBanner
        message="Pick a plan + tell us your business name to get started. Payment opens in a new tab — your account manager approves you once it lands."
      />

      <section className="space-y-3 rounded-2xl border border-zinc-200 bg-white p-5 shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
        <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-zinc-500">
          <Building2 className="h-3.5 w-3.5" />
          Step 1 — Your business
        </div>
        <input
          type="text"
          value={businessName}
          onChange={(e) => setBusinessName(e.target.value)}
          placeholder="Your business name"
          autoFocus
          className="w-full rounded-md border border-zinc-200 bg-white px-3 py-2 text-sm focus:border-blue-500 focus:outline-none dark:border-zinc-700 dark:bg-zinc-900"
        />
      </section>

      <section className="space-y-3 rounded-2xl border border-zinc-200 bg-white p-5 shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
        <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-zinc-500">
          <CreditCard className="h-3.5 w-3.5" />
          Step 2 — Pick a plan
        </div>
        <div className="grid grid-cols-1 gap-2.5">
          {PAYMENT_OPTIONS.map((opt) => (
            <button
              key={opt.id}
              type="button"
              disabled={!businessName.trim() || submit.isPending}
              onClick={() => {
                setError(null)
                setPicked(opt)
                submit.mutate(opt)
              }}
              className="group flex items-start gap-3 rounded-lg border border-zinc-200 bg-white p-3 text-left transition hover:border-blue-400 hover:bg-blue-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-zinc-700 dark:bg-zinc-900 dark:hover:bg-blue-950/30"
            >
              {alreadyPaid ? (
                <CheckCircle2 className="mt-0.5 h-4 w-4 flex-shrink-0 text-emerald-600" />
              ) : (
                <CreditCard className="mt-0.5 h-4 w-4 flex-shrink-0 text-blue-600" />
              )}
              <div className="min-w-0 flex-1">
                <div className="text-sm font-semibold">{opt.label}</div>
                <div className="mt-0.5 text-xs text-zinc-500">{opt.sub}</div>
              </div>
              {submit.isPending && picked?.id === opt.id ? (
                <Loader2 className="h-4 w-4 flex-shrink-0 animate-spin text-blue-600" />
              ) : alreadyPaid ? (
                <span className="text-[10px] font-semibold uppercase tracking-wider text-emerald-600">
                  Submit
                </span>
              ) : (
                <ExternalLink className="h-3.5 w-3.5 flex-shrink-0 text-zinc-400 transition group-hover:text-blue-600" />
              )}
            </button>
          ))}
        </div>

        {/* "I have already paid" toggle — for prospects who paid via
            an out-of-band channel (Stripe link, wire, prior QuickBooks
            invoice, etc.). Same plan choice flow, but skips the
            QuickBooks redirect and tags the Client row so admin
            verifies the existing payment before approving. */}
        <label className="flex items-start gap-2 rounded-lg border border-zinc-200 bg-zinc-50 p-3 text-xs dark:border-zinc-700 dark:bg-zinc-900/60">
          <input
            type="checkbox"
            checked={alreadyPaid}
            onChange={(e) => setAlreadyPaid(e.target.checked)}
            className="mt-0.5 h-3.5 w-3.5 rounded border-zinc-300 accent-emerald-600"
          />
          <span className="flex-1 leading-relaxed text-zinc-700 dark:text-zinc-300">
            <span className="font-semibold">I have already paid for this plan.</span>{' '}
            Pick the plan you paid for above — we&apos;ll mark your account
            for verification by your account manager instead of sending you
            back to QuickBooks.
          </span>
        </label>

        <p className="text-[11px] text-zinc-500">
          {alreadyPaid
            ? 'Picking a plan submits your selection for admin verification. No payment page will open.'
            : 'Clicking a plan saves your selection and opens the secure QuickBooks payment page in a new tab. After payment lands, your account manager approves your account.'}
        </p>
        {error && (
          <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-200">
            {error}
          </div>
        )}
      </section>

      <TrackerPreview />
    </div>
  )
}

/* -------------------------------------------------------------------------- */
/*  Pre-pay: awaiting approval                                                */
/* -------------------------------------------------------------------------- */

function PrePayAwaitingApproval({
  client,
  onChangePlan,
}: {
  client: MeClient
  onChangePlan: () => void
}) {
  // Find which QB link matches the saved package, so the user can
  // re-open it if they closed the tab or want to verify the link.
  const matchingPaymentOption = PAYMENT_OPTIONS.find(
    (o) => o.tier === client.package,
  )

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <section className="space-y-3 rounded-2xl border border-blue-200 bg-blue-50 p-5 dark:border-blue-900 dark:bg-blue-950/40">
        <div className="flex items-center gap-2">
          <Clock className="h-5 w-5 text-blue-600" />
          <h2 className="text-base font-semibold text-blue-900 dark:text-blue-200">
            Awaiting approval
          </h2>
        </div>
        <p className="text-sm text-blue-900/80 dark:text-blue-200/80">
          We have your plan selection on file (
          <strong>{PACKAGE_LABEL[client.package] ?? client.package}</strong>
          ). Once payment is confirmed, your account manager will approve
          your account and you&apos;ll fill out a few business details to
          take your dashboard live.
        </p>
      </section>

      {matchingPaymentOption && (
        <section className="space-y-3 rounded-2xl border border-zinc-200 bg-white p-5 shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
          <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-zinc-500">
            <CreditCard className="h-3.5 w-3.5" />
            Your payment link
          </div>
          <a
            href={matchingPaymentOption.href}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex w-full items-center justify-center gap-2 rounded-lg bg-blue-600 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-blue-700"
          >
            <CreditCard className="h-4 w-4" />
            Open {matchingPaymentOption.label}
            <ExternalLink className="h-3.5 w-3.5" />
          </a>
          <p className="text-[11px] text-zinc-500">
            Opens QuickBooks in a new tab. If you&apos;ve already paid,
            you can ignore this — your account manager will approve you
            shortly.
          </p>
          <button
            type="button"
            onClick={onChangePlan}
            className="text-[11px] text-zinc-500 hover:text-zinc-700 hover:underline dark:hover:text-zinc-300"
          >
            Or change your plan →
          </button>
        </section>
      )}

      <TrackerPreview />
    </div>
  )
}

const PACKAGE_LABEL: Record<string, string> = {
  ppa: 'Pay-per-appointment',
  growth: 'Growth Pack',
  pro: 'Pro Pack',
  custom: 'Custom',
}

/* -------------------------------------------------------------------------- */
/*  Preview of the tracker (faded "this is what you're paying for")           */
/* -------------------------------------------------------------------------- */

function TrackerPreview() {
  const [open, setOpen] = useState(false)
  return (
    <>
      <section className="relative overflow-hidden rounded-2xl border border-zinc-200 bg-white shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
        <div className="border-b border-zinc-200 px-5 py-3 dark:border-zinc-800">
          <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-zinc-500">
            <Sparkles className="h-3.5 w-3.5" />
            Preview — your dashboard once you&apos;re live
          </div>
        </div>
        <div className="relative">
          <div className="pointer-events-none opacity-40">
            <div className="grid grid-cols-2 gap-3 px-5 py-4 md:grid-cols-4">
              <PreviewStat label="Total" value="—" />
              <PreviewStat label="Upcoming" value="—" />
              <PreviewStat label="Showed" value="—" tone="green" />
              <PreviewStat label="No-show" value="—" tone="rose" />
            </div>
            <div className="border-t border-zinc-100 dark:border-zinc-800">
              <table className="hidden w-full text-sm md:table">
                <thead className="border-b border-zinc-200 bg-zinc-50 text-[11px] uppercase tracking-wide text-zinc-500 dark:border-zinc-800 dark:bg-zinc-950">
                  <tr>
                    <th className="px-4 py-2 text-left font-semibold">Date</th>
                    <th className="px-4 py-2 text-left font-semibold">Customer</th>
                    <th className="px-4 py-2 text-left font-semibold">Phone</th>
                    <th className="px-4 py-2 text-left font-semibold">Address</th>
                    <th className="px-4 py-2 text-left font-semibold">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {Array.from({ length: 3 }).map((_, i) => (
                    <tr key={i} className="border-b border-zinc-100 dark:border-zinc-800">
                      <td className="px-4 py-2 text-zinc-400">———</td>
                      <td className="px-4 py-2 text-zinc-400">———</td>
                      <td className="px-4 py-2 text-zinc-400">———</td>
                      <td className="px-4 py-2 text-zinc-400">———</td>
                      <td className="px-4 py-2 text-zinc-400">———</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
          <div className="absolute inset-0 flex items-center justify-center bg-gradient-to-b from-transparent via-white/70 to-white dark:via-zinc-900/70 dark:to-zinc-900">
            <button
              type="button"
              onClick={() => setOpen(true)}
              className="inline-flex items-center gap-1.5 rounded-full bg-blue-600 px-4 py-2 text-xs font-semibold text-white shadow-md transition hover:bg-blue-700 hover:shadow-lg"
            >
              <Eye className="h-3.5 w-3.5" />
              Preview
            </button>
          </div>
        </div>
      </section>
      {open && <PreviewWalkthroughModal onClose={() => setOpen(false)} />}
    </>
  )
}

/* -------------------------------------------------------------------------- */
/*  Preview walkthrough modal — interactive mockup of the live tracker        */
/* -------------------------------------------------------------------------- */

/** Sample appointments for the preview. Deliberately fictional (555
 *  phone numbers, generic names + addresses) so it's clearly a demo,
 *  not someone's real data. Mix of statuses so the client sees what
 *  each state looks like — including the Won/Lost row outcomes they
 *  can mark themselves. */
const PREVIEW_APPOINTMENTS: Array<{
  id: string
  date: string
  customerName: string
  phone: string
  address: string
  bill: string
  utility: string
  status: 'booked' | 'rescheduled' | 'showed' | 'won' | 'lost' | 'no_show'
}> = [
  {
    id: 'demo-1',
    date: 'Tomorrow, 2:00 PM',
    customerName: 'Sarah Johnson',
    phone: '(555) 412-9087',
    address: '142 Oak Avenue',
    bill: '$245/mo',
    utility: 'Con Edison',
    status: 'booked',
  },
  {
    id: 'demo-2',
    date: 'Thu, 10:30 AM',
    customerName: 'Mike Chen',
    phone: '(555) 803-2241',
    address: '88 Maple Street',
    bill: '$312/mo',
    utility: 'PG&E',
    status: 'booked',
  },
  {
    id: 'demo-3',
    date: 'Fri, 4:00 PM',
    customerName: 'Linda Rodriguez',
    phone: '(555) 654-1108',
    address: '27 Cedar Lane',
    bill: '$178/mo',
    utility: 'Duke Energy',
    status: 'rescheduled',
  },
  {
    id: 'demo-4',
    date: 'Last Mon, 1:00 PM',
    customerName: 'David Park',
    phone: '(555) 290-7762',
    address: '519 Birch Road',
    bill: '$398/mo',
    utility: 'Con Edison',
    status: 'showed',
  },
  {
    id: 'demo-5',
    date: 'Last Wed, 11:00 AM',
    customerName: 'Jennifer Wallace',
    phone: '(555) 117-4493',
    address: '903 Pine Boulevard',
    bill: '$267/mo',
    utility: 'Eversource',
    status: 'won',
  },
  {
    id: 'demo-6',
    date: 'Last Fri, 3:30 PM',
    customerName: 'Robert Kim',
    phone: '(555) 776-5520',
    address: '64 Elm Court',
    bill: '$201/mo',
    utility: 'PG&E',
    status: 'lost',
  },
]

function PreviewWalkthroughModal({ onClose }: { onClose: () => void }) {
  // Local-only state so clicking Won/Lost in the preview actually
  // toggles — gives the client a tactile sense of how they'll mark
  // outcomes. Nothing hits the API.
  const [statuses, setStatuses] = useState<Record<string, string>>(() =>
    Object.fromEntries(PREVIEW_APPOINTMENTS.map((a) => [a.id, a.status])),
  )

  // Close on ESC. Click-outside is handled by the backdrop onClick.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    // Lock scroll while modal is open so the page underneath doesn't
    // jiggle behind the backdrop.
    const prevOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.removeEventListener('keydown', onKey)
      document.body.style.overflow = prevOverflow
    }
  }, [onClose])

  const markOutcome = (id: string, outcome: 'won' | 'lost' | 'clear') => {
    setStatuses((s) => ({
      ...s,
      [id]: outcome === 'clear' ? 'showed' : outcome,
    }))
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/60 px-4 py-6 backdrop-blur-sm sm:py-10"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="Live dashboard preview"
    >
      <div
        className="relative w-full max-w-5xl rounded-2xl bg-white shadow-2xl dark:bg-zinc-900"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Modal header */}
        <div className="sticky top-0 z-10 flex items-center justify-between gap-3 rounded-t-2xl border-b border-zinc-200 bg-white px-5 py-4 dark:border-zinc-800 dark:bg-zinc-900">
          <div className="min-w-0">
            <h2 className="text-sm font-semibold sm:text-base">
              Your live dashboard — interactive preview
            </h2>
            <p className="text-[11px] text-zinc-500">
              Sample data. This is exactly how the page will look once we
              start booking for you.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close preview"
            className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-zinc-200 bg-white text-zinc-600 hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300 dark:hover:bg-zinc-800"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="space-y-6 px-5 py-5 sm:px-6 sm:py-6">
          {/* Demo banner */}
          <div className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200">
            <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>
              All names, phone numbers, and appointments below are fake
              demo data. Your real dashboard will populate as we book
              appointments for your business.
            </span>
          </div>

          {/* Headline stats — same shape as live TrackerView */}
          <div>
            <PreviewAnnotation
              text="Three numbers that always sit up top — how this month is going at a glance."
            />
            <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
              <StatCard label="This month" value={12} />
              <StatCard label="Show rate" value="83%" tone="green" />
              <StatCard label="Next 7 days" value={3} />
            </div>
          </div>

          {/* Upcoming-this-week callout */}
          <div>
            <PreviewAnnotation
              text="When you have appointments coming up in the next 7 days, they're called out here so you can prep."
            />
            <div className="rounded-xl border border-blue-200 bg-blue-50 p-3 text-xs dark:border-blue-900 dark:bg-blue-950/50">
              <div className="mb-1.5 flex items-center gap-1.5 font-semibold text-blue-800 dark:text-blue-200">
                <Calendar className="h-3.5 w-3.5" />
                Coming up this week
              </div>
              <ul className="space-y-1 text-blue-900 dark:text-blue-100">
                <li className="flex flex-wrap items-baseline gap-x-2 tabular-nums">
                  <span className="font-medium">Tomorrow, 2:00 PM</span>
                  <span className="text-blue-700 dark:text-blue-300">·</span>
                  <span>Sarah Johnson</span>
                  <span className="text-blue-700 dark:text-blue-300">·</span>
                  <span className="text-blue-700 dark:text-blue-300">
                    142 Oak Avenue
                  </span>
                </li>
                <li className="flex flex-wrap items-baseline gap-x-2 tabular-nums">
                  <span className="font-medium">Thu, 10:30 AM</span>
                  <span className="text-blue-700 dark:text-blue-300">·</span>
                  <span>Mike Chen</span>
                  <span className="text-blue-700 dark:text-blue-300">·</span>
                  <span className="text-blue-700 dark:text-blue-300">
                    88 Maple Street
                  </span>
                </li>
                <li className="flex flex-wrap items-baseline gap-x-2 tabular-nums">
                  <span className="font-medium">Fri, 4:00 PM</span>
                  <span className="text-blue-700 dark:text-blue-300">·</span>
                  <span>Linda Rodriguez</span>
                  <span className="text-blue-700 dark:text-blue-300">·</span>
                  <span className="text-blue-700 dark:text-blue-300">
                    27 Cedar Lane
                  </span>
                </li>
              </ul>
            </div>
          </div>

          {/* Appointment table */}
          <div>
            <PreviewAnnotation
              text="Every appointment we book for you lands here in real time. Showed-up appointments get a Won/Lost button so you can mark deal outcomes yourself — try it below."
            />
            <div className="rounded-xl border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900">
              <table className="hidden w-full text-sm md:table">
                <thead className="border-b border-zinc-200 bg-zinc-50 text-[11px] uppercase tracking-wide text-zinc-500 dark:border-zinc-800 dark:bg-zinc-950">
                  <tr>
                    <th className="px-4 py-2 text-left font-semibold">Date</th>
                    <th className="px-4 py-2 text-left font-semibold">Customer</th>
                    <th className="px-4 py-2 text-left font-semibold">Phone</th>
                    <th className="px-4 py-2 text-left font-semibold">Address</th>
                    <th className="px-4 py-2 text-left font-semibold">Bill</th>
                    <th className="px-4 py-2 text-left font-semibold">Utility</th>
                    <th className="px-4 py-2 text-left font-semibold">Status</th>
                    <th className="px-4 py-2 text-left font-semibold">Outcome</th>
                  </tr>
                </thead>
                <tbody>
                  {PREVIEW_APPOINTMENTS.map((a) => {
                    const status = statuses[a.id] ?? a.status
                    return (
                      <tr
                        key={a.id}
                        className="border-b border-zinc-100 last:border-0 hover:bg-zinc-50 dark:border-zinc-800 dark:hover:bg-zinc-950/50"
                      >
                        <td className="px-4 py-2 tabular-nums">{a.date}</td>
                        <td className="px-4 py-2 font-medium">
                          {a.customerName}
                        </td>
                        <td className="px-4 py-2 tabular-nums">{a.phone}</td>
                        <td className="px-4 py-2 text-xs text-zinc-600 dark:text-zinc-400">
                          {a.address}
                        </td>
                        <td className="px-4 py-2 tabular-nums">{a.bill}</td>
                        <td className="px-4 py-2">{a.utility}</td>
                        <td className="px-4 py-2">
                          <StatusBadge status={status} />
                        </td>
                        <td className="px-4 py-2">
                          <OutcomeActions
                            status={status}
                            pending={false}
                            onMark={(outcome) => markOutcome(a.id, outcome)}
                          />
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>

              {/* Mobile card list — same as live TrackerView */}
              <ul className="divide-y divide-zinc-100 md:hidden dark:divide-zinc-800">
                {PREVIEW_APPOINTMENTS.map((a) => {
                  const status = statuses[a.id] ?? a.status
                  return (
                    <li key={a.id} className="px-4 py-3">
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-sm font-semibold">
                            {a.customerName}
                          </p>
                          <p className="mt-0.5 text-xs tabular-nums text-zinc-500">
                            {a.date}
                          </p>
                        </div>
                        <StatusBadge status={status} />
                      </div>
                      <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-[11px]">
                        <div className="col-span-2">
                          <dt className="text-zinc-400">Address</dt>
                          <dd className="text-zinc-600 dark:text-zinc-300">
                            {a.address}
                          </dd>
                        </div>
                        <div>
                          <dt className="text-zinc-400">Phone</dt>
                          <dd className="tabular-nums text-zinc-600 dark:text-zinc-300">
                            {a.phone}
                          </dd>
                        </div>
                        <div>
                          <dt className="text-zinc-400">Bill</dt>
                          <dd className="tabular-nums text-zinc-600 dark:text-zinc-300">
                            {a.bill}
                          </dd>
                        </div>
                        <div className="col-span-2">
                          <dt className="text-zinc-400">Utility</dt>
                          <dd className="text-zinc-600 dark:text-zinc-300">
                            {a.utility}
                          </dd>
                        </div>
                      </dl>
                      {(status === 'showed' ||
                        status === 'won' ||
                        status === 'lost') && (
                        <div className="mt-3 flex justify-end">
                          <OutcomeActions
                            status={status}
                            pending={false}
                            onMark={(outcome) => markOutcome(a.id, outcome)}
                          />
                        </div>
                      )}
                    </li>
                  )
                })}
              </ul>
            </div>
          </div>

          {/* What you'll see when live — quick recap */}
          <div className="rounded-xl border border-zinc-200 bg-zinc-50 p-4 text-xs dark:border-zinc-800 dark:bg-zinc-950/50">
            <div className="mb-2 flex items-center gap-1.5 font-semibold text-zinc-700 dark:text-zinc-300">
              <Sparkles className="h-3.5 w-3.5 text-blue-600" />
              What you&apos;ll see once we start booking
            </div>
            <ul className="space-y-1.5 text-zinc-600 dark:text-zinc-400">
              <li className="flex gap-2">
                <span className="text-blue-600">·</span>
                <span>
                  Appointments appear here in real time as soon as we
                  book them on a call.
                </span>
              </li>
              <li className="flex gap-2">
                <span className="text-blue-600">·</span>
                <span>
                  Full customer details: name, phone, address, bill
                  amount, utility — everything you need to walk in
                  prepared.
                </span>
              </li>
              <li className="flex gap-2">
                <span className="text-blue-600">·</span>
                <span>
                  Mark Won / Lost yourself after each appointment so your
                  show rate + outcomes stay accurate.
                </span>
              </li>
              <li className="flex gap-2">
                <span className="text-blue-600">·</span>
                <span>
                  A private Slack channel with your account manager opens
                  the moment you go live — no support tickets, just chat.
                </span>
              </li>
            </ul>
          </div>

          {/* Close CTA at the bottom for thumb reach on mobile */}
          <div className="flex justify-end">
            <button
              type="button"
              onClick={onClose}
              className="inline-flex items-center gap-1.5 rounded-md bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700"
            >
              Got it
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

/** Small inline callout that explains what the next section is. Sits
 *  above each major block in the preview modal so the client knows
 *  what they're looking at without us having to do a full multi-step
 *  tour overlay. */
function PreviewAnnotation({ text }: { text: string }) {
  return (
    <div className="mb-2 flex items-start gap-1.5 text-[11px] text-zinc-500 dark:text-zinc-400">
      <Info className="mt-0.5 h-3 w-3 shrink-0 text-blue-500" />
      <span>{text}</span>
    </div>
  )
}

function PreviewStat({
  label,
  value,
  tone,
}: {
  label: string
  value: string
  tone?: 'green' | 'rose'
}) {
  const color =
    tone === 'green'
      ? 'text-emerald-500/60'
      : tone === 'rose'
        ? 'text-rose-500/60'
        : 'text-zinc-400'
  return (
    <div className="rounded-xl border border-zinc-200 bg-white p-3 dark:border-zinc-800 dark:bg-zinc-900">
      <p className="text-[10px] uppercase tracking-wide text-zinc-400">
        {label}
      </p>
      <p className={`mt-1 text-xl font-bold ${color}`}>{value}</p>
    </div>
  )
}

/* -------------------------------------------------------------------------- */
/*  Welcome banner                                                            */
/* -------------------------------------------------------------------------- */

function WelcomeBanner({
  message,
}: {
  message: string
}) {
  // No personalization — fresh registrants don't have a name on file
  // yet (they only entered email + password at /signin/client/register),
  // so the fallback was always "there" which read awkwardly. Cleaner
  // to greet generically until they fill out the onboarding form,
  // where the post-active TrackerView shows their business name in
  // the header anyway.
  return (
    <section className="rounded-2xl border border-zinc-200 bg-gradient-to-br from-blue-50 to-white p-5 dark:border-zinc-800 dark:from-blue-950/40 dark:to-zinc-900">
      <div className="flex items-center gap-2">
        <Sparkles className="h-5 w-5 text-blue-600" />
        <h2 className="text-lg font-semibold">
          Hello, Welcome to Lead Genisys
        </h2>
      </div>
      <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-400">{message}</p>
    </section>
  )
}

/* -------------------------------------------------------------------------- */
/*  Onboarding form view (post-approval)                                      */
/* -------------------------------------------------------------------------- */

function OnboardingFormView({
  user,
  client,
  onComplete,
}: {
  user: MeUser
  client: MeClient | null
  onComplete: () => void
}) {
  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <section className="rounded-2xl border border-emerald-200 bg-emerald-50 p-5 dark:border-emerald-900 dark:bg-emerald-950/40">
        <div className="flex items-center gap-2">
          <CheckCircle2 className="h-5 w-5 text-emerald-600" />
          <h2 className="text-base font-semibold text-emerald-900 dark:text-emerald-200">
            You&apos;re approved!
          </h2>
        </div>
        <p className="mt-2 text-sm text-emerald-900/80 dark:text-emerald-200/80">
          Last step — tell us a bit about your business so we know how to
          qualify leads for you. Submitting takes your dashboard live and
          appointments will start showing up here in real time.
        </p>
      </section>

      <ClientOnboardingForm
        defaultBusinessName={client?.name ?? ''}
        defaultPackage={client?.package ?? 'growth'}
        defaultEmail={user.email ?? ''}
        onComplete={onComplete}
      />
    </div>
  )
}

/** The actual onboarding form (extracted from the legacy
 *  /signin/client/onboarding-form/page.tsx so /client can render it
 *  inline). Same fields, same validation, just rendered as a section
 *  inside the dashboard instead of a standalone funnel page. */
function ClientOnboardingForm({
  defaultBusinessName,
  defaultPackage,
  defaultEmail,
  onComplete,
}: {
  defaultBusinessName: string
  defaultPackage: string
  defaultEmail: string
  onComplete: () => void
}) {
  const [businessName, setBusinessName] = useState(defaultBusinessName)
  const [state, setState] = useState('')
  const [tier, setTier] = useState(defaultPackage)
  const [fullName, setFullName] = useState('')
  const [role, setRole] = useState('')
  const [phone, setPhone] = useState('')
  const [address, setAddress] = useState('')
  const [servicingZipcodes, setServicingZipcodes] = useState('')
  const [appointmentTypes, setAppointmentTypes] = useState<
    'in_person' | 'virtual' | 'both' | ''
  >('')
  const [bookWeekends, setBookWeekends] = useState<'yes' | 'no' | ''>('')
  const [website, setWebsite] = useState('')
  const [providesBatteryBackup, setProvidesBatteryBackup] = useState<
    'yes' | 'no' | ''
  >('')
  const [email, setEmail] = useState('')
  const [qualificationCriteria, setQualificationCriteria] = useState('')
  const [onboardingNotes, setOnboardingNotes] = useState('')
  const [error, setError] = useState<string | null>(null)

  const submit = useMutation({
    mutationFn: async () => {
      const res = await fetch('/api/client/onboarding-form', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          businessName,
          state,
          tier,
          fullName,
          role,
          phone,
          address,
          servicingZipcodes,
          appointmentTypes,
          bookWeekends: bookWeekends === 'yes',
          website,
          providesBatteryBackup: providesBatteryBackup === 'yes',
          email,
          qualificationCriteria,
          onboardingNotes,
        }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || 'Failed to submit')
      return data
    },
    onSuccess: () => {
      // Trigger a /me refetch so the role flip lands; the dispatcher
      // then renders TrackerView automatically.
      onComplete()
    },
    onError: (err) => setError((err as Error).message),
  })

  const canSubmit =
    !!businessName.trim() &&
    !!fullName.trim() &&
    !!phone.trim() &&
    !!address.trim() &&
    !!tier &&
    !!appointmentTypes &&
    !!bookWeekends &&
    !!providesBatteryBackup &&
    !submit.isPending

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        if (!canSubmit) return
        setError(null)
        submit.mutate()
      }}
      className="space-y-3 rounded-2xl border border-zinc-200 bg-white p-5 shadow-sm dark:border-zinc-800 dark:bg-zinc-900"
    >
      <Field label="Business name" required>
        <input
          type="text"
          value={businessName}
          onChange={(e) => setBusinessName(e.target.value)}
          required
          className="input"
        />
      </Field>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label="Your full name" required>
          <input
            type="text"
            value={fullName}
            onChange={(e) => setFullName(e.target.value)}
            required
            autoComplete="name"
            className="input"
          />
        </Field>
        <Field label="Your role" hint="e.g. Owner, VP Sales">
          <input
            type="text"
            value={role}
            onChange={(e) => setRole(e.target.value)}
            className="input"
          />
        </Field>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label="Phone" required>
          <input
            type="tel"
            value={phone}
            // Live formatter: strip everything but digits, then group
            // into (XXX) XXX-XXXX as they type. Same helper the agent
            // booking form uses. Clients can paste any format (dashes,
            // dots, "+1") and it normalizes through the same path.
            onChange={(e) => setPhone(formatPhoneInput(e.target.value))}
            required
            autoComplete="tel"
            placeholder="(555) 123-4567"
            className="input"
          />
        </Field>
        <Field label="State" hint="e.g. Arizona">
          <input
            type="text"
            value={state}
            onChange={(e) => setState(e.target.value)}
            className="input"
          />
        </Field>
      </div>

      <Field
        label="Business email"
        hint={`Defaults to ${defaultEmail || 'your sign-in email'} if blank.`}
      >
        <input
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="info@yourcompany.com"
          autoComplete="email"
          className="input"
        />
      </Field>

      <Field
        label="Business address"
        hint={
          state.trim()
            ? `Suggestions filtered to ${state.trim()}.`
            : 'Fill in your State above to filter suggestions.'
        }
        required
      >
        {/* Google Places autocomplete (Nominatim fallback when the
            Google Maps Key vault entry isn't configured). The
            endpoint prop points at the client-onboarding-allowed
            proxy so prospects with role=client_onboarding can use it
            without bumping the agent-only middleware rules. State
            value above is passed as the bias so a client in Arizona
            doesn't see Florida addresses in the dropdown. */}
        <AddressInput
          value={address}
          onChange={setAddress}
          endpoint="/api/client/maps/places"
          stateBias={state}
          requireStreet
          placeholder="Start typing — e.g. 123 Main St Phoenix AZ"
        />
      </Field>

      <Field
        label="Servicing zipcodes"
        hint="Comma-separated. We use this to route appointments your way."
      >
        <input
          type="text"
          value={servicingZipcodes}
          onChange={(e) => setServicingZipcodes(e.target.value)}
          placeholder="85001, 85002, 85003"
          className="input"
        />
      </Field>

      <Field label="Appointment types you accept" required>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
          {(
            [
              { id: 'in_person', label: 'In-person' },
              { id: 'virtual', label: 'Virtual' },
              { id: 'both', label: 'Both' },
            ] as const
          ).map((opt) => (
            <button
              key={opt.id}
              type="button"
              onClick={() => setAppointmentTypes(opt.id)}
              className={`rounded-md border p-2.5 text-center text-xs font-semibold transition ${
                appointmentTypes === opt.id
                  ? 'border-blue-500 bg-blue-50 dark:bg-blue-950'
                  : 'border-zinc-200 bg-white hover:bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-900 dark:hover:bg-zinc-800'
              }`}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </Field>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label="Book during weekends?" required>
          <YesNoToggle value={bookWeekends} onChange={setBookWeekends} />
        </Field>
        <Field label="Provide battery backup installs?" required>
          <YesNoToggle
            value={providesBatteryBackup}
            onChange={setProvidesBatteryBackup}
          />
        </Field>
      </div>

      <Field
        label="Website"
        hint="Optional — no https:// needed, just type the domain."
      >
        {/* Plain text (not type="url") because the URL constraint
            insists on a scheme and clients reliably type "solarguys.com"
            without thinking about it. Server prepends https:// before
            saving so links stored in the DB are always clickable. */}
        <input
          type="text"
          value={website}
          onChange={(e) => setWebsite(e.target.value)}
          placeholder="yourcompany.com"
          autoComplete="url"
          className="input"
        />
      </Field>

      <Field
        label="Qualification criteria"
        hint="Optional — what makes a good lead for you. Homeowner status, credit, bill, roof, etc."
      >
        <textarea
          value={qualificationCriteria}
          onChange={(e) => setQualificationCriteria(e.target.value)}
          placeholder="Homeowner, credit 680+, electric bill $150+/mo…"
          rows={3}
          className="input"
          style={{ resize: 'vertical', minHeight: '80px' }}
        />
      </Field>

      <Field label="Additional notes" hint="Optional — anything else we should know.">
        <textarea
          value={onboardingNotes}
          onChange={(e) => setOnboardingNotes(e.target.value)}
          rows={3}
          className="input"
          style={{ resize: 'vertical', minHeight: '80px' }}
        />
      </Field>

      {error && (
        <div className="rounded-md border border-red-200 bg-red-50 p-2 text-xs text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-200">
          {error}
        </div>
      )}

      <button
        type="submit"
        disabled={!canSubmit}
        className="w-full rounded-lg bg-blue-600 px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-blue-700 disabled:opacity-50"
      >
        {submit.isPending ? 'Submitting…' : 'Finish setup'}
      </button>

      {/* Scoped input style — matches the legacy onboarding form's
          look so the visual experience is identical between flows. */}
      <style jsx>{`
        .input {
          width: 100%;
          border-radius: 0.375rem;
          border: 1px solid rgb(228 228 231);
          padding: 0.5rem 0.75rem;
          font-size: 0.875rem;
          background: white;
          color: rgb(24 24 27);
        }
        :global(.dark) .input {
          border-color: rgb(39 39 42);
          background: rgb(9 9 11);
          color: rgb(244 244 245);
        }
        .input:focus {
          outline: none;
          border-color: rgb(59 130 246);
        }
      `}</style>
    </form>
  )
}

function YesNoToggle({
  value,
  onChange,
}: {
  value: 'yes' | 'no' | ''
  onChange: (next: 'yes' | 'no') => void
}) {
  return (
    <div className="grid grid-cols-2 gap-2">
      {(['yes', 'no'] as const).map((opt) => (
        <button
          key={opt}
          type="button"
          onClick={() => onChange(opt)}
          className={`rounded-md border p-2.5 text-center text-xs font-semibold capitalize transition ${
            value === opt
              ? 'border-blue-500 bg-blue-50 dark:bg-blue-950'
              : 'border-zinc-200 bg-white hover:bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-900 dark:hover:bg-zinc-800'
          }`}
        >
          {opt}
        </button>
      ))}
    </div>
  )
}

function Field({
  label,
  hint,
  required,
  children,
}: {
  label: string
  hint?: string
  required?: boolean
  children: React.ReactNode
}) {
  return (
    <div>
      <label className="mb-1 flex items-center gap-1 text-xs font-medium text-zinc-600 dark:text-zinc-400">
        {label}
        {required && <span className="text-rose-500">*</span>}
      </label>
      {children}
      {hint && (
        <p className="mt-1 text-[11px] text-zinc-400 dark:text-zinc-500">
          {hint}
        </p>
      )}
    </div>
  )
}

/* -------------------------------------------------------------------------- */
/*  Tracker view (post-active — appointments list, search, stats)             */
/* -------------------------------------------------------------------------- */

function TrackerView() {
  const [search, setSearch] = useState('')
  /** Appointment being status-reported via the modal. Null = modal
   *  closed. Set by clicking the per-row "Update Status" button OR
   *  by the /client?report=<id> URL param (deep-link from the email
   *  alert button). The modal handles the showed / no-show + notes
   *  capture; the won/lost flow stays on the existing OutcomeActions
   *  inline widget. */
  const [reportingAppointment, setReportingAppointment] =
    useState<Appointment | null>(null)
  /** Currently-expanded appointment in the desktop table. Same UX as
   *  the master tracker — click the chevron to slide open a detail
   *  drawer with full customer / address / property / notes / call
   *  recording fields. Null = nothing expanded. Single value (not
   *  Set) so opening one row collapses any other open row, keeping
   *  the table from sprawling. */
  const [expandedApptId, setExpandedApptId] = useState<string | null>(null)
  const queryClient = useQueryClient()
  const { data, isLoading, error } = useQuery<{
    client: {
      id: string
      name: string
      package: string
      apptCap: number | null
    } | null
    appointments: Appointment[]
    warning?: string
  }>({
    queryKey: ['client-appointments'],
    queryFn: async () => {
      const res = await fetch('/api/client/appointments')
      if (!res.ok) {
        const d = await res.json().catch(() => ({}))
        throw new Error(d.error || 'Failed to load appointments')
      }
      return res.json()
    },
  })

  // Client-side Won/Lost mutation. Optimistically updates the cached
  // appointments list so the button state flips instantly; on error we
  // refetch to resync. Server enforces auth + state-machine guard so
  // a misbehaving client can't escalate.
  const setOutcome = useMutation({
    mutationFn: async ({
      id,
      outcome,
    }: {
      id: string
      outcome: 'won' | 'lost' | 'clear'
    }) => {
      const res = await fetch(`/api/client/appointments/${id}/outcome`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ outcome }),
      })
      const json = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(json.error || 'Failed to update')
      return json
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['client-appointments'] })
    },
  })

  /** Showed / no-show + notes capture — wraps the same outcome
   *  endpoint as setOutcome but sends a different outcome value
   *  AND the free-form notes string. Closes the modal on success
   *  so the client sees their updated badge immediately. */
  const setShowStatus = useMutation({
    mutationFn: async ({
      id,
      outcome,
      notes,
      disqualified,
    }: {
      id: string
      outcome: 'showed' | 'no_show'
      notes: string
      /** Optional follow-up answer to "Customer Disqualified?" —
       *  only sent when outcome is 'showed'. null = answer
       *  cleared; undefined = field not touched (caller didn't
       *  collect it). */
      disqualified: boolean | null | undefined
    }) => {
      const res = await fetch(`/api/client/appointments/${id}/outcome`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          outcome,
          notes,
          // Only forward when meaningful — the API treats undefined
          // as "don't touch", so this preserves prior values when
          // the client picks no_show.
          ...(disqualified !== undefined ? { disqualified } : {}),
        }),
      })
      const json = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(json.error || 'Failed to update')
      return json
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['client-appointments'] })
      setReportingAppointment(null)
    },
  })

  // Deep-link handler — when the dashboard loads with a ?report=<id>
  // query param (e.g. from the "Update Appointment Status" button
  // in the email alert), auto-open the modal for that appointment.
  // window.location.search reading instead of useSearchParams to
  // avoid the Next.js 16 prerender failure flagged at the top of
  // this file. Clears the param after open so a refresh doesn't
  // re-trigger.
  useEffect(() => {
    if (typeof window === 'undefined') return
    const params = new URLSearchParams(window.location.search)
    const reportId = params.get('report')
    if (!reportId) return
    const appts = data?.appointments
    if (!appts) return
    const target = appts.find((a) => a.id === reportId)
    if (target) {
      setReportingAppointment(target)
      const newUrl = window.location.pathname
      window.history.replaceState({}, '', newUrl)
    }
    // Only run when appointments load — the URL param check itself
    // is cheap so re-running on every appointments refetch is fine.
  }, [data?.appointments])

  const filtered = (data?.appointments ?? []).filter((a) => {
    if (!search.trim()) return true
    const q = search.toLowerCase()
    return (
      a.customerName.toLowerCase().includes(q) ||
      a.customerPhone.toLowerCase().includes(q) ||
      (a.address ?? '').toLowerCase().includes(q) ||
      (a.utilityProvider ?? '').toLowerCase().includes(q)
    )
  })

  // Headline stats — three numbers that actually matter to a client
  // checking the page: how many came in this calendar month, what %
  // of past appointments showed up, and (for Growth Pack only) how
  // close they are to the monthly cap they're paying for.
  //
  // "Showed" rollup logic: an appointment whose status is 'showed',
  // 'won', or 'lost' counts as a show (won/lost are outcomes layered
  // ON a show). Denominator excludes booked/rescheduled — those
  // haven't had a chance to show yet, so including them would drag
  // the rate down artificially.
  const stats = useMemo(() => {
    const all = data?.appointments ?? []
    const now = new Date()
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1)
    const weekFromNow = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000)

    const thisMonth = all.filter((a) => {
      const d = new Date(a.apptDateTime)
      return d >= monthStart && d <= now
    }).length

    const showedish = all.filter(
      (a) => a.status === 'showed' || a.status === 'won' || a.status === 'lost',
    ).length
    const noShowed = all.filter((a) => a.status === 'no_show').length
    const hadChance = showedish + noShowed
    const showRate = hadChance > 0 ? Math.round((showedish / hadChance) * 100) : null

    const upcoming = all.filter((a) => {
      const d = new Date(a.apptDateTime)
      return (
        (a.status === 'booked' || a.status === 'rescheduled') &&
        d >= now &&
        d <= weekFromNow
      )
    })

    return {
      thisMonth,
      showRate,
      upcomingNext7: upcoming.length,
      upcomingList: upcoming
        .slice()
        .sort(
          (a, b) =>
            new Date(a.apptDateTime).getTime() -
            new Date(b.apptDateTime).getTime(),
        )
        .slice(0, 3),
    }
  }, [data?.appointments])

  const isGrowth = data?.client?.package === 'growth'
  const cap = data?.client?.apptCap ?? null
  // Cap is monthly. Count appointments in current month regardless of
  // status — what the client paid for is delivery, not show rate.
  const monthDelivered = useMemo(() => {
    const now = new Date()
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1)
    return (data?.appointments ?? []).filter((a) => {
      const d = new Date(a.apptDateTime)
      return d >= monthStart
    }).length
  }, [data?.appointments])

  return (
    <>
      {data?.warning && (
        <div className="mb-4 rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200">
          Heads up: your account isn&apos;t linked to a business yet.
          Reach out to your account manager and we&apos;ll get this sorted.
        </div>
      )}

      {/* Headline stats — three (or four with cap) numbers. Mobile
          gets 2-up; desktop expands to 3- or 4-up so the row stays
          compact without wrapping awkwardly. */}
      <div
        className={`mb-4 grid grid-cols-2 gap-3 ${
          isGrowth && cap ? 'md:grid-cols-4' : 'md:grid-cols-3'
        }`}
      >
        <StatCard label="This month" value={stats.thisMonth} />
        <StatCard
          label="Show rate"
          value={stats.showRate === null ? '—' : `${stats.showRate}%`}
          tone={
            stats.showRate === null
              ? undefined
              : stats.showRate >= 70
                ? 'green'
                : stats.showRate >= 50
                  ? undefined
                  : 'rose'
          }
        />
        <StatCard label="Next 7 days" value={stats.upcomingNext7} />
        {isGrowth && cap && (
          <PaceCard delivered={monthDelivered} cap={cap} />
        )}
      </div>

      {/* Upcoming-this-week callout. Hidden when nothing is on the
          books in the next 7 days — avoids visual clutter on quiet
          weeks. */}
      {stats.upcomingList.length > 0 && (
        <div className="mb-4 rounded-xl border border-blue-200 bg-blue-50 p-3 text-xs dark:border-blue-900 dark:bg-blue-950/50">
          <div className="mb-1.5 flex items-center gap-1.5 font-semibold text-blue-800 dark:text-blue-200">
            <Calendar className="h-3.5 w-3.5" />
            Coming up this week
          </div>
          <ul className="space-y-1 text-blue-900 dark:text-blue-100">
            {stats.upcomingList.map((a) => (
              <li
                key={a.id}
                className="flex flex-wrap items-baseline gap-x-2 tabular-nums"
              >
                <span className="font-medium">{formatDateTime(a.apptDateTime)}</span>
                <span className="text-blue-700 dark:text-blue-300">·</span>
                <span>{a.customerName}</span>
                {a.address && (
                  <>
                    <span className="text-blue-700 dark:text-blue-300">·</span>
                    <span className="truncate text-blue-700 dark:text-blue-300">
                      {a.address}
                    </span>
                  </>
                )}
              </li>
            ))}
            {stats.upcomingNext7 > stats.upcomingList.length && (
              <li className="text-blue-700 dark:text-blue-300">
                + {stats.upcomingNext7 - stats.upcomingList.length} more this week
              </li>
            )}
          </ul>
        </div>
      )}

      <div className="mb-4 flex items-center gap-2">
        <div className="relative max-w-sm flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-zinc-400" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search name, phone, address…"
            className="w-full rounded-md border border-zinc-200 bg-white py-2 pl-9 pr-3 text-sm focus:border-blue-500 focus:outline-none dark:border-zinc-800 dark:bg-zinc-900"
          />
        </div>
      </div>

      <div className="rounded-xl border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900">
        {isLoading ? (
          <div className="p-8 text-center text-sm text-zinc-500">Loading…</div>
        ) : error ? (
          <div className="p-8 text-center text-sm text-red-600">
            {(error as Error).message}
          </div>
        ) : filtered.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-2 p-12 text-center text-sm text-zinc-500">
            <Calendar className="h-6 w-6" />
            {search.trim()
              ? 'No appointments match that search.'
              : 'No appointments yet — they’ll show up here once we book them.'}
          </div>
        ) : (
          <>
            <table className="hidden w-full text-sm md:table">
              <thead className="border-b border-zinc-200 bg-zinc-50 text-[11px] uppercase tracking-wide text-zinc-500 dark:border-zinc-800 dark:bg-zinc-950">
                <tr>
                  {/* Chevron column — no header label, just space for
                      the expand toggle. Matches the master-tracker
                      pattern Alex is used to from /call-center. */}
                  <th className="w-6 px-2 py-2" />
                  <th className="px-4 py-2 text-left font-semibold">Date</th>
                  <th className="px-4 py-2 text-left font-semibold">Customer</th>
                  <th className="px-4 py-2 text-left font-semibold">Phone</th>
                  <th className="px-4 py-2 text-left font-semibold">Address</th>
                  <th className="px-4 py-2 text-left font-semibold">Bill</th>
                  <th className="px-4 py-2 text-left font-semibold">Utility</th>
                  <th className="px-4 py-2 text-left font-semibold">Recording</th>
                  <th className="px-4 py-2 text-left font-semibold">Status</th>
                  <th className="px-4 py-2 text-left font-semibold">Outcome</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((a) => {
                  const isExpanded = expandedApptId === a.id
                  return (
                  <Fragment key={a.id}>
                  <tr
                    className={cn(
                      'border-b border-zinc-100 transition-colors dark:border-zinc-800',
                      isExpanded
                        ? 'bg-blue-50/40 dark:bg-blue-950/20'
                        : 'hover:bg-zinc-50 dark:hover:bg-zinc-950/50',
                    )}
                  >
                    <td className="px-2 py-2 align-middle">
                      {/* Toggle — collapses any other open row by
                          setting a single id rather than a Set, so
                          the table doesn't sprawl into "all rows
                          open" if the client clicks through many. */}
                      <button
                        type="button"
                        onClick={() =>
                          setExpandedApptId(isExpanded ? null : a.id)
                        }
                        title={isExpanded ? 'Collapse details' : 'Show details'}
                        className="rounded p-0.5 text-zinc-400 hover:bg-zinc-200 hover:text-zinc-700 dark:hover:bg-zinc-800 dark:hover:text-zinc-200"
                      >
                        {isExpanded ? (
                          <ChevronDown className="h-3.5 w-3.5" />
                        ) : (
                          <ChevronRight className="h-3.5 w-3.5" />
                        )}
                      </button>
                    </td>
                    <td className="px-4 py-2 tabular-nums">
                      {formatDateTime(a.apptDateTime)}
                    </td>
                    <td className="px-4 py-2 font-medium">{a.customerName}</td>
                    <td className="px-4 py-2 tabular-nums">{a.customerPhone}</td>
                    <td className="px-4 py-2 text-xs text-zinc-600 dark:text-zinc-400">
                      {a.address ?? '—'}
                    </td>
                    <td className="px-4 py-2 tabular-nums">
                      {a.monthlyBill ?? '—'}
                    </td>
                    <td className="px-4 py-2">{a.utilityProvider ?? '—'}</td>
                    <td className="px-4 py-2">
                      {/* Recording link routes through the Hub's signed
                          proxy (set server-side; raw vicitel URL never
                          reaches the browser). Em-dash when the
                          appointment has no recording or the proxy
                          isn't configured. */}
                      {a.recordingUrl ? (
                        <a
                          href={a.recordingUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex items-center gap-1 rounded-md border border-blue-200 bg-blue-50 px-2 py-1 text-[11px] font-medium text-blue-700 transition hover:bg-blue-100 dark:border-blue-800 dark:bg-blue-950 dark:text-blue-300 dark:hover:bg-blue-900"
                        >
                          <Play className="h-3 w-3" />
                          Listen
                        </a>
                      ) : (
                        <span className="text-zinc-400">—</span>
                      )}
                    </td>
                    <td className="px-4 py-2">
                      <StatusBadge status={a.status} />
                    </td>
                    <td className="px-4 py-2">
                      {/* Outcome cell mirrors the card-view action
                          row: Update-status button is the primary
                          action for every non-cancelled appointment;
                          Won/Lost picker only renders once the
                          appointment is already a sit-down. Mobile
                          card-view at the same logic, kept in sync
                          below — change both when changing either. */}
                      {a.status !== 'cancelled' && (
                        <div className="flex flex-wrap items-center gap-2">
                          <button
                            type="button"
                            onClick={() => setReportingAppointment(a)}
                            className="inline-flex items-center gap-1 rounded-md border border-yellow-400 bg-yellow-50 px-2.5 py-1 text-[11px] font-medium text-yellow-800 transition hover:bg-yellow-100 dark:border-yellow-500 dark:bg-yellow-950 dark:text-yellow-300 dark:hover:bg-yellow-900"
                          >
                            Update status
                          </button>
                          {a.clientStatusUpdatedAt && (
                            <span
                              className="text-[10px] text-zinc-400"
                              title={new Date(a.clientStatusUpdatedAt).toLocaleString()}
                            >
                              Updated{' '}
                              {formatRelative(a.clientStatusUpdatedAt)}
                            </span>
                          )}
                          {(a.status === 'showed' ||
                            a.status === 'won' ||
                            a.status === 'lost') && (
                            <OutcomeActions
                              status={a.status}
                              pending={
                                setOutcome.isPending &&
                                setOutcome.variables?.id === a.id
                              }
                              onMark={(outcome) =>
                                setOutcome.mutate({ id: a.id, outcome })
                              }
                            />
                          )}
                        </div>
                      )}
                    </td>
                  </tr>
                  {/* Expanded detail drawer — same structure as the
                      master-tracker RowDetail so admins and clients
                      see the same kind of layout. colSpan covers the
                      chevron + 9 data columns = 10 total. */}
                  {isExpanded && (
                    <tr className="bg-blue-50/20 dark:bg-blue-950/10">
                      <td
                        colSpan={10}
                        className="border-b border-blue-200/40 px-6 py-4 dark:border-blue-900/40"
                      >
                        <ClientApptDetail appointment={a} />
                      </td>
                    </tr>
                  )}
                  </Fragment>
                  )
                })}
              </tbody>
            </table>

            <ul className="divide-y divide-zinc-100 md:hidden dark:divide-zinc-800">
              {filtered.map((a) => (
                <li key={a.id} className="px-4 py-3">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-semibold">
                        {a.customerName}
                      </p>
                      <p className="mt-0.5 text-xs tabular-nums text-zinc-500">
                        {formatDateTime(a.apptDateTime)}
                      </p>
                    </div>
                    <StatusBadge status={a.status} />
                  </div>
                  <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-[11px]">
                    <div className="col-span-2">
                      <dt className="text-zinc-400">Address</dt>
                      <dd className="text-zinc-600 dark:text-zinc-300">
                        {a.address ?? '—'}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-zinc-400">Phone</dt>
                      <dd className="tabular-nums text-zinc-600 dark:text-zinc-300">
                        {a.customerPhone}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-zinc-400">Bill</dt>
                      <dd className="tabular-nums text-zinc-600 dark:text-zinc-300">
                        {a.monthlyBill ?? '—'}
                      </dd>
                    </div>
                    <div className="col-span-2">
                      <dt className="text-zinc-400">Utility</dt>
                      <dd className="text-zinc-600 dark:text-zinc-300">
                        {a.utilityProvider ?? '—'}
                      </dd>
                    </div>
                  </dl>
                  {/* Recording link — separate row so the play button
                      is touch-friendly on mobile. Same signed-proxy
                      URL as the desktop column; hidden entirely when
                      there's no recording on file. */}
                  {a.recordingUrl && (
                    <div className="mt-2">
                      <a
                        href={a.recordingUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1 rounded-md border border-blue-200 bg-blue-50 px-2 py-1 text-[11px] font-medium text-blue-700 transition hover:bg-blue-100 dark:border-blue-800 dark:bg-blue-950 dark:text-blue-300 dark:hover:bg-blue-900"
                      >
                        <Play className="h-3 w-3" />
                        Listen to call
                      </a>
                    </div>
                  )}
                  {/* Action row — appears for everything except
                      cancelled (which is terminal for the client).
                      "Update Status" lets them mark showed/no-show
                      + add notes; the existing Won/Lost widget only
                      renders once the appointment is already a
                      sit-down. clientStatusUpdatedAt drives a small
                      "Updated X ago" hint so repeat updates feel
                      acknowledged. */}
                  {a.status !== 'cancelled' && (
                    <div className="mt-3 flex flex-wrap items-center justify-end gap-2">
                      {a.clientStatusUpdatedAt && (
                        <span
                          className="text-[10px] text-zinc-400"
                          title={new Date(a.clientStatusUpdatedAt).toLocaleString()}
                        >
                          Updated{' '}
                          {formatRelative(a.clientStatusUpdatedAt)}
                        </span>
                      )}
                      <button
                        type="button"
                        onClick={() => setReportingAppointment(a)}
                        className="inline-flex items-center gap-1 rounded-md border border-zinc-200 bg-white px-2.5 py-1 text-[11px] font-medium text-zinc-700 transition hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200 dark:hover:bg-zinc-800"
                      >
                        Update status
                      </button>
                      {(a.status === 'showed' ||
                        a.status === 'won' ||
                        a.status === 'lost') && (
                        <OutcomeActions
                          status={a.status}
                          pending={
                            setOutcome.isPending &&
                            setOutcome.variables?.id === a.id
                          }
                          onMark={(outcome) =>
                            setOutcome.mutate({ id: a.id, outcome })
                          }
                        />
                      )}
                    </div>
                  )}
                </li>
              ))}
            </ul>
          </>
        )}
      </div>

      {/* Status-report modal — opens from per-row "Update status"
          clicks AND deep-link via ?report=<id> in the URL (the
          email-alert button). Captures the showed / no-show
          decision + free-form notes; saves to clientNotes +
          status so Mary's master tracker view shows both
          perspectives without one stomping the other. */}
      {reportingAppointment && (
        <StatusReportModal
          appointment={reportingAppointment}
          pending={setShowStatus.isPending}
          errorMessage={
            setShowStatus.isError
              ? (setShowStatus.error as Error).message
              : null
          }
          onClose={() => setReportingAppointment(null)}
          onSubmit={(outcome, notes, disqualified) =>
            setShowStatus.mutate({
              id: reportingAppointment.id,
              outcome,
              notes,
              disqualified,
            })
          }
        />
      )}
    </>
  )
}

function StatCard({
  label,
  value,
  tone,
}: {
  label: string
  value: number | string
  tone?: 'green' | 'rose'
}) {
  const valueColor =
    tone === 'green'
      ? 'text-emerald-600 dark:text-emerald-400'
      : tone === 'rose'
        ? 'text-rose-600 dark:text-rose-400'
        : 'text-zinc-900 dark:text-zinc-50'
  return (
    <div className="rounded-xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
      <p className="text-[11px] uppercase tracking-wide text-zinc-500">
        {label}
      </p>
      <p className={`mt-1 text-2xl font-bold tabular-nums ${valueColor}`}>
        {value}
      </p>
    </div>
  )
}

/** Growth-Pack-only pace card. Shows X / cap for the current month
 *  with a thin progress bar. Hidden for PPA (no monthly cap there). */
function PaceCard({ delivered, cap }: { delivered: number; cap: number }) {
  const pct = Math.min(100, Math.round((delivered / cap) * 100))
  const tone =
    pct >= 100
      ? 'bg-emerald-500'
      : pct >= 75
        ? 'bg-blue-500'
        : 'bg-blue-400'
  return (
    <div className="rounded-xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
      <p className="text-[11px] uppercase tracking-wide text-zinc-500">
        Pace this month
      </p>
      <p className="mt-1 text-2xl font-bold tabular-nums text-zinc-900 dark:text-zinc-50">
        {delivered}
        <span className="text-sm font-normal text-zinc-400"> / {cap}</span>
      </p>
      <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-zinc-100 dark:bg-zinc-800">
        <div
          className={`h-full rounded-full ${tone}`}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  )
}

/** Won / Lost buttons for the client to mark deal outcome. Only shown
 *  when the appointment status is showed/won/lost — earlier states
 *  belong to Mary/admin. Won state highlights the Won button; clicking
 *  the active button "clears" back to plain Showed (oops, wrong row). */
function OutcomeActions({
  status,
  pending,
  onMark,
}: {
  status: string
  pending: boolean
  onMark: (outcome: 'won' | 'lost' | 'clear') => void
}) {
  if (status !== 'showed' && status !== 'won' && status !== 'lost') {
    return null
  }
  const isWon = status === 'won'
  const isLost = status === 'lost'
  return (
    <div className="inline-flex items-center gap-1">
      <button
        type="button"
        disabled={pending}
        onClick={() => onMark(isWon ? 'clear' : 'won')}
        title={isWon ? 'Clear (mark as just showed)' : 'Mark as Won — deal closed'}
        className={`inline-flex items-center gap-1 rounded-md border px-2 py-1 text-[11px] font-medium transition disabled:opacity-50 ${
          isWon
            ? 'border-green-300 bg-green-100 text-green-800 hover:bg-green-200 dark:border-green-700 dark:bg-green-900 dark:text-green-100'
            : 'border-zinc-200 bg-white text-zinc-600 hover:border-green-300 hover:bg-green-50 hover:text-green-700 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300 dark:hover:bg-green-950'
        }`}
      >
        <Trophy className="h-3 w-3" />
        Won
      </button>
      <button
        type="button"
        disabled={pending}
        onClick={() => onMark(isLost ? 'clear' : 'lost')}
        title={isLost ? 'Clear (mark as just showed)' : 'Mark as Lost — deal did not close'}
        className={`inline-flex items-center gap-1 rounded-md border px-2 py-1 text-[11px] font-medium transition disabled:opacity-50 ${
          isLost
            ? 'border-stone-300 bg-stone-100 text-stone-700 hover:bg-stone-200 dark:border-stone-600 dark:bg-stone-800 dark:text-stone-200'
            : 'border-zinc-200 bg-white text-zinc-600 hover:border-stone-300 hover:bg-stone-50 hover:text-stone-700 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300 dark:hover:bg-stone-800'
        }`}
      >
        <XCircle className="h-3 w-3" />
        Lost
      </button>
    </div>
  )
}

function StatusBadge({ status }: { status: string }) {
  const map: Record<string, { label: string; cls: string }> = {
    booked: {
      label: 'Booked',
      cls: 'bg-blue-50 text-blue-700 border-blue-200 dark:bg-blue-950 dark:text-blue-300 dark:border-blue-900',
    },
    rescheduled: {
      label: 'Rescheduled',
      cls: 'bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-950 dark:text-amber-300 dark:border-amber-900',
    },
    showed: {
      label: 'Showed',
      cls: 'bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-950 dark:text-emerald-300 dark:border-emerald-900',
    },
    won: {
      label: 'Won',
      cls: 'bg-green-100 text-green-800 border-green-300 dark:bg-green-900 dark:text-green-200 dark:border-green-700',
    },
    lost: {
      label: 'Lost',
      cls: 'bg-stone-100 text-stone-700 border-stone-300 dark:bg-stone-800 dark:text-stone-300 dark:border-stone-700',
    },
    no_show: {
      label: 'No-show',
      cls: 'bg-rose-50 text-rose-700 border-rose-200 dark:bg-rose-950 dark:text-rose-300 dark:border-rose-900',
    },
    cancelled: {
      label: 'Cancelled',
      cls: 'bg-zinc-100 text-zinc-600 border-zinc-300 dark:bg-zinc-800 dark:text-zinc-300 dark:border-zinc-700',
    },
  }
  const m = map[status] ?? {
    label: status,
    cls: 'bg-zinc-100 text-zinc-600 border-zinc-300 dark:bg-zinc-800 dark:text-zinc-300 dark:border-zinc-700',
  }
  return (
    <span
      className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium ${m.cls}`}
    >
      {m.label}
    </span>
  )
}

function formatDateTime(iso: string): string {
  try {
    return new Date(iso).toLocaleString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    })
  } catch {
    return iso
  }
}

/** "5 min ago" / "3h ago" / "yesterday" / "2d ago" — same pattern
 *  we use elsewhere in the app for last-activity hints. Returns the
 *  raw iso string if parsing fails so we never render "Invalid Date". */
function formatRelative(iso: string): string {
  try {
    const then = new Date(iso).getTime()
    const diffMs = Date.now() - then
    const minutes = Math.floor(diffMs / 60000)
    if (minutes < 1) return 'just now'
    if (minutes < 60) return `${minutes} min ago`
    const hours = Math.floor(minutes / 60)
    if (hours < 24) return `${hours}h ago`
    const days = Math.floor(hours / 24)
    if (days === 1) return 'yesterday'
    if (days < 7) return `${days}d ago`
    if (days < 30) return `${Math.floor(days / 7)}w ago`
    return new Date(iso).toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
    })
  } catch {
    return iso
  }
}

/* -------------------------------------------------------------------------- */
/*  Expandable row detail — mirrors master-tracker's drawer for clients       */
/* -------------------------------------------------------------------------- */

/**
 * Detail drawer that slides open when the client clicks the chevron
 * next to an appointment row. Mirrors the master-tracker's RowDetail
 * shape (3-column grid: Customer / Address / Property, full-width
 * notes blocks below) so the experience matches what admin sees.
 *
 * Hides any sub-block that has nothing to show — an appointment
 * with no notes / no recording shouldn't render empty headers.
 */
function ClientApptDetail({ appointment }: { appointment: Appointment }) {
  return (
    <div className="grid gap-x-8 gap-y-3 text-xs md:grid-cols-3">
      <DetailItem label="Customer">
        <div className="font-medium text-zinc-800 dark:text-zinc-100">
          {appointment.customerName}
        </div>
        <div className="font-mono text-zinc-500">
          {appointment.customerPhone}
        </div>
        {appointment.email && (
          <a
            href={`mailto:${appointment.email}`}
            className="text-blue-600 hover:underline"
          >
            {appointment.email}
          </a>
        )}
      </DetailItem>
      <DetailItem label="Address">
        {appointment.address || (
          <span className="text-zinc-400">Not provided</span>
        )}
      </DetailItem>
      <DetailItem label="Property">
        <div>
          <span className="text-zinc-400">Bill:</span>{' '}
          {appointment.monthlyBill
            ? `$${appointment.monthlyBill}${appointment.monthlyBill.includes('/') ? '' : '/mo'}`
            : '—'}
        </div>
        <div>
          <span className="text-zinc-400">Utility:</span>{' '}
          {appointment.utilityProvider || '—'}
        </div>
        <div>
          <span className="text-zinc-400">Roof:</span>{' '}
          {appointment.roofType || '—'}
          {appointment.roofAge && ` · ${appointment.roofAge}`}
        </div>
        <div>
          <span className="text-zinc-400">Deal value:</span>{' '}
          {appointment.estimatedDealValue
            ? `$${appointment.estimatedDealValue}`
            : '—'}
        </div>
        {appointment.bookedByName && (
          <div>
            <span className="text-zinc-400">Booked by:</span>{' '}
            {appointment.bookedByName}
          </div>
        )}
        <div>
          <span className="text-zinc-400">Logged:</span>{' '}
          {new Date(appointment.createdAt).toLocaleString('en-US')}
        </div>
      </DetailItem>
      {/* Notes from the call-center side. Surfaced verbatim so the
          client sees the same context Mary captured at booking
          time — utility, roof concerns, lead temperature, etc. */}
      {appointment.notes && (
        <div className="md:col-span-3">
          <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-zinc-500">
            Notes from the call
          </p>
          <div className="whitespace-pre-wrap rounded-md border border-zinc-200 bg-white p-3 text-zinc-700 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200">
            {appointment.notes}
          </div>
        </div>
      )}
      {/* Notes the client themselves left when they hit Update
          Status. Emerald accent — same color as the master-tracker
          treatment so the two surfaces visually agree. Hidden when
          empty so the drawer doesn't render dead headers. */}
      {appointment.clientNotes && (
        <div className="md:col-span-3">
          <div className="mb-1 flex items-center justify-between">
            <p className="text-[10px] font-semibold uppercase tracking-wide text-emerald-600">
              Your notes
            </p>
            {appointment.clientStatusUpdatedAt && (
              <p
                className="text-[10px] text-zinc-400"
                title={new Date(appointment.clientStatusUpdatedAt).toLocaleString()}
              >
                Updated{' '}
                {new Date(appointment.clientStatusUpdatedAt).toLocaleString(
                  'en-US',
                  { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' },
                )}
              </p>
            )}
          </div>
          <div className="whitespace-pre-wrap rounded-md border border-emerald-200 bg-emerald-50 p-3 text-emerald-900 dark:border-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-100">
            {appointment.clientNotes}
          </div>
        </div>
      )}
      {/* Larger recording button at the bottom of the drawer — the
          inline one in the Recording column is small for table
          density, this one is the primary CTA when the client has
          the drawer open. Hidden when there's no recording. */}
      {appointment.recordingUrl && (
        <div className="md:col-span-3">
          <a
            href={appointment.recordingUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 rounded-md border border-blue-200 bg-blue-50 px-3 py-1.5 text-xs font-medium text-blue-700 hover:bg-blue-100 dark:border-blue-800 dark:bg-blue-950 dark:text-blue-200 dark:hover:bg-blue-900"
          >
            <Play className="h-3 w-3" />
            Play call recording
          </a>
        </div>
      )}
    </div>
  )
}

function DetailItem({
  label,
  children,
}: {
  label: string
  children: React.ReactNode
}) {
  return (
    <div>
      <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-zinc-500">
        {label}
      </p>
      <div className="space-y-0.5 text-zinc-700 dark:text-zinc-300">
        {children}
      </div>
    </div>
  )
}

/* -------------------------------------------------------------------------- */
/*  Status report modal — captures showed / no-show + client notes            */
/* -------------------------------------------------------------------------- */

function StatusReportModal({
  appointment,
  pending,
  errorMessage,
  onClose,
  onSubmit,
}: {
  appointment: Appointment
  pending: boolean
  errorMessage: string | null
  onClose: () => void
  onSubmit: (
    outcome: 'showed' | 'no_show',
    notes: string,
    /** undefined when the question wasn't asked (no_show path); the
     *  API treats undefined as "don't touch this field". */
    disqualified: boolean | null | undefined,
  ) => void
}) {
  // Pre-fill: when this appointment already has a recorded status,
  // start the radio on whatever was last picked. New (booked /
  // rescheduled) appointments leave the user to make a fresh choice.
  const initialOutcome: 'showed' | 'no_show' | null =
    appointment.status === 'no_show'
      ? 'no_show'
      : appointment.status === 'showed' ||
          appointment.status === 'won' ||
          appointment.status === 'lost'
        ? 'showed'
        : null
  const [outcome, setOutcome] = useState<'showed' | 'no_show' | null>(
    initialOutcome,
  )
  const [notes, setNotes] = useState<string>(appointment.clientNotes ?? '')
  // Customer Disqualified follow-up — only meaningful when outcome
  // is 'showed'. Pre-fill from the appointment so reopening shows
  // the previous answer. null = unanswered (the conditional
  // fieldset renders neither button as selected).
  const [disqualified, setDisqualified] = useState<boolean | null>(
    appointment.customerDisqualified ?? null,
  )

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!outcome) return
    // Only forward the disqualified value when the question
    // actually applied (showed). For no_show we send undefined so
    // the API leaves the field alone (the API also force-clears it
    // server-side as a defensive belt — see route.ts).
    const dq: boolean | null | undefined =
      outcome === 'showed' ? disqualified : undefined
    onSubmit(outcome, notes, dq)
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md rounded-xl border border-zinc-200 bg-white p-6 shadow-xl dark:border-zinc-800 dark:bg-zinc-900"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="text-base font-semibold">Update appointment status</h2>
            <p className="mt-0.5 truncate text-xs text-zinc-500">
              {appointment.customerName} ·{' '}
              {formatDateTime(appointment.apptDateTime)}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md p-1 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700 dark:hover:bg-zinc-800 dark:hover:text-zinc-200"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <fieldset>
            <legend className="text-xs font-medium uppercase tracking-wide text-zinc-500">
              Did they show up?
            </legend>
            <div className="mt-2 grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => setOutcome('showed')}
                className={cn(
                  'rounded-lg border px-3 py-3 text-sm font-medium transition',
                  outcome === 'showed'
                    ? 'border-emerald-500 bg-emerald-50 text-emerald-700 dark:border-emerald-700 dark:bg-emerald-950 dark:text-emerald-300'
                    : 'border-zinc-200 text-zinc-700 hover:bg-zinc-50 dark:border-zinc-700 dark:text-zinc-200 dark:hover:bg-zinc-800',
                )}
              >
                ✓ Showed up
              </button>
              <button
                type="button"
                onClick={() => setOutcome('no_show')}
                className={cn(
                  'rounded-lg border px-3 py-3 text-sm font-medium transition',
                  outcome === 'no_show'
                    ? 'border-rose-500 bg-rose-50 text-rose-700 dark:border-rose-700 dark:bg-rose-950 dark:text-rose-300'
                    : 'border-zinc-200 text-zinc-700 hover:bg-zinc-50 dark:border-zinc-700 dark:text-zinc-200 dark:hover:bg-zinc-800',
                )}
              >
                ✗ Didn&apos;t show
              </button>
            </div>
          </fieldset>

          {/* Conditional follow-up — only appears once the client
              has confirmed the prospect showed up. A disqualified
              answer captures the "sat down but washed" case
              (renter, can't afford, wrong fit, etc.) so admins can
              tell qualified showed-pipeline apart from showed-but-
              wasted-time. Question is skipped on no_show paths —
              a customer who didn't come can't have been disqualified
              during the meeting. */}
          {outcome === 'showed' && (
            <fieldset>
              <legend className="text-xs font-medium uppercase tracking-wide text-zinc-500">
                Customer disqualified?
              </legend>
              <div className="mt-2 grid grid-cols-2 gap-2">
                <button
                  type="button"
                  onClick={() => setDisqualified(true)}
                  className={cn(
                    'rounded-lg border px-3 py-2.5 text-sm font-medium transition',
                    disqualified === true
                      ? 'border-amber-500 bg-amber-50 text-amber-700 dark:border-amber-600 dark:bg-amber-950 dark:text-amber-300'
                      : 'border-zinc-200 text-zinc-700 hover:bg-zinc-50 dark:border-zinc-700 dark:text-zinc-200 dark:hover:bg-zinc-800',
                  )}
                >
                  Yes
                </button>
                <button
                  type="button"
                  onClick={() => setDisqualified(false)}
                  className={cn(
                    'rounded-lg border px-3 py-2.5 text-sm font-medium transition',
                    disqualified === false
                      ? 'border-emerald-500 bg-emerald-50 text-emerald-700 dark:border-emerald-700 dark:bg-emerald-950 dark:text-emerald-300'
                      : 'border-zinc-200 text-zinc-700 hover:bg-zinc-50 dark:border-zinc-700 dark:text-zinc-200 dark:hover:bg-zinc-800',
                  )}
                >
                  No
                </button>
              </div>
              <p className="mt-1 text-[10px] text-zinc-400">
                Pick &quot;Yes&quot; if the prospect washed (renter, can&apos;t
                afford, wrong fit, etc.) so it doesn&apos;t count as
                qualified pipeline.
              </p>
            </fieldset>
          )}

          <div>
            <label className="text-xs font-medium uppercase tracking-wide text-zinc-500">
              Notes (optional)
            </label>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={4}
              placeholder="Anything important — energy of the meeting, follow-up needed, why they didn't show, etc."
              className="mt-1 w-full rounded-md border border-zinc-200 bg-white px-3 py-2 text-sm focus:border-blue-500 focus:outline-none dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100"
            />
            <p className="mt-1 text-[10px] text-zinc-400">
              Visible to your Genisys account manager. Doesn&apos;t
              overwrite their internal notes.
            </p>
          </div>

          {errorMessage && (
            <div className="rounded-md border border-red-200 bg-red-50 p-2 text-xs text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-200">
              {errorMessage}
            </div>
          )}

          <div className="flex items-center justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded-md px-3 py-1.5 text-sm font-medium text-zinc-600 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={!outcome || pending}
              className="inline-flex items-center gap-1.5 rounded-md bg-blue-600 px-3.5 py-1.5 text-sm font-semibold text-white transition hover:bg-blue-700 disabled:opacity-50"
            >
              {pending ? 'Saving…' : 'Save update'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
