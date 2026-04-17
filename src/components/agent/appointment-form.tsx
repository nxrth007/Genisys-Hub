'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { ArrowLeft, Save, Trash2, AlertCircle, CheckCircle2 } from 'lucide-react'
import { cn } from '@/lib/utils'

export type AppointmentFormValues = {
  apptDateTime: string // ISO datetime-local format (YYYY-MM-DDTHH:mm)
  customerName: string
  customerPhone: string
  address: string
  email: string
  monthlyBill: string
  utilityProvider: string
  roofType: string
  roofAge: string
  status: string
  notes: string
  callRecordingLink: string
}

const EMPTY: AppointmentFormValues = {
  apptDateTime: '',
  customerName: '',
  customerPhone: '',
  address: '',
  email: '',
  monthlyBill: '',
  utilityProvider: '',
  roofType: '',
  roofAge: '',
  status: 'booked',
  notes: '',
  callRecordingLink: '',
}

const STATUS_OPTIONS: Array<{ value: string; label: string }> = [
  { value: 'booked', label: 'Booked' },
  { value: 'rescheduled', label: 'Rescheduled' },
  { value: 'showed', label: 'Showed' },
  { value: 'no_show', label: 'No-show' },
  { value: 'cancelled', label: 'Cancelled' },
]

const ROOF_OPTIONS = ['Asphalt Shingle', 'Tile', 'Metal', 'Flat', 'Wood Shake', 'Other']

/**
 * Used for both creation (mode='create') and editing (mode='edit').
 * Caller provides initial values (empty or the fetched appointment). On
 * successful submit the form routes back to /agent.
 */
