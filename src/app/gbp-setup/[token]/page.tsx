import { notFound } from 'next/navigation'
import { publicSetup } from '@/lib/gbp-setup'
import { SetupView } from './setup-view'

export const dynamic = 'force-dynamic'

export const metadata = {
  title: 'Set up your Google Business Profile',
  robots: { index: false, follow: false },
}

/**
 * /gbp-setup/[token] — a client's Google Business Profile setup page. Public:
 * the secret token in the link is the access. Shows only their business
 * details (the answers to copy into Google), never internal notes.
 */
export default async function GbpSetupPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params
  const setup = await publicSetup(token)
  if (!setup) notFound()
  return <SetupView token={token} setup={setup} />
}
