import { redirect } from 'next/navigation'
import { auth } from '@/auth'
import { canAccessPayments } from '@/lib/payments-access'
import { PageHeader } from '@/components/ui/page-header'
import { PaymentsTabs } from './payments-tabs'

/**
 * /payments — admin-only section, gated to a tight email allowlist
 * (owner + Ethan), NOT role=admin, so Mary/Hannah can't reach it even
 * though they're admins. Server-side redirect enforces it regardless of
 * the nav link being hidden for them.
 *
 * Tabs: Stripe + Mercury dashboards (data proxied server-side via the
 * Vault keys) and a blank Automation Log.
 */
export default async function PaymentsPage() {
  const session = await auth()
  if (!canAccessPayments(session?.user?.email)) {
    redirect('/today')
  }

  return (
    <div className="mx-auto flex max-w-[1280px] flex-col gap-6">
      <PageHeader
        title="Payments"
        breadcrumbs={[{ label: 'Genisys' }, { label: 'Payments' }]}
      />
      <PaymentsTabs />
    </div>
  )
}
