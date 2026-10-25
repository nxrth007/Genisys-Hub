import { AlertTriangle } from 'lucide-react'
import { cn } from '@/lib/utils'
import { looksLikeAddress } from '@/lib/address-parse'

/**
 * Some clients type their address into the onboarding form's "Legal
 * Business Name" box. The A2P and Toll-Free boards don't use it then
 * (src/lib/a2p.ts takes the client record's name, or leaves it blank), and
 * this says why.
 */
export function OnboardingNameNote({ onboardingName, businessName }: { onboardingName: string | null; businessName: string }) {
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
