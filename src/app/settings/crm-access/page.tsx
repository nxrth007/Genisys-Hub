import { redirect } from 'next/navigation'
import { auth } from '@/auth'
import { PageHeader } from '@/components/ui/page-header'
import { CrmAccessClient } from './crm-access-client'

/**
 * /settings/crm-access — approve who can sign in to the CRM frontend.
 *
 * Admin-only: approving here is what grants a person access to real
 * client and appointment data.
 */
export default async function CrmAccessPage() {
  const session = await auth()
  const role = (session?.user as { role?: string } | undefined)?.role
  if (role !== 'admin') redirect('/today')

  return (
    <div className="mx-auto flex max-w-[1280px] flex-col gap-6">
      <PageHeader
        title="CRM Access"
        subtitle="People who can sign in to the externally-hosted CRM frontend. Approving grants read access to live client data."
        breadcrumbs={[
          { label: 'Genisys' },
          { label: 'Settings', href: '/settings' },
          { label: 'CRM Access' },
        ]}
      />
      <CrmAccessClient />
    </div>
  )
}
