import { A2pBoard } from './a2p-board'

/** /clients/[id]/a2p — copy-and-paste board for the client's A2P 10DLC registration in GHL. */
export default async function ClientA2pPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  return <A2pBoard clientId={id} />
}
