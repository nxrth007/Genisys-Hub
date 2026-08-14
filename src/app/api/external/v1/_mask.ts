/**
 * PII masking for the external API.
 *
 * The Lovable frontend is a browser app on a shareable preview URL. It
 * needs realistic data SHAPES to design against, not real consumers'
 * contact details, so end-customer phone/email are masked here. Client
 * (B2B) contacts are left intact — those are business contacts the team
 * already shares freely.
 *
 * Unmasking later is a one-line change, but it should be a deliberate
 * decision rather than a default.
 */

export function maskPhone(phone: string | null): string | null {
  if (!phone) return null
  const digits = phone.replace(/\D/g, '')
  if (digits.length < 4) return '•••'
  return `(•••) •••-${digits.slice(-4)}`
}

export function maskEmail(email: string | null): string | null {
  if (!email) return null
  const [user, domain] = email.split('@')
  if (!domain) return '•••'
  return `${(user ?? '').slice(0, 2)}•••@${domain}`
}