export function AppointmentForm({
  mode,
  appointmentId,
  initial = EMPTY,
}: {
  mode: 'create' | 'edit'
  appointmentId?: string
  initial?: AppointmentFormValues
}) {
  const router = useRouter()
  const [values, setValues] = useState<AppointmentFormValues>(initial)
  const [submitting, setSubmitting] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  function set<K extends keyof AppointmentFormValues>(key: K, val: AppointmentFormValues[K]) {
    setValues((v) => ({ ...v, [key]: val }))
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    setSubmitting(true)

    const url =
      mode === 'create'
        ? '/api/agent/appointments'
        : `/api/agent/appointments/${appointmentId}`
    const method = mode === 'create' ? 'POST' : 'PATCH'

    const body = {
      apptDateTime: values.apptDateTime
        ? new Date(values.apptDateTime).toISOString()
        : null,
      customerName: values.customerName,
      customerPhone: values.customerPhone,
      address: values.address || null,
      email: values.email || null,
      monthlyBill: values.monthlyBill || null,
      utilityProvider: values.utilityProvider || null,
      roofType: values.roofType || null,
      roofAge: values.roofAge || null,
      status: values.status,
      notes: values.notes || null,
      callRecordingLink: values.callRecordingLink || null,
    }

    const res = await fetch(url, {
      method,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    const data = await res.json().catch(() => ({}))
    setSubmitting(false)

    if (!res.ok) {
      setError(data.error || 'Failed to save appointment.')
      return
    }

    router.push('/agent')
    router.refresh()
  }

  async function onDelete() {
    if (!appointmentId) return
    if (!confirm('Delete this appointment? This cannot be undone.')) return
    setDeleting(true)
    const res = await fetch(`/api/agent/appointments/${appointmentId}`, {
      method: 'DELETE',
    })
    setDeleting(false)
    if (!res.ok) {
      const data = await res.json().catch(() => ({}))
      setError(data.error || 'Failed to delete.')
      return
    }
    router.push('/agent')
    router.refresh()
  }

  return (
    <div className="mx-auto max-w-2xl space-y-5">
      <div className="flex items-center justify-between">
        <Link
          href="/agent"
          className="inline-flex items-center gap-1 text-sm text-zinc-500 hover:text-purple-600"
        >
          <ArrowLeft className="h-4 w-4" />
          Back
        </Link>
        <h1 className="text-xl font-bold">
          {mode === 'create' ? 'New appointment' : 'Edit appointment'}
        </h1>
      </div>

      <form
        onSubmit={submit}
        className="space-y-4 rounded-xl border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900"
      >
        <Field label="Appointment date & time" required>
          <input
            type="datetime-local"
            value={values.apptDateTime}
            onChange={(e) => set('apptDateTime', e.target.value)}
            required
            className={inputCls}
          />
        </Field>

        <div className="grid gap-4 md:grid-cols-2">
          <Field label="Customer's name" required>
            <input
              type="text"
              value={values.customerName}
              onChange={(e) => set('customerName', e.target.value)}
              required
              className={inputCls}
            />
          </Field>

          <Field label="Customer's phone number" required>
            <input
              type="tel"
              value={values.customerPhone}
              onChange={(e) => set('customerPhone', e.target.value)}
              required
              placeholder="+1 555 123 4567"
              className={inputCls}
            />
          </Field>
        </div>

        <Field label="Address">
          <input
            type="text"
            value={values.address}
            onChange={(e) => set('address', e.target.value)}
            placeholder="Street, City, State ZIP"
            className={inputCls}
          />
        </Field>

        <Field label="Email">
          <input
            type="email"
            value={values.email}
            onChange={(e) => set('email', e.target.value)}
            className={inputCls}
          />
        </Field>

        <div className="grid gap-4 md:grid-cols-2">
          <Field label="Monthly bill">
            <div className="relative">
              <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-zinc-400">
                $
              </span>
              <input
                type="text"
                value={values.monthlyBill}
                onChange={(e) => set('monthlyBill', e.target.value)}
                placeholder="150"
                className={cn(inputCls, 'pl-6')}
              />
            </div>
          </Field>

          <Field label="Utility provider">
            <input
              type="text"
              value={values.utilityProvider}
              onChange={(e) => set('utilityProvider', e.target.value)}
              placeholder="PG&E, Eversource, etc."
              className={inputCls}
            />
          </Field>
        </div>

        <div className="grid gap-4 md:grid-cols-2">
          <Field label="Roof type">
            <select
              value={values.roofType}
              onChange={(e) => set('roofType', e.target.value)}
              className={inputCls}
            >
              <option value="">—</option>
              {ROOF_OPTIONS.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </select>
          </Field>

          <Field label="Roof age">
            <input
              type="text"
              value={values.roofAge}
              onChange={(e) => set('roofAge', e.target.value)}
              placeholder="e.g. 5 years"
              className={inputCls}
            />
          </Field>
        </div>

        <Field label="Appointment status">
          <select
            value={values.status}
            onChange={(e) => set('status', e.target.value)}
            className={inputCls}
          >
            {STATUS_OPTIONS.map((s) => (
              <option key={s.value} value={s.value}>
                {s.label}
              </option>
            ))}
          </select>
        </Field>

        <Field label="Notes">
          <textarea
            value={values.notes}
            onChange={(e) => set('notes', e.target.value)}
            rows={4}
            placeholder="Anything the closer should know before the appointment…"
            className={cn(inputCls, 'font-normal leading-relaxed')}
          />
        </Field>

        <Field label="Call recording link">
          <input
            type="url"
            value={values.callRecordingLink}
            onChange={(e) => set('callRecordingLink', e.target.value)}
            placeholder="https://microtalk.dialler.net/RECORDINGS/..."
            className={cn(inputCls, 'font-mono text-xs')}
          />
        </Field>

        {error && (
          <div className="flex items-start gap-2 rounded-md border border-red-200 bg-red-50 p-3 text-xs text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-200">
            <AlertCircle className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" />
            {error}
          </div>
        )}

        <div className="flex items-center justify-between gap-3 border-t border-zinc-100 pt-4 dark:border-zinc-800">
          {mode === 'edit' ? (
            <button
              type="button"
              onClick={onDelete}
              disabled={deleting || submitting}
              className="inline-flex items-center gap-1.5 rounded-md border border-red-200 bg-white px-3 py-2 text-sm font-medium text-red-600 hover:bg-red-50 dark:border-red-900 dark:bg-red-950/20 dark:hover:bg-red-950/40"
            >
              <Trash2 className="h-3.5 w-3.5" />
              {deleting ? 'Deleting…' : 'Delete'}
            </button>
          ) : (
            <span />
          )}

          <div className="flex items-center gap-2">
            <Link
              href="/agent"
              className="rounded-md px-3 py-2 text-sm font-medium text-zinc-600 hover:bg-zinc-50 dark:text-zinc-300 dark:hover:bg-zinc-800"
            >
              Cancel
            </Link>
            <button
              type="submit"
              disabled={submitting || deleting}
              className="inline-flex items-center gap-1.5 rounded-md bg-purple-600 px-4 py-2 text-sm font-medium text-white hover:bg-purple-700 disabled:opacity-50"
            >
              {mode === 'create' ? <Save className="h-3.5 w-3.5" /> : <CheckCircle2 className="h-3.5 w-3.5" />}
              {submitting ? 'Saving…' : mode === 'create' ? 'Save appointment' : 'Save changes'}
            </button>
          </div>
        </div>
      </form>
    </div>
  )
}

const inputCls =
  'w-full rounded-md border border-zinc-200 bg-white px-3 py-2 text-sm focus:border-purple-500 focus:outline-none dark:border-zinc-800 dark:bg-zinc-950'

function Field({
  label,
  required,
  children,
}: {
  label: string
  required?: boolean
  children: React.ReactNode
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium text-zinc-600 dark:text-zinc-400">
        {label}
        {required && <span className="ml-0.5 text-red-500">*</span>}
      </span>
      {children}
    </label>
  )
}
