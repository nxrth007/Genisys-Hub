import { redirect } from 'next/navigation'
import { Wallet } from 'lucide-react'
import { auth } from '@/auth'
import { canAccessPayments } from '@/lib/payments-access'
import { PageHeader } from '@/components/ui/page-header'

/**
 * /payments — admin-only section, gated to a tight email allowlist
 * (owner + Ethan), NOT role=admin, so Mary/Hannah can't reach it even
 * though they're admins. Server-side redirect enforces it regardless of
 * the nav link being hidden for them.
 *
 * Placeholder for now — scaffolded per Alex; content to follow.
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
      <div className="rounded-2xl border border-dashed border-border bg-card p-12 text-center">
        <div className="mx-auto mb-3 grid h-12 w-12 place-items-center rounded-xl bg-primary-soft text-primary">
          <Wallet className="h-6 w-6" />
        </div>
        <p className="text-sm font-semibold text-foreground">
          Payments is set up
        </p>
        <p className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">
          This section is ready and locked to admins only (not Mary or
          Hannah). Tell Claude what you want it to do — track client
          payments, agent payouts, a billing overview — and it&apos;ll build
          it out here.
        </p>
      </div>
    </div>
  )
}
