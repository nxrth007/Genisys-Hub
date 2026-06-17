import { CallbackForm } from '@/components/agent/callback-form'

/**
 * New callback. Accepts optional ?name= & ?phone= query params so the
 * Agent → Alerts "Log callback" button can pre-fill the customer who
 * declined / no-showed — one tap from alert to a half-filled form.
 */
export default async function NewCallbackPage({
  searchParams,
}: {
  searchParams: Promise<{ name?: string; phone?: string }>
}) {
  const sp = await searchParams
  const initial = {
    ...(sp.name ? { customerName: sp.name } : {}),
    ...(sp.phone ? { customerPhone: sp.phone } : {}),
  }
  return <CallbackForm mode="create" initial={initial} />
}
