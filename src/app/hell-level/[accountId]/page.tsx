import { redirect } from 'next/navigation'

/** A sub-account opens on its Launchpad, like GHL. */
export default async function AccountHome({ params }: { params: Promise<{ accountId: string }> }) {
  redirect(`/hell-level/${(await params).accountId}/launchpad`)
}
