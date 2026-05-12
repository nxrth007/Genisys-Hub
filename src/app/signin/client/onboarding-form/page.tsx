'use client'

/**
 * Step 2 of client signup — collects the business + contact info admin
 * would normally type into "+ New client" on /clients. Posting this
 * creates the Client row (lifecycle=pending) and bumps the user's role
 * to client_onboarding, which middleware then routes to the waiting
 * screen until admin approves.
 *
 * Same field set Alex listed in the spec: business name, state, tier,
 * full name, role, phone, business address, servicing zipcodes.
 */
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import Image from 'next/image'
import { Building2, AlertCircle } from 'lucide-react'
import { AddressInput } from '@/components/ui/address-input'

/** Package tiers shown in the onboarding form. `disabled: true` greys
 *  the option out + blocks selection. Pro is parked here until QB's
 *  $5K multi-use link cap is sorted (custom invoicing path is in
 *  flight). When ready, drop the disabled flag and add the QB link
 *  to PAYMENT_LINKS in /signin/client/payment. */
const TIERS: Array<{
  id: string
  label: string
  sub: string
  disabled?: boolean
}> = [
  {
    id: 'ppa',
    label: 'Pay-per-appointment',
    sub: 'Pay only for appointments delivered',
  },
  {
    id: 'growth',
    label: 'Growth',
    sub: '20 appointments / month commitment',
  },
  {
    id: 'pro',
    label: 'Pro',
    sub: '30 appointments / month commitment',
    disabled: true,
  },
  {
    id: 'custom',
    label: 'Custom / I\'m not sure yet',
    sub: 'We\'ll work it out together',
  },
]

