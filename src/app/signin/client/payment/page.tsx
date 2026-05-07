'use client'

/**
 * Step 3 of the client onboarding funnel — package payment.
 *
 * Renders QuickBooks payment links specific to whichever package the
 * client selected on the onboarding form. Per Ethan's request: this
 * is a friction-light prompt, not a gate. They can always click
 * "I'll pay later" and the application still goes to the Pending tab
 * for admin review.
 *
 * Links are hardcoded here because they're public (clients click them
 * to pay) and rotation is rare. If they ever change, update the
 * PAYMENT_LINKS map below — no env var or redeploy required beyond
 * editing this file.
 *
 * Pro tier deliberately has no QB link: QuickBooks multi-use links
 * cap at $5,000 and Pro is above that. We surface a "we'll send you
 * a custom invoice" note so the user knows next steps without
 * thinking the page is broken.
 */
import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import Image from 'next/image'
import {
  CreditCard,
  ExternalLink,
  Loader2,
  Building2,
  Mail,
  ArrowRight,
} from 'lucide-react'

type Me = {
  user: { id: string; email: string | null; name: string | null; role: string }
  client: {
    id: string
    name: string
    state: string | null
    package: string
    lifecycle: string
    contactName: string | null
  } | null
}

/** QuickBooks CommerceNetwork multi-use payment links per package.
 *  Update these here when Alex regenerates them in QuickBooks. */
const PAYMENT_LINKS = {
  ppa: [
    {
      label: 'Pay-per-appointment',
      sub: 'Pay only for appointments delivered',
      href: 'https://connect.intuit.com/portal/app/CommerceNetwork/view/scs-v1-79be52eea5f14990ae7878c815bfe43016f70066400b4087900960429a5fec5ad357b2a3317d436ba8641e17294e32b9?locale=EN_US&cta=copylistmultilink',
    },
  ],
  growth: [
    {
      label: 'Pay in full',
      sub: 'Full Growth Pack upfront',
      href: 'https://connect.intuit.com/portal/app/CommerceNetwork/view/scs-v1-0be6ac9dd5284657844ac4bdc6a1979df1225b9fb03e4ef68904c5c7e34e7e514ca7733b77c74779be562b19b1a8d296?locale=EN_US&cta=copylistmultilink',
    },
    {
      label: 'Pay 50% upfront',
      sub: 'Half upfront, half on delivery',
      href: 'https://connect.intuit.com/portal/app/CommerceNetwork/view/scs-v1-a75df6c170b84feab5937e150c73a7adeedef7763faa4938b1f4a8a457fdcc41fb2c2c1498dc48a193a3b94381cbfacf?locale=EN_US&cta=copylistmultilink',
    },
  ],
  // Pro + custom intentionally left empty — UI handles those cases
  // with a custom-invoice message instead of payment buttons.
} as const

const PACKAGE_LABEL: Record<string, string> = {
  ppa: 'Pay-per-appointment',
  growth: 'Growth Pack',
  pro: 'Pro Pack',
  custom: 'Custom',
}

