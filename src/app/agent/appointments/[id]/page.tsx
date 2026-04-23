'use client'

import { use } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Loader2 } from 'lucide-react'
import {
  AppointmentForm,
  type AppointmentFormValues,
} from '@/components/agent/appointment-form'

type Appointment = {
  id: string
  apptDateTime: string
  clientId: string | null
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
}

/**
 * Convert a stored ISO datetime into the "YYYY-MM-DDTHH:mm" format that
 * <input type="datetime-local"> expects. Works in the browser's local time
 * zone so the displayed time matches what the agent originally entered.
 */
function toLocalDateTimeInput(iso: string): string {
  const d = new Date(iso)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
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
  const initial: AppointmentFormValues = {
    apptDateTime: toLocalDateTimeInput(appt.apptDateTime),
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
  }

  return <AppointmentForm mode="edit" appointmentId={id} initial={initial} />
}
