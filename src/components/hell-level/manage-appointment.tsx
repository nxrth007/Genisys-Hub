'use client'

import { useState } from 'react'
import type { ManagedAppointment } from '@/lib/hl/booking'
import { Booked, SlotPicker, visitorZone } from './booking-widget'

const longDate = (iso: string, tz: string) => new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }).format(new Date(iso))
const timeOf = (iso: string, tz: string) => new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit', timeZoneName: 'short' }).format(new Date(iso))

/** The reschedule / cancel link a booking texts out. */
export function ManageAppointment({ token, a, startCancelling }: { token: string; a: ManagedAppointment; startCancelling: boolean }) {
  const [tz, setTz] = useState(() => (typeof window === 'undefined' ? (a.bookerTimezone ?? a.timezone) : (a.bookerTimezone ?? visitorZone(a.timezone))))
  const [mode, setMode] = useState<'view' | 'reschedule' | 'cancel'>(startCancelling && a.canCancel ? 'cancel' : 'view')
  const [picked, setPicked] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<{ kind: 'moved'; start: string; end: string } | { kind: 'cancelled' } | null>(null)

  async function send(body: Record<string, unknown>) {
    setBusy(true)
    setError(null)
    try {
      const res = await fetch(`/api/hl/public/appointments/${token}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
      const data = (await res.json().catch(() => ({}))) as { error?: string; start?: string; end?: string }
      if (!res.ok) {
        setError(data.error || 'Something went wrong. Please call us.')
        return
      }
      setResult(body.action === 'cancel' ? { kind: 'cancelled' } : { kind: 'moved', start: data.start!, end: data.end! })
    } catch {
      setError('Couldn’t reach us. Check your connection and try again.')
    } finally {
      setBusy(false)
    }
  }

  if (result?.kind === 'moved' && a.calendar) return <Booked calendar={a.calendar} start={result.start} end={result.end} tz={tz} manageUrl={null} headline="Rescheduled" />
  if (result?.kind === 'cancelled' || a.status === 'cancelled') {
    return (
      <div className="flex flex-col items-center gap-2 py-10 text-center">
        <p className="text-[20px] font-semibold text-[#101828]">Cancelled</p>
        <p className="text-[14px] text-[#475467]">Your {a.calendarName} on {longDate(a.start, tz)} is cancelled.</p>
        {a.calendarId && a.calendar && (
          <a href={`/hl/b/${a.calendarId}`} className="mt-2 text-[14px] font-medium text-[var(--hl-c)] underline">
            Book another time
          </a>
        )}
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-5">
      <div className="rounded-xl border border-[#EAECF0] p-4">
        <p className="text-[13px] font-medium text-[#667085]">{a.business}</p>
        <p className="text-[18px] font-semibold text-[#101828]">{a.calendarName}</p>
        <p className="mt-1 text-[15px] text-[#344054]">
          {longDate(a.start, tz)}, {timeOf(a.start, tz)}
        </p>
        {a.location && <p className="mt-1 text-[13px] text-[#667085]">{a.location}</p>}
        {a.with && <p className="text-[13px] text-[#667085]">With {a.with}</p>}
      </div>

      {mode === 'view' && (
        <div className="flex flex-wrap gap-2">
          {a.canReschedule && (
            <button type="button" onClick={() => setMode('reschedule')} className="flex-1 rounded-lg bg-[var(--hl-c)] px-4 py-3 text-[15px] font-semibold text-white hover:brightness-110">
              Reschedule
            </button>
          )}
          {a.canCancel && (
            <button type="button" onClick={() => setMode('cancel')} className="flex-1 rounded-lg border border-[#D0D5DD] px-4 py-3 text-[15px] font-semibold text-[#344054] hover:bg-[#F9FAFB]">
              Cancel
            </button>
          )}
          {!a.canReschedule && !a.canCancel && <p className="text-[13px] text-[#667085]">This appointment can’t be changed online. Please call {a.business}.</p>}
        </div>
      )}

      {mode === 'reschedule' && a.calendar && (
        <>
          <SlotPicker
            calendar={a.calendar}
            tz={tz}
            onTz={setTz}
            picked={picked}
            onPick={setPicked}
            duration={(() => {
              // The same length as now, when the calendar offers a choice.
              const m = Math.round((new Date(a.end).getTime() - new Date(a.start).getTime()) / 60_000)
              return a.calendar.durations?.length > 1 && a.calendar.durations.includes(m) ? m : undefined
            })()}
          />
          <div className="flex gap-2">
            <button type="button" onClick={() => setMode('view')} className="rounded-lg border border-[#D0D5DD] px-4 py-3 text-[15px] font-semibold text-[#344054]">
              Back
            </button>
            <button
              type="button"
              disabled={!picked || busy}
              onClick={() => send({ action: 'reschedule', start: picked })}
              className="flex-1 rounded-lg bg-[var(--hl-c)] px-4 py-3 text-[15px] font-semibold text-white hover:brightness-110 disabled:opacity-40"
            >
              {busy ? 'Moving…' : picked ? `Move to ${new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(picked))}` : 'Pick a new time'}
            </button>
          </div>
        </>
      )}

      {mode === 'cancel' && (
        <div className="flex flex-col gap-3 rounded-xl border border-[#FECDCA] bg-[#FFFBFA] p-4">
          <p className="text-[15px] font-semibold text-[#101828]">Cancel this appointment?</p>
          <div className="flex gap-2">
            <button type="button" onClick={() => setMode('view')} className="flex-1 rounded-lg border border-[#D0D5DD] bg-white px-4 py-2.5 text-[14px] font-semibold text-[#344054]">
              Keep it
            </button>
            <button type="button" disabled={busy} onClick={() => send({ action: 'cancel' })} className="flex-1 rounded-lg bg-[#D92D20] px-4 py-2.5 text-[14px] font-semibold text-white hover:brightness-110 disabled:opacity-60">
              {busy ? 'Cancelling…' : 'Yes, cancel'}
            </button>
          </div>
        </div>
      )}
      {error && <p className="rounded-lg bg-[#FEF3F2] px-3 py-2 text-[13px] text-[#B42318]">{error}</p>}
    </div>
  )
}