export default function ClientPaymentPage() {
  const router = useRouter()
  const [me, setMe] = useState<Me | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    fetch('/api/client/me')
      .then(async (res) => {
        const data = await res.json().catch(() => ({}))
        if (cancelled) return
        if (!res.ok) {
          setLoadError(data.error || 'Failed to load your account.')
          return
        }
        setMe(data as Me)
      })
      .catch((err) => {
        if (cancelled) return
        setLoadError(err instanceof Error ? err.message : String(err))
      })
    return () => {
      cancelled = true
    }
  }, [])

  function continueToPending() {
    router.push('/signin/client/pending')
    router.refresh()
  }

  const pkg = me?.client?.package ?? 'custom'
  const links = PAYMENT_LINKS[pkg as 'ppa' | 'growth'] ?? null
  const isProOrCustom = pkg === 'pro' || pkg === 'custom'

  return (
    <div className="flex min-h-[calc(100vh-64px)] items-center justify-center bg-gradient-to-b from-zinc-50 to-zinc-100 px-4 py-10 dark:from-zinc-950 dark:to-zinc-900">
      <div className="w-full max-w-md rounded-xl border border-zinc-200 bg-white p-8 shadow-lg dark:border-zinc-800 dark:bg-zinc-900">
        <div className="mb-5 flex items-center justify-center">
          <Image
            src="/genisys-logo.png"
            alt="Lead Genisys"
            width={450}
            height={150}
            priority
            className="h-auto w-44 dark:invert"
          />
        </div>

        <div className="mb-2 flex items-center justify-center gap-2 text-sm font-medium text-blue-600">
          <CreditCard className="h-4 w-4" />
          Set up your payment
        </div>
        <p className="mb-6 text-center text-xs text-zinc-500">
          Application submitted. Last optional step: get your payment
          on file. We&apos;ll review your application either way.
        </p>

        {loadError ? (
          <div className="rounded-md border border-red-200 bg-red-50 p-3 text-xs text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-200">
            {loadError}
          </div>
        ) : !me ? (
          <div className="flex items-center justify-center py-6">
            <Loader2 className="h-5 w-5 animate-spin text-zinc-400" />
          </div>
        ) : (
          <>
            {/* Package banner — confirms which tier they're paying
                for so they're not guessing. */}
            <div className="mb-5 rounded-lg border border-zinc-200 bg-zinc-50 p-3 text-xs dark:border-zinc-800 dark:bg-zinc-950">
              <div className="flex items-center gap-2 font-medium">
                <Building2 className="h-3.5 w-3.5 text-zinc-500" />
                {me.client?.name ?? 'Your business'}
              </div>
              <div className="mt-1 text-zinc-500">
                Selected package:{' '}
                <span className="font-semibold text-zinc-700 dark:text-zinc-200">
                  {PACKAGE_LABEL[pkg] ?? pkg}
                </span>
              </div>
            </div>

            {isProOrCustom ? (
              <div className="rounded-md border border-amber-200 bg-amber-50 p-4 text-xs dark:border-amber-900 dark:bg-amber-950">
                <div className="flex items-center gap-2 font-semibold text-amber-800 dark:text-amber-200">
                  <Mail className="h-3.5 w-3.5" />
                  We&apos;ll send a custom invoice
                </div>
                <p className="mt-1 text-amber-700 dark:text-amber-300">
                  {pkg === 'pro'
                    ? 'The Pro Pack is invoiced separately so we can match the deal terms exactly. Your account manager will email payment instructions shortly after we approve your application.'
                    : 'For custom arrangements we work out pricing together first. Your account manager will reach out shortly to finalize details.'}
                </p>
              </div>
            ) : links ? (
              <div className="space-y-2">
                {links.map((l) => (
                  <a
                    key={l.href}
                    href={l.href}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center justify-between gap-3 rounded-lg border border-zinc-200 bg-white p-4 transition hover:border-blue-500 hover:bg-blue-50 dark:border-zinc-700 dark:bg-zinc-900 dark:hover:border-blue-500 dark:hover:bg-blue-950"
                  >
                    <div>
                      <div className="text-sm font-semibold">{l.label}</div>
                      <div className="text-xs text-zinc-500">{l.sub}</div>
                    </div>
                    <ExternalLink className="h-4 w-4 flex-shrink-0 text-zinc-400" />
                  </a>
                ))}
                <p className="pt-1 text-center text-[11px] text-zinc-400">
                  Payment opens in a new tab via QuickBooks. Your application
                  is already submitted — paying now just speeds setup.
                </p>
              </div>
            ) : (
              <div className="rounded-md border border-zinc-200 bg-zinc-50 p-3 text-xs text-zinc-500 dark:border-zinc-800 dark:bg-zinc-950">
                We don&apos;t have a payment link configured for this
                package. Your account manager will reach out with next steps.
              </div>
            )}

            <button
              type="button"
              onClick={continueToPending}
              className="mt-6 inline-flex w-full items-center justify-center gap-2 rounded-lg border border-zinc-200 bg-white px-4 py-2.5 text-sm font-medium text-zinc-700 transition hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200 dark:hover:bg-zinc-800"
            >
              {isProOrCustom ? 'Continue' : "I'll pay later"}
              <ArrowRight className="h-3.5 w-3.5" />
            </button>
          </>
        )}
      </div>
    </div>
  )
}
