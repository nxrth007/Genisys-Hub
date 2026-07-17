/**
 * Access control for the Payments section.
 *
 * Deliberately an EMAIL allowlist, not a role check: Mary + Hannah are
 * admins now (promoted for master-tracker edit access), but must NOT see
 * Payments. Only the owner + Ethan. Keep this in sync anywhere Payments
 * is gated (the sidebar nav item + the /payments page).
 */
export const PAYMENTS_ALLOWED_EMAILS = [
  'alex@leadgenisys.com',
  'ethan@leadgenisys.com',
]

export function canAccessPayments(email: string | null | undefined): boolean {
  return !!email && PAYMENTS_ALLOWED_EMAILS.includes(email.toLowerCase())
}
