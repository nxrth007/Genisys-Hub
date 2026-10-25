import { notFound } from 'next/navigation'
import { appointmentByToken } from '@/lib/hl/booking'
import { BookingFrame } from '@/components/hell-level/booking-frame'
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
    <BookingFrame color={a.calendar?.color ?? '#155EEF'} business={a.business} logo={a.calendar?.logo ?? null} title="Your appointment" legal={a.calendar?.legal ?? null}>
      <ManageAppointment token={token} a={a} startCancelling={cancel === '1'} />
    </BookingFrame>
  )
}
