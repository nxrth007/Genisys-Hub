import type { ExternalAuth } from '@/lib/external-api'

/**
 * Helpers for the CRM surface.
 *
 * GHL returns untyped objects whose shapes drift between endpoints, so
 * everything is normalized here rather than passed through raw — the
 * frontend should never have to guess whether a date is an ISO string or
 * Unix milliseconds.
 */

export type RawObj = Record<string, unknown>

const str = (v: unknown): string | null =>
  typeof v === 'string' && v.trim() ? v.trim() : null

/** GHL sends dates as ISO strings in some places and Unix ms in others. */
export function toIso(v: unknown): string | null {
  if (typeof v === 'number' && Number.isFinite(v)) {
    return new Date(v).toISOString()
  }
  if (typeof v === 'string' && v.trim()) {
    const d = new Date(v)
    return isNaN(d.getTime()) ? null : d.toISOString()
  }
  return null
}

export type CrmConversation = {
  id: string
  contactId: string | null
  contactName: string | null
  contactEmail: string | null
  contactPhone: string | null
  lastMessageBody: string | null
  lastMessageDate: string | null
  lastMessageType: string | null
  unreadCount: number
}

export function normalizeConversation(c: RawObj): CrmConversation {
  return {
    id: String(c.id ?? ''),
    contactId: str(c.contactId),
    contactName: str(c.contactName) ?? str(c.fullName),
    contactEmail: str(c.contactEmail) ?? str(c.email),
    contactPhone: str(c.contactPhone) ?? str(c.phone),
    lastMessageBody: str(c.lastMessageBody),
    lastMessageDate: toIso(c.lastMessageDate),
    lastMessageType: str(c.lastMessageType) ?? str(c.type),
    unreadCount: Number(c.unreadCount ?? 0) || 0,
  }
}

export type CrmMessage = {
  id: string
  body: string | null
  direction: 'inbound' | 'outbound'
  dateAdded: string | null
  messageType: string | null
  attachments: string[]
}

export function normalizeMessage(m: RawObj): CrmMessage {
  const rawType = m.messageType ?? m.type
  // Numeric types come from the older GHL shape: 1 call, 2 SMS, 3 email.
  const typeMap: Record<string, string> = {
    '1': 'TYPE_CALL',
    '2': 'TYPE_SMS',
    '3': 'TYPE_EMAIL',
  }
  const messageType =
    typeof rawType === 'number'
      ? (typeMap[String(rawType)] ?? `TYPE_${rawType}`)
      : str(rawType)

  const attachments = Array.isArray(m.attachments)
    ? (m.attachments
        .map((a) =>
          typeof a === 'string'
            ? a
            : str((a as RawObj | null)?.url) ?? str((a as RawObj | null)?.link),
        )
        .filter(Boolean) as string[])
    : []

  return {
    id: String(m.id ?? ''),
    body: str(m.body),
    // Anything not explicitly outbound is treated as inbound, matching
    // how the Hub renders these.
    direction: m.direction === 'outbound' ? 'outbound' : 'inbound',
    dateAdded: toIso(m.dateAdded),
    messageType,
    attachments,
  }
}

/**
 * CRM data is customer conversation content — the most sensitive thing
 * this API exposes. It requires a real signed-in account; the shared
 * environment token (which has no user behind it, can't be revoked
 * without a redeploy, and isn't attributable to a person) is not enough.
 */
export function requireUser(auth: ExternalAuth): string | null {
  if (!auth.user) {
    return 'CRM access requires a signed-in account. The shared environment token cannot read conversations.'
  }
  return null
}
