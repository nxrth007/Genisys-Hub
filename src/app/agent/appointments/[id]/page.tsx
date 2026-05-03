'use client'

import { use } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Loader2 } from 'lucide-react'
import {
  AppointmentForm,
  type AppointmentFormValues,
} from '@/components/agent/appointment-form'
import { resolveCustomerTimezone } from '@/lib/timezone'

type Appointment = {
  id: string
  apptDateTime: string
  clientId: string | null
  client: { id: string; name: string; state: string | null; color: string } | null
  customerName: string
  customerPhone: string
  address: string | null
  email: string | null
  monthlyBill: string | null
  utilityProvider: string | null
  roofType: string | null
  roofAge: string | null
  status: string
  estimatedDealValue: string | null
  notes: string | null
  callRecordingLink: string | null
  bookedByName: string | null
  /** Snapshotted Solar API summary from booking time. Shape matches
   *  lib/solar.ts SolarSummary; typed loose here so the form
   *  component owns the strict typing. */
  solarSummary: unknown
}

/**
 * Convert a stored ISO datetime into the "YYYY-MM-DDTHH:mm" format that
 * <input type="datetime-local"> expects, formatted in the customer's
 * wall-clock zone. CRITICAL: the form's save path interprets this
 * string as wall-clock in the customer's tz via wallClockInTzToUtcIso.
 * If we returned the viewer's-browser wall-clock here, opening + saving
 * an appointment without changing the time would silently shift it by
 * (viewerOffset - customerOffset) hours every time. This was the source
 * of the "edit + save = +3h drift on every EST→PDT edit" data corruption.
 */
function toLocalDateTimeInput(iso: string, timezone: string): string {
  const d = new Date(iso)
  if (isNaN(d.getTime())) return ''
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  })
  const parts = fmt.formatToParts(d)
  const pick = (t: string) => parts.find((p) => p.type === t)?.value ?? '00'
  return `${pick('year')}-${pick('month')}-${pick('day')}T${pick('hour')}:${pick('minute')}`
}

export default function EditAppointmentPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = use(params)

  const { data, isLoading, error } = useQuery<{ appointment: Appointment }>({
    queryKey: ['agent-appointment', id],
    queryFn: async () => {
      const res = await fetch(`/api/agent/appointments/${id}`)
      if (!res.ok) throw new Error('Not found')
      return res.json()
    },
  })

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 className="h-6 w-6 animate-spin text-blue-600" />
      </div>
    )
  }

  if (error || !data) {
    return (
      <div className="mx-auto max-w-2xl rounded-xl border border-red-200 bg-red-50 p-6 text-sm text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-200">
        Couldn&apos;t load this appointment. It may have been deleted, or belong to another agent.
      </div>
    )
  }

  const appt = data.appointment
  const customerTz = resolveCustomerTimezone({
    address: appt.address,
    clientState: appt.client?.state ?? null,
  })
  const initial: AppointmentFormValues = {
    apptDateTime: toLocalDateTimeInput(appt.apptDateTime, customerTz),
    clientId: appt.clientId || '',
    customerName: appt.customerName,
    customerPhone: appt.customerPhone,
    address: appt.address || '',
    email: appt.email || '',
    monthlyBill: appt.monthlyBill || '',
    utilityProvider: appt.utilityProvider || '',
    roofType: appt.roofType || '',
    roofAge: appt.roofAge || '',
    status: appt.status,
    estimatedDealValue: appt.estimatedDealValue || '',
    notes: appt.notes || '',
    callRecordingLink: appt.callRecordingLink || '',
    bookedByName: appt.bookedByName || '',
  }

  return (
    <AppointmentForm
      mode="edit"
      appointmentId={id}
      initial={initial}
      initialSolarSummary={appt.solarSummary}
    />
  )
}
