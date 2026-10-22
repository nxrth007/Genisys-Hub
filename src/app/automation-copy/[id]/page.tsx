import { AutomationCopyBoard } from './board'

/** /automation-copy/[id] — copy-and-paste board for one client's GHL automations. */
export default async function AutomationCopyClientPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  return <AutomationCopyBoard clientId={id} />
}
