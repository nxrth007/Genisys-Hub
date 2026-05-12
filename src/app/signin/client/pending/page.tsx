import { redirect } from 'next/navigation'

/**
 * Legacy route — the "waiting for approval" screen used to live here.
 * As of 2026-05-11 it's rendered inside /client (PrePayAwaitingApproval)
 * so prospects don't get bounced around between routes. Kept as a
 * redirect so old bookmarks don't break.
 */
export default function LegacyPendingRedirect() {
  redirect('/client')
}
