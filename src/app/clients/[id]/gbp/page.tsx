import { GbpBoardView } from './gbp-board'

/** /clients/[id]/gbp — Google Business Profile setup: find an existing listing, the create kit, verification texts, and recording it. */
export default async function ClientGbpPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  return <GbpBoardView clientId={id} />
}
