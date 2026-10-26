import { AlertTriangle } from 'lucide-react'
import { cn } from '@/lib/utils'
import { looksLikeAddress } from '@/lib/address-parse'

/**
 * Some clients answer the onboarding form's "Legal Business Name" with their
 * address, or swap it with "Business Address". The A2P and Toll-Free boards
 * don't take an address as the name (onboardingNameAndAddress in
 * src/lib/a2p.ts puts swapped boxes back, else uses the client record's name
 * or none), and this says what happened.
 */
export function OnboardingNameNote({
  onboardingName,
  onboardingAddress,
  swapped,
  businessName,
}: {
  onboardingName: string | null
  onboardingAddress: string | null
  swapped: boolean
  businessName: string
}) {
  if (swapped) {
    return (
      <p className="flex items-start gap-2 rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-[13px]">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" />
        <span>
          <span className="font-semibold">On the onboarding form, the business name and address were swapped:</span> “Legal Business Name” says
          “{onboardingName}” and “Business Address” says “{onboardingAddress}”. They’re put back the right way round here. Check both against their IRS
          EIN letter (CP-575), and fix the client in the Hub too (Edit on the client).
        </span>
      </p>
    )
  }
  if (!looksLikeAddress(onboardingName)) return null
  const filled = !!businessName.trim()
  return (
    <p
      className={cn(
        'flex items-start gap-2 rounded-xl border px-4 py-3 text-[13px]',
        filled ? 'border-border bg-surface text-muted-foreground' : 'border-amber-500/30 bg-amber-500/10',
      )}
    >
      <AlertTriangle className={cn('mt-0.5 h-4 w-4 shrink-0', filled ? 'text-muted-foreground' : 'text-amber-500')} />
      <span>
        <span className="font-semibold">On the onboarding form, “Legal Business Name” was answered with an address</span> (“{onboardingName}”), so it isn’t
        used here.{' '}
        {filled
          ? 'Business name comes from the client record instead. Check it against their IRS EIN letter (CP-575).'
          : 'Ask the client for the business’s legal name: it’s on their IRS EIN letter (CP-575), above the mailing address. Fix the client’s name in the Hub too (Edit on the client).'}
      </span>
    </p>
  )
}
