import { notFound } from 'next/navigation'
import { appointmentByToken } from '@/lib/hl/booking'
import { ManageAppointment } from '@/components/hell-level/manage-appointment'

export const dynamic = 'force-dynamic'

type Props = { params: Promise<{ token: string }>; searchParams: Promise<{ cancel?: string }> }

export const metadata = { title: 'Your appointment', robots: { index: false } }

/** The reschedule / cancel link in a booking's texts. The long random token is the access. */
export default async function AppointmentPage({ params, searchParams }: Props) {
  const { token } = await params
  const a = await appointmentByToken(token)
  if (!a) notFound()
  const { cancel } = await searchParams
  return (
    <div className="min-h-screen bg-white text-[#101828]" style={{ colorScheme: 'light', ['--hl-c' as string]: a.calendar?.color ?? '#155EEF' }}>
      <style>{'html,body{background:#fff!important;color-scheme:light}'}</style>
      <main className="mx-auto w-full max-w-2xl px-5 py-8">
        <ManageAppointment token={token} a={a} startCancelling={cancel === '1'} />
      </main>
    </div>
  )
}
