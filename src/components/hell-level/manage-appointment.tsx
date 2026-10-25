'use client'

import { useState } from 'react'
import { inkOn, shade } from '@/lib/hl/color'
import type { ManagedAppointment } from '@/lib/hl/booking'
import { Booked, SlotPicker, visitorZone } from './booking-widget'

const longDate = (iso: string, tz: string) => new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }).format(new Date(iso))
const timeOf = (iso: string, tz: string) => new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit', timeZoneName: 'short' }).format(new Date(iso))

/** The brand button, as on the booking page. */
const brandButton = (color: string): React.CSSProperties => ({
  background: `linear-gradient(135deg, ${shade(color, 0.1)}, ${color} 60%, ${shade(color, -0.06)})`,
  color: inkOn(color),
  boxShadow: `0 8px 18px -8px ${color}, inset 0 1px 0 rgba(255,255,255,.22)`,
})
const outline = 'flex h-12 items-center justify-center rounded-xl border border-[#E4E7EC] bg-white px-5 text-[15px] font-semibold text-[#344054] transition hover:bg-[#F9FAFB]'

/** The reschedule / cancel link a booking texts out, inside BookingFrame. */
export function ManageAppointment({ token, a, startCancelling }: { token: string; a: ManagedAppointment; startCancelling: boolean }) {
  const [tz, setTz] = useState(() => (typeof window === 'undefined' ? (a.bookerTimezone ?? a.timezone) : (a.bookerTimezone ?? visitorZone(a.timezone))))
  const [mode, setMode] = useState<'view' | 'reschedule' | 'cancel'>(startCancelling && a.canCancel ? 'cancel' : 'view')
  const [picked, setPicked] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<{ kind: 'moved'; start: string; end: string } | { kind: 'cancelled' } | null>(null)
  const color = a.calendar?.color ?? '#155EEF'

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

  if (result?.kind === 'moved' && a.calendar) return <Booked calendar={a.calendar} start={result.start} end={result.end} tz={tz} manageUrl={null} headline="Rescheduled" message="Your new time is booked. We’ll text you a reminder." />
  if (result?.kind === 'cancelled' || a.status === 'cancelled') {
    return (
      <div className="hl-in mx-auto flex max-w-md flex-col items-center gap-3 py-6 text-center">
        <span className="grid h-14 w-14 place-items-center rounded-full bg-[#F2F4F7] text-[#475467]">
          <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M18 6 6 18M6 6l12 12" />
          </svg>
        </span>
        <p className="text-[22px] font-semibold tracking-[-0.015em] text-[#101828]">Cancelled</p>
        <p className="text-[14.5px] text-[#475467]">
          Your {a.calendarName} on {longDate(a.start, tz)} is cancelled.
        </p>
        {a.calendarId && a.calendar && (
          <a href={`/hl/b/${a.calendarId}`} className="mt-2 flex h-11 items-center justify-center rounded-xl px-5 text-[14.5px] font-semibold transition hover:brightness-[1.06]" style={brandButton(color)}>
            Book another time
          </a>
        )}
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-5">
      <div className="flex items-center gap-4 rounded-2xl bg-[color-mix(in_srgb,var(--hl-c)_7%,white)] px-5 py-4">
        <span className="grid h-12 w-12 shrink-0 place-items-center rounded-xl" style={brandButton(color)}>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <rect x="3" y="4" width="18" height="17" rx="3" />
            <path d="M16 2v4M8 2v4M3 10h18" />
          </svg>
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-[12px] font-semibold uppercase tracking-[0.08em] text-[#98A2B3]">{a.calendarName}</p>
          <p className="mt-0.5 text-[16px] font-semibold text-[#101828]">{longDate(a.start, tz)}</p>
          <p className="text-[14.5px] text-[#344054]">{timeOf(a.start, tz)}</p>
          {(a.location || a.with) && <p className="mt-1 text-[13px] text-[#667085]">{[a.location, a.with && `With ${a.with}`].filter(Boolean).join(' · ')}</p>}
        </div>
      </div>

      {mode === 'view' && (
        <div className="grid gap-2 sm:grid-cols-2">
          {a.canReschedule && (
            <button type="button" onClick={() => setMode('reschedule')} className="flex h-12 items-center justify-center rounded-xl px-5 text-[15px] font-semibold transition hover:brightness-[1.06]" style={brandButton(color)}>
              Reschedule
            </button>
          )}
          {a.canCancel && (
            <button type="button" onClick={() => setMode('cancel')} className={outline}>
              Cancel appointment
            </button>
          )}
          {!a.canReschedule && !a.canCancel && <p className="text-[13.5px] text-[#667085] sm:col-span-2">This appointment can’t be changed online. Please call {a.business}.</p>}
        </div>
      )}

      {mode === 'reschedule' && a.calendar && (
        <div className="hl-in flex flex-col gap-6">
          <p className="text-[15px] font-semibold text-[#101828]">Pick a new time</p>
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
            <button type="button" onClick={() => setMode('view')} className={outline}>
              Back
            </button>
            <button
              type="button"
              disabled={!picked || busy}
              onClick={() => send({ action: 'reschedule', start: picked })}
              className={`flex h-12 flex-1 items-center justify-center rounded-xl px-5 text-[15px] font-semibold transition disabled:cursor-not-allowed ${picked ? 'hover:brightness-[1.06]' : 'bg-[#F2F4F7] text-[#98A2B3]'}`}
              style={picked ? brandButton(color) : undefined}
            >
              {busy ? 'Moving…' : picked ? `Move to ${new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(picked))}` : 'Pick a new time'}
            </button>
          </div>
        </div>
      )}

      {mode === 'cancel' && (
        <div className="hl-in flex flex-col gap-3 rounded-2xl border border-[#FECDCA] bg-[#FFFBFA] p-5">
          <p className="text-[15.5px] font-semibold text-[#101828]">Cancel this appointment?</p>
          <p className="-mt-1.5 text-[13.5px] text-[#667085]">You can always book a new time after.</p>
          <div className="grid gap-2 sm:grid-cols-2">
            <button type="button" onClick={() => setMode('view')} className={outline}>
              Keep it
            </button>
            <button type="button" disabled={busy} onClick={() => send({ action: 'cancel' })} className="flex h-12 items-center justify-center rounded-xl bg-[#D92D20] px-5 text-[15px] font-semibold text-white transition hover:brightness-110 disabled:opacity-60">
              {busy ? 'Cancelling…' : 'Yes, cancel it'}
            </button>
          </div>
        </div>
      )}
      {error && <p className="rounded-xl bg-[#FEF3F2] px-3.5 py-2.5 text-[13px] text-[#B42318]">{error}</p>}
    </div>
  )
}
