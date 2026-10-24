'use client'

import { useQuery } from '@tanstack/react-query'
import type { HlProfile } from '@/lib/hl/types'
import type { LaunchItem } from '@/lib/hl/launchpad'
import { Badge, hlFetch } from './ui'

/** Shared pieces of the Hell-level pages. */

export type PhoneNumberRow = {
  id: string
  number: string
  kind: string
  forwardTo: string | null
  whisper: boolean
  isDefault: boolean
  status: string
  verificationStatus: string
  verificationSid: string | null
  verificationNote: string | null
  verificationAt: string | null
  createdAt: string
}

export type AccountDetail = {
  account: { id: string; name: string; clientId: string | null; timezone: string; profile: HlProfile; createdAt: string }
  numbers: PhoneNumberRow[]
  launchpad: { items: LaunchItem[]; done: number; total: number }
  client: { id: string; name: string; siteUrl: string | null } | null
}

export function useAccount(accountId: string) {
  return useQuery<AccountDetail>({
    queryKey: ['hl', 'account', accountId],
    queryFn: () => hlFetch<AccountDetail>(`/api/hl/accounts/${accountId}`),
    enabled: !!accountId,
  })
}

export function textingBadge(n: { kind: string; verification?: string; verificationStatus?: string } | null) {
  if (!n) return <Badge color="gray">No number</Badge>
  const v = n.verification ?? n.verificationStatus ?? 'none'
  if (n.kind !== 'toll_free') return <Badge color="amber">Local: needs A2P</Badge>
  if (v === 'approved') return <Badge color="green" dot>Texting live</Badge>
  if (v === 'rejected') return <Badge color="red" dot>Verification rejected</Badge>
  if (v === 'pending' || v === 'in_review') return <Badge color="blue" dot>Verification in review</Badge>
  return <Badge color="amber" dot>Verification not filed</Badge>
}

export type ContactRow = {
  id: string
  firstName: string | null
  lastName: string | null
  phone: string | null
  email: string | null
  tags: string[]
  source: string | null
  smsConsent: boolean
  dnd: boolean
  fields: Record<string, unknown>
  lastMessageAt: string | null
  lastMessage: string | null
  unread: number
  createdAt: string
}

export const contactLabel = (c: { firstName?: string | null; lastName?: string | null; phone?: string | null; email?: string | null }) =>
  [c.firstName, c.lastName].filter(Boolean).join(' ') || c.phone || c.email || 'Unknown'

export const SOURCE_LABEL: Record<string, string> = { form: 'Website form', chat: 'Chat widget', call: 'Phone call', sms: 'Text message', manual: 'Added by hand' }
