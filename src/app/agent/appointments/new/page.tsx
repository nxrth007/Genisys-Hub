import { AppointmentForm } from '@/components/agent/appointment-form'

/**
 * Booking entry point. Used by Mary on the agent flow, and by admin /
 * member (Alex, Ethan) when they click "+ Add appointment" from the
 * client detail modal on /clients — middleware lets staff preview
 * /agent pages, so the same route doubles as the admin-booked path.
 *
 * Optional ?clientId=<cuid> query param pre-selects the client in the
 * form. Lets the +Add-appointment button on the client modal land
 * directly on a form that's already scoped to the right business
 * (Mary's flow leaves the picker empty so she chooses each time).
 *
 * Unknown / inactive clientId values silently fall back to an empty
 * picker — the form's onChange handlers will reject a bad clientId
 * at submit time, but a stale URL shouldn't crash the page.
 */
export default async function NewAppointmentPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const params = await searchParams
  const raw = params.clientId
  const clientId = typeof raw === 'string' ? raw.trim() : ''

  if (!clientId) {
    return <AppointmentForm mode="create" />
  }

  // Pre-select the client. The form normalizes the empty defaults for
  // every other field, so we only override clientId.
  return (
    <AppointmentForm
      mode="create"
      initial={{
        apptDateTime: '',
        clientId,
        customerName: '',
        customerPhone: '',
        address: '',
        email: '',
        monthlyBill: '',
        utilityProvider: '',
        roofType: '',
        roofAge: '',
        status: 'booked',
        estimatedDealValue: '',
        notes: '',
        callRecordingLink: '',
        bookedByName: '',
      }}
    />
  )
}
