/**
 * Agent-side Reminders viewer. Re-exports the staff Call Center →
 * Reminders page so Mary sees the exact same operational view —
 * pending / sent / failed rows, with per-row Cancel and Send-Now
 * actions on the appropriate statuses.
 *
 * What's gated separately (still staff-only): the master enable,
 * template editing, quiet hours, and the test-send block. Those
 * live in /settings, which agents can't reach. The middleware opens
 * /api/call-center/reminders (listing) and /api/admin/reminders/[id]
 * (per-row mutations) for the agent role; everything else stays
 * locked behind requireStaff() at the route level.
 */
export { default } from '../../call-center/reminders/page'
