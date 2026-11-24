'use client'

import { useSyncExternalStore } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { HlProfile } from '@/lib/hl/types'
import type { LaunchItem } from '@/lib/hl/launchpad'
import { Badge, hlFetch } from './ui'

/** Shared pieces of the Genisys OS pages. */

export type PhoneNumberRow = {
  id: string
  number: string
  kind: string
  forwardTo: string | null
  forwardTextsTo: string | null
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
  /** ghlLocationId: the GHL location it was imported from (Lead Genisys); null for every client. */
  account: { id: string; name: string; clientId: string | null; ghlLocationId: string | null; timezone: string; profile: HlProfile; createdAt: string }
  numbers: PhoneNumberRow[]
  launchpad: { items: LaunchItem[]; done: number; total: number }
  client: { id: string; name: string; siteUrl: string | null } | null
}

const never = () => () => {}

/**
 * The page's origin, for links and embed code that leave the Hub. '' on the server and while
 * hydrating, so the HTML matches what the client first renders, then the real one.
 */
export function useOrigin(): string {
  return useSyncExternalStore(never, () => window.location.origin, () => '')
}

export function useAccount(accountId: string) {
  return useQuery<AccountDetail>({
    queryKey: ['hl', 'account', accountId],
    queryFn: () => hlFetch<AccountDetail>(`/api/hl/accounts/${accountId}`),
    enabled: !!accountId,
  })
}

export type EmailSendSetup = { status: string; fromLocal: string; rootDomain: string } | null

/**
 * Whether the sub-account can send email (Settings → Email Services): the
 * composer, the contact card and the workflow builder offer email only once
 * it's `active`. A light read: no Mailgun call.
 */
export function useEmailSetup(accountId: string) {
  return useQuery<{ setup: EmailSendSetup }>({
    queryKey: ['hl', 'email-send', accountId],
    queryFn: () => hlFetch(`/api/hl/accounts/${accountId}/email?send=1`),
    enabled: !!accountId,
    staleTime: 60_000,
  })
}

export function textingBadge(n: { kind: string; verification?: string; verificationStatus?: string } | null) {
  if (!n) return <Badge color="gray">No number</Badge>
  const v = n.verification ?? n.verificationStatus ?? 'none'
  const what = n.kind === 'toll_free' ? 'Verification' : 'A2P'
  if (v === 'approved') return <Badge color="green" dot>Texting live</Badge>
  if (v === 'rejected') return <Badge color="red" dot>{what} rejected</Badge>
  if (v === 'pending' || v === 'in_review') return <Badge color="blue" dot>{what} in review</Badge>
  return <Badge color="amber" dot>{what} not filed</Badge>
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
  /** Unsubscribed from email, or it bounced or was marked spam (emailDndReason says which). */
  emailDnd?: boolean
  emailDndReason?: string | null
  starred: boolean
  fields: Record<string, unknown>
  lastMessageAt: string | null
  lastMessage: string | null
  unread: number
  createdAt: string
}

export const contactLabel = (c: { firstName?: string | null; lastName?: string | null; phone?: string | null; email?: string | null }) =>
  [c.firstName, c.lastName].filter(Boolean).join(' ') || c.phone || c.email || 'Unknown'

export const SOURCE_LABEL: Record<string, string> = { form: 'Website form', chat: 'Chat widget', call: 'Phone call', sms: 'Text message', manual: 'Added by hand' }
