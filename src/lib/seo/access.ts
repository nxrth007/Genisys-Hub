import { canAccessPayments } from '@/lib/payments-access'

/**
 * Who can see and drive the SEO engine: the same email allowlist as
 * Payments (Alex + Ethan). Not a role check — admins like Mary and Hannah
 * must not be able to commit to client sites.
 */
export function canAccessSeo(email: string | null | undefined): boolean {
  return canAccessPayments(email)
}
