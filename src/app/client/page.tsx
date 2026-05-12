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

import { useQuery, useMutation } from '@tanstack/react-query'
import { useEffect, useMemo, useState } from 'react'
import {
  Building2,
  Calendar,
  CheckCircle2,
  Clock,
  CreditCard,
  ExternalLink,
  Loader2,
  LogOut,
  Search,
  Sparkles,
} from 'lucide-react'
import { signOut } from 'next-auth/react'

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
  createdAt: string
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
}: {
  title: string
  subtitle: string
}) {
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
        <button
          onClick={() => signOut({ callbackUrl: '/signin/client' })}
          className="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-zinc-200 bg-white px-3 py-1.5 text-xs font-medium text-zinc-700 hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200 dark:hover:bg-zinc-800"
        >
          <LogOut className="h-3.5 w-3.5" />
          Sign out
        </button>
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

  const submit = useMutation({
    mutationFn: async (opt: PaymentOption) => {
      const res = await fetch('/api/client/select-plan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          businessName,
          tier: opt.tier,
          paymentOption: opt.id,
        }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Failed to save plan')
      return data
    },
    onSuccess: (_data, opt) => {
      // Open the QuickBooks link in a new tab right after saving the
      // plan choice. The user comes back to /client and sees the
      // "awaiting approval" state (refresh triggered by onComplete).
      window.open(opt.href, '_blank', 'noopener,noreferrer')
      onComplete()
    },
    onError: (err) => {
      setError((err as Error).message)
    },
  })

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <WelcomeBanner
        user={user}
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
              <CreditCard className="mt-0.5 h-4 w-4 flex-shrink-0 text-blue-600" />
              <div className="min-w-0 flex-1">
                <div className="text-sm font-semibold">{opt.label}</div>
                <div className="mt-0.5 text-xs text-zinc-500">{opt.sub}</div>
              </div>
              {submit.isPending && picked?.id === opt.id ? (
                <Loader2 className="h-4 w-4 flex-shrink-0 animate-spin text-blue-600" />
              ) : (
                <ExternalLink className="h-3.5 w-3.5 flex-shrink-0 text-zinc-400 transition group-hover:text-blue-600" />
              )}
            </button>
          ))}
        </div>
        <p className="text-[11px] text-zinc-500">
          Clicking a plan saves your selection and opens the secure
          QuickBooks payment page in a new tab. After payment lands, your
          account manager approves your account.
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
  return (
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
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-gradient-to-b from-transparent via-white/70 to-white dark:via-zinc-900/70 dark:to-zinc-900">
          <span className="rounded-full bg-blue-600 px-3 py-1.5 text-[11px] font-semibold text-white shadow-sm">
            Pay to unlock
          </span>
        </div>
      </div>
    </section>
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
  user,
  message,
}: {
  user: MeUser
  message: string
}) {
  const greeting = user.name?.split(' ')[0] || 'there'
  return (
    <section className="rounded-2xl border border-zinc-200 bg-gradient-to-br from-blue-50 to-white p-5 dark:border-zinc-800 dark:from-blue-950/40 dark:to-zinc-900">
      <div className="flex items-center gap-2">
        <Sparkles className="h-5 w-5 text-blue-600" />
        <h2 className="text-lg font-semibold">
          Welcome to Lead Genisys, {greeting}.
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
            onChange={(e) => setPhone(e.target.value)}
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

      <Field label="Business address" required>
        <input
          type="text"
          value={address}
          onChange={(e) => setAddress(e.target.value)}
          required
          placeholder="123 Main St, City, ST 12345"
          className="input"
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

      <Field label="Website" hint="Optional.">
        <input
          type="url"
          value={website}
          onChange={(e) => setWebsite(e.target.value)}
          placeholder="https://yourcompany.com"
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
  const { data, isLoading, error } = useQuery<{
    client: { id: string; name: string } | null
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

  // Stat counts. "Upcoming" is workflow-state-based (booked or
  // rescheduled) rather than timestamp-based — cleaner semantics
  // for a client view (they care about pipeline state, not whether
  // the clock has crossed the appointment boundary by a few minutes).
  // Won/Lost roll up into "Showed" since they're outcomes ON TOP of
  // showing up; closing a deal shouldn't lower the show count.
  const stats = useMemo(() => {
    const all = data?.appointments ?? []
    return {
      total: all.length,
      upcoming: all.filter(
        (a) => a.status === 'booked' || a.status === 'rescheduled',
      ).length,
      showed: all.filter(
        (a) =>
          a.status === 'showed' || a.status === 'won' || a.status === 'lost',
      ).length,
      noShow: all.filter((a) => a.status === 'no_show').length,
    }
  }, [data?.appointments])

  return (
    <>
      {data?.warning && (
        <div className="mb-4 rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200">
          Heads up: your account isn&apos;t linked to a business yet.
          Reach out to your account manager and we&apos;ll get this sorted.
        </div>
      )}

      <div className="mb-6 grid grid-cols-2 gap-3 md:grid-cols-4">
        <StatCard label="Total" value={stats.total} />
        <StatCard label="Upcoming" value={stats.upcoming} />
        <StatCard label="Showed" value={stats.showed} tone="green" />
        <StatCard label="No-show" value={stats.noShow} tone="rose" />
      </div>

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
                  <th className="px-4 py-2 text-left font-semibold">Date</th>
                  <th className="px-4 py-2 text-left font-semibold">Customer</th>
                  <th className="px-4 py-2 text-left font-semibold">Phone</th>
                  <th className="px-4 py-2 text-left font-semibold">Address</th>
                  <th className="px-4 py-2 text-left font-semibold">Bill</th>
                  <th className="px-4 py-2 text-left font-semibold">Utility</th>
                  <th className="px-4 py-2 text-left font-semibold">Status</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((a) => (
                  <tr
                    key={a.id}
                    className="border-b border-zinc-100 last:border-0 hover:bg-zinc-50 dark:border-zinc-800 dark:hover:bg-zinc-950/50"
                  >
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
                      <StatusBadge status={a.status} />
                    </td>
                  </tr>
                ))}
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
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    </>
  )
}

function StatCard({
  label,
  value,
  tone,
}: {
  label: string
  value: number
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
