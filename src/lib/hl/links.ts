import { createHmac, timingSafeEqual } from 'node:crypto'
import { publicBase } from './twilio'

/**
 * GHL's trigger links: a link in a text that's unique to the contact, so
 * opening it is known to be theirs ("Trigger link clicked") before it sends
 * them on. Client sub-accounts have one, the review link
 * ({{trigger_link.review}}), which leads to the review survey.
 *
 * The token is the contact id and the link's name, signed, so nobody can
 * click on someone else's behalf.
 */

const secret = () => process.env.AUTH_SECRET || process.env.NEXTAUTH_SECRET || 'hell-level-links'
const sign = (body: string) => createHmac('sha256', secret()).update(`hl-link:${body}`).digest('base64url').slice(0, 16)

export function linkToken(contactId: string, link: string): string {
  const body = `${contactId}.${link}`
  return `${body}.${sign(body)}`
}

export function readLinkToken(token: string): { contactId: string; link: string } | null {
  const parts = token.split('.')
  if (parts.length !== 3) return null
  const [contactId, link, sig] = parts
  if (!/^[\w-]{1,40}$/.test(contactId) || !/^[a-z_]{1,30}$/.test(link)) return null
  const want = Buffer.from(sign(`${contactId}.${link}`))
  const got = Buffer.from(sig)
  return want.length === got.length && timingSafeEqual(want, got) ? { contactId, link } : null
}

/** The contact's own copy of a tracked link. */
export const trackedLink = (contactId: string, link = 'review') => `${publicBase()}/hl/l/${linkToken(contactId, link)}`

/** Link previews (iMessage, WhatsApp, Facebook…) fetch links on their own; those aren't clicks. */
export const isPreviewBot = (userAgent: string | null) => /bot|crawler|spider|preview|facebookexternalhit|whatsapp|slack|discord|telegram|skypeuripreview|curl|wget/i.test(userAgent ?? '')
