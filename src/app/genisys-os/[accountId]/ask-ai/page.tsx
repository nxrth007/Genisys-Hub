'use client'

import { useParams } from 'next/navigation'
import { AskAi } from '@/components/genisys-os/ask-ai'
import { useAccount } from '@/components/genisys-os/bits'

/** Ask AI for one sub-account (src/lib/hl/ask.ts). */
export default function AskAiPage() {
  const { accountId } = useParams<{ accountId: string }>()
  const account = useAccount(accountId)
  return <AskAi key={accountId} accountId={accountId} name={account.data?.account.name ?? null} />
}
