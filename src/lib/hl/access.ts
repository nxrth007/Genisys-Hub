import { canAccessPayments } from '@/lib/payments-access'

/**
 * Who can open Hell-level: the same email allowlist as Payments and SEO
 * (Alex + Ethan). It holds every client's leads and can buy phone numbers,
 * so admins like Mary and Hannah don't get it by role. Widen here.
 */
export function canAccessHellLevel(email: string | null | undefined): boolean {
  return canAccessPayments(email)
}
