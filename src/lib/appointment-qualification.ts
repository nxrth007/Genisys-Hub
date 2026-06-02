/**
 * Helper for the PPA invoicing automation's "is this a billable
 * status update" decision. Centralized so every status-change
 * endpoint (client dashboard, call-center staff edit, agent edit,
 * master-tracker inline edit) follows the SAME rule:
 *
 *   - The actor's role must be admin / member / client_active.
 *     Mary (role=agent) and team-* roles can mark "showed" all day
 *     long but it never triggers an invoice.
 *
 *   - The new status must be one of {showed, won, lost} — all
 *     three imply the customer attended (won/lost are sit-down
 *     outcomes ON TOP of an implicit showed).
 *
 * Returns the timestamp to write to qualifyingStatusUpdatedAt, or
 * null when the update shouldn't trigger billing. Callers spread
 * the result into their Prisma update payload:
 *
 *   const qa = qualifyingTimestampFor(role, newStatus)
 *   if (qa) data.qualifyingStatusUpdatedAt = qa
 *
 * Per Alex 2026-06-02: this is the ONLY field the PPA invoicing
 * cron filters on. clientStatusUpdatedAt still drives the Status
 * Updates triage page (which is client-only by design) — the two
 * fields are intentionally independent.
 */

const BILLABLE_STATUSES = new Set(['showed', 'won', 'lost'])

/** Roles authorized to mark an appointment billable. Mary's
 *  'agent' role is deliberately absent — her advisory marks help
 *  Ethan track pipeline but never bill the client. */
const QUALIFYING_ROLES = new Set([
  'admin',
  'member',
  'client_active',
])

export function qualifyingTimestampFor(
  role: string | undefined | null,
  newStatus: string | undefined | null,
): Date | null {
  if (!role || !QUALIFYING_ROLES.has(role)) return null
  if (!newStatus || !BILLABLE_STATUSES.has(newStatus.toLowerCase())) return null
  return new Date()
}

/** Read-only check (no timestamp) for diagnostics / UI hints —
 *  e.g. an admin button can say "this update will trigger billing"
 *  without actually firing it. */
export function wouldQualifyForInvoicing(
  role: string | undefined | null,
  newStatus: string | undefined | null,
): boolean {
  return qualifyingTimestampFor(role, newStatus) !== null
}