export default function OnboardingFormPage() {
  const router = useRouter()
  const [businessName, setBusinessName] = useState('')
  const [state, setState] = useState('')
  const [tier, setTier] = useState('growth')
  const [fullName, setFullName] = useState('')
  const [role, setRole] = useState('')
  const [phone, setPhone] = useState('')
  const [address, setAddress] = useState('')
  const [servicingZipcodes, setServicingZipcodes] = useState('')
  // Intake questions added 2026-05-11 — recorded on the Client row
  // and shown in the admin Additional info panel after submission.
  // Empty string for the booleans = "not answered yet" so the form
  // can force a choice before letting the user submit.
  const [appointmentTypes, setAppointmentTypes] = useState<
    'in_person' | 'virtual' | 'both' | ''
  >('')
  const [bookWeekends, setBookWeekends] = useState<'yes' | 'no' | ''>('')
  const [website, setWebsite] = useState('')
  const [providesBatteryBackup, setProvidesBatteryBackup] = useState<
    'yes' | 'no' | ''
  >('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    setSubmitting(true)
    try {
      const res = await fetch('/api/client/onboarding-form', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
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
        }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        setError(data.error || 'Failed to submit onboarding form.')
        return
      }
      // Send them to the payment step before the pending screen.
      // Payment is optional (the application still goes to admin
      // review either way), so the payment page has an "I'll pay
      // later" button that lands on /signin/client/pending.
      router.refresh()
      router.push('/signin/client/payment')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="flex min-h-[calc(100vh-64px)] items-start justify-center bg-gradient-to-b from-zinc-50 to-zinc-100 px-4 py-6 sm:items-center sm:py-10 dark:from-zinc-950 dark:to-zinc-900">
      <div className="w-full max-w-xl rounded-xl border border-zinc-200 bg-white p-5 shadow-lg sm:p-8 dark:border-zinc-800 dark:bg-zinc-900">
        <div className="mb-5 flex items-center justify-center">
          <Image
            src="/genisys-logo.png"
            alt="Lead Genisys"
            width={450}
            height={150}
            priority
            className="h-auto w-40 sm:w-44 dark:invert"
          />
        </div>
        <div className="mb-2 flex items-center justify-center gap-2 text-sm font-medium text-blue-600">
          <Building2 className="h-4 w-4" />
          Tell us about your business
        </div>
        <p className="mb-6 text-center text-xs text-zinc-500">
          Step 2 of 2. We&apos;ll review and approve your account
          shortly after this.
        </p>

        <form onSubmit={submit} className="space-y-3">
          <Field label="Business name" required>
            <input
              type="text"
              value={businessName}
              onChange={(e) => setBusinessName(e.target.value)}
              required
              autoFocus
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
            label="Business address"
            required
            hint={
              state
                ? `Suggestions are biased to ${state} since you filled in the State above.`
                : 'Start typing — we\'ll suggest addresses across the US. Filling in the State above narrows the suggestions.'
            }
          >
            {/* Same Google Places autocomplete Mary uses on the
                booking form (with Nominatim fallback when the vault
                doesn't have a Maps key configured). The stateBias
                prop tightens suggestions to whatever the prospect
                already entered in the State field above — typing
                "123 Main" with state="NH" surfaces NH addresses
                first instead of every "123 Main" in the country. */}
            <AddressInput
              value={address}
              onChange={setAddress}
              endpoint="/api/client/maps/places"
              stateBias={state}
              requireStreet
              placeholder="123 Main St, City, ST 12345"
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

          {/* Intake questions — recorded on the Client and shown in
              the admin Additional info panel so Mary has a quick
              reference when qualifying leads (preferred meeting
              format, weekend availability, battery backup offer). */}
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
                  className={`rounded-md border p-2.5 text-left text-xs font-semibold transition ${
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
            <Field label="Do you provide battery backup installs?" required>
              <YesNoToggle
                value={providesBatteryBackup}
                onChange={setProvidesBatteryBackup}
              />
            </Field>
          </div>

          <Field
            label="Website"
            hint="Optional — link admin can use to verify your business."
          >
            <input
              type="url"
              value={website}
              onChange={(e) => setWebsite(e.target.value)}
              placeholder="https://yourcompany.com"
              className="input"
            />
          </Field>

          <Field label="Package" required>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              {TIERS.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => !t.disabled && setTier(t.id)}
                  disabled={t.disabled}
                  aria-disabled={t.disabled}
                  className={`relative rounded-md border p-3 text-left transition ${
                    t.disabled
                      ? 'cursor-not-allowed border-zinc-200 bg-zinc-100 opacity-60 dark:border-zinc-800 dark:bg-zinc-900/40'
                      : tier === t.id
                        ? 'border-blue-500 bg-blue-50 dark:bg-blue-950'
                        : 'border-zinc-200 bg-white hover:bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-900 dark:hover:bg-zinc-800'
                  }`}
                >
                  <div className="flex items-center gap-2">
                    <div className="text-xs font-semibold">{t.label}</div>
                    {t.disabled && (
                      <span className="rounded-full border border-zinc-300 bg-white px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-zinc-500 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-400">
                        Coming soon
                      </span>
                    )}
                  </div>
                  <div className="text-[11px] text-zinc-500">{t.sub}</div>
                </button>
              ))}
            </div>
          </Field>

          {error && (
            <div className="flex items-start gap-2 rounded-md border border-red-200 bg-red-50 p-2 text-xs text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-200">
              <AlertCircle className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" />
              {error}
            </div>
          )}

          <button
            type="submit"
            disabled={
              submitting ||
              !businessName ||
              !fullName ||
              !phone ||
              !address ||
              !tier ||
              !appointmentTypes ||
              !bookWeekends ||
              !providesBatteryBackup
            }
            className="w-full rounded-lg bg-blue-600 px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-blue-700 disabled:opacity-50"
          >
            {submitting ? 'Submitting…' : 'Submit for review'}
          </button>
        </form>

        {/* Local input style — keeps the field markup clean. Tailwind
            doesn't support a true component class, so this is a
            scoped style. */}
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
      </div>
    </div>
  )
}

/** Yes / No segmented toggle for the intake question booleans.
 *  Forces an explicit answer (the parent's disabled-submit check
 *  reads `value !== ''` as "answered"). */
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
