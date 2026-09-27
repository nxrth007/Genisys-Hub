import { redirect } from 'next/navigation'

/**
 * Hub root — straight redirect to /home.
 *
 * Home is the landing canvas (globe + search); Today remains one click
 * away in the sidebar. Agents and clients are already routed to /agent
 * and /client respectively by middleware before they reach this page,
 * so this redirect only fires for staff (admin / member).
 */
export default function HubRoot() {
  redirect('/home')
}
