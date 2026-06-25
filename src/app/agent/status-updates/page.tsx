/**
 * Agent-side Status Updates. Re-exports the staff triage page so
 * admin-access agents (Mary / Hannah, who work out of the /agent
 * portal) can see the status updates clients report for each booked
 * appointment — identical data + controls to the Call Center view.
 *
 * The page calls /api/call-center/status-updates, which gates to
 * admin/member; Mary + Hannah are admins, so it resolves. The nav
 * link in AgentShell only renders for admins, so non-admin agents
 * never see it (and the API would 403 them anyway).
 */
export { default } from '../../call-center/status-updates/page'
