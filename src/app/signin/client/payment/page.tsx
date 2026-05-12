import { redirect } from 'next/navigation'

/**
 * Legacy route — payment used to be its own step. As of 2026-05-11 the
 * plan picker + QuickBooks links live inside /client (PrePayPlanPicker),
 * so this page just bounces to /client. Kept around so old bookmarks
 * and emailed links don't break.
 */
export default function LegacyPaymentRedirect() {
  redirect('/client')
}
