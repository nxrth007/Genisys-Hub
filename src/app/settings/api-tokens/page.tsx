import { redirect } from 'next/navigation'
import { auth } from '@/auth'
import { PageHeader } from '@/components/ui/page-header'
import { ApiTokensClient } from './tokens-client'

/**
 * /settings/api-tokens — mint bearer tokens for externally-hosted
 * frontends (the Lovable-hosted Vite SPA).
 *
 * Admin-only: a token reads real client + appointment data. Gated here
 * server-side as well as inside the API, because /settings isn't
 * covered by the middleware's admin prefix list.
 */
export default async function ApiTokensPage() {
  const session = await auth()
  const role = (session?.user as { role?: string } | undefined)?.role
  if (role !== 'admin') redirect('/today')

  return (
    <div className="mx-auto flex max-w-[1280px] flex-col gap-6">
      <PageHeader
        title="API Tokens"
        subtitle="Bearer tokens that let an externally-hosted frontend read Hub data over the /api/external/v1 surface."
        breadcrumbs={[
          { label: 'Genisys' },
          { label: 'Settings', href: '/settings' },
          { label: 'API Tokens' },
        ]}
      />
      <ApiTokensClient />
    </div>
  )
}
