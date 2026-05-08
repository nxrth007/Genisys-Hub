import { redirect } from 'next/navigation'

/**
 * Hub root — straight redirect to /today.
 *
 * Per Ethan: the welcome / module-grid page that used to live here
 * was redundant with the sidebar nav and made him double-click to
 * actually start his day. Staff land on Today (the tasks + meetings
 * checklist) the moment they hit the Hub.
 *
 * Agents and clients are already routed to /agent and /client
 * respectively by middleware before they reach this page, so this
 * redirect only fires for staff (admin / member).
 */
export default function HubRoot() {
  redirect('/today')
}
