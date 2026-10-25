'use client'

import { useParams } from 'next/navigation'
import { AskAi } from '@/components/hell-level/ask-ai'
import { useAccount } from '@/components/hell-level/bits'

/** Ask AI for one sub-account (src/lib/hl/ask.ts). */
export default function AskAiPage() {
  const { accountId } = useParams<{ accountId: string }>()
  const account = useAccount(accountId)
  return <AskAi key={accountId} accountId={accountId} name={account.data?.account.name ?? null} />
}
