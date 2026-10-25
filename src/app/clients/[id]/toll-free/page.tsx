import { TollFreeBoard } from './toll-free-board'

/** /clients/[id]/toll-free — copy-and-paste board for verifying the client's toll-free number in GHL. */
export default async function ClientTollFreePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  return <TollFreeBoard clientId={id} />
}
