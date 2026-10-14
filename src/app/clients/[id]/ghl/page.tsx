import { SubAccountBoard } from './subaccount-board'

/** /clients/[id]/ghl — copy-and-paste board for creating the client's GHL sub-account by hand, then linking it. */
export default async function ClientGhlPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  return <SubAccountBoard clientId={id} />
}
