'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { MapPin, Loader2 } from 'lucide-react'
import {
  AddressParts,
  PRIMARY_STATES,
  STATE_NAME_TO_CODE,
  formatAddress,
  parseAddress,
} from '@/lib/address'

/**
 * Four-field address editor with Nominatim (OpenStreetMap)
 * autocomplete. Translates between its own internal `AddressParts`
 * state and the parent's single-line string via `value` / `onChange`,
 * so the booking form's state shape and the DB column stay flat.
 *
 * Autocomplete is best-effort — Nominatim is a free public service
 * with a 1 req/sec rate limit; we debounce typing to 300ms. The
 * agent can always type all four fields by hand instead of picking a
 * suggestion (and the dropdown supports an "Other" option for states
 * outside Genisys's three operating states).
 */

type Props = {
  value: string
  onChange: (combined: string) => void
  disabled?: boolean
  /** Optional id used by the surrounding form's <label> association. */
  id?: string
}

const STATE_OTHER = '__OTHER__'

export function AddressFields({ value, onChange, disabled, id }: Props) {
  const [parts, setParts] = useState<AddressParts>(() => parseAddress(value))

  // Track the last string we emitted upward so we can distinguish
  // "value changed because we just edited it" (do nothing) from "value
  // changed externally — re-parse" (e.g. edit-mode prefill arrived).
  const lastEmittedRef = useRef<string>(formatAddress(parts))

  useEffect(() => {
    if (value !== lastEmittedRef.current) {
      const next = parseAddress(value)
      setParts(next)
      lastEmittedRef.current = formatAddress(next)
    }
  }, [value])

  function commit(next: AddressParts) {
    setParts(next)
    const formatted = formatAddress(next)
    lastEmittedRef.current = formatted
    onChange(formatted)
  }

  // ---- Nominatim autocomplete -----------------------------------------
  const [suggestions, setSuggestions] = useState<NominatimResult[]>([])
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  // Used to dismiss the dropdown when the user clicks outside it.
  const wrapRef = useRef<HTMLDivElement | null>(null)

  // Debounce + abort: every keystroke schedules a query for 300ms in
  // the future, cancelling the previous timer + any in-flight request.
  // Keeps us under Nominatim's 1 req/sec ceiling and avoids out-of-
  // order results stomping the suggestion list.
  useEffect(() => {
    const street = parts.street.trim()
    if (!street || street.length < 4) {
      setSuggestions([])
      return
    }
    const controller = new AbortController()
    const timer = setTimeout(async () => {
      try {
        setLoading(true)
        const url = new URL('https://nominatim.openstreetmap.org/search')
        // Build the query out of whatever the agent has typed so far —
        // street + city + state. More signal → better suggestions.
        const q = [street, parts.city, parts.state].filter(Boolean).join(', ')
        url.searchParams.set('q', q)
        url.searchParams.set('format', 'json')
        url.searchParams.set('addressdetails', '1')
        url.searchParams.set('countrycodes', 'us')
        url.searchParams.set('limit', '6')
        const res = await fetch(url.toString(), {
          signal: controller.signal,
          // Nominatim's policy asks for an identifying header — browsers
          // already send a User-Agent, which they accept for low-volume use.
          headers: { Accept: 'application/json' },
        })
        if (!res.ok) {
          setSuggestions([])
          return
        }
        const data = (await res.json()) as NominatimResult[]
        setSuggestions(data || [])
      } catch (err) {
        if ((err as Error).name === 'AbortError') return
        setSuggestions([])
      } finally {
        setLoading(false)
      }
    }, 300)

    return () => {
      clearTimeout(timer)
      controller.abort()
    }
    // We intentionally only key off the street input — re-querying on
    // every city/state/zip keystroke would burn the rate limit and the
    // agent has already picked a suggestion by that point.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [parts.street])

  // Click-outside closes the suggestions dropdown.
  useEffect(() => {
    if (!open) return
    function onClick(e: MouseEvent) {
      if (!wrapRef.current) return
      if (!wrapRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onClick)
    return () => document.removeEventListener('mousedown', onClick)
  }, [open])

  function applySuggestion(s: NominatimResult) {
    const a = s.address || {}
    const street = [a.house_number, a.road].filter(Boolean).join(' ').trim()
    // Nominatim hands cities back under one of several keys depending
    // on the locality type — try them in order of specificity.
    const city =
      a.city || a.town || a.village || a.hamlet || a.suburb || a.county || ''
    const stateName = (a.state || '').toLowerCase()
    const stateCode = STATE_NAME_TO_CODE[stateName] || ''
    const zip = a.postcode || ''
    commit({ street, city, state: stateCode, zip })
    setOpen(false)
  }

  // Whether the currently-selected state is one of the dropdown's
  // primary options (AZ/CA/UT) — if not, we render an "Other" mode
  // with a free-text 2-letter input.
  const stateIsPrimary = useMemo(
    () => PRIMARY_STATES.includes(parts.state as (typeof PRIMARY_STATES)[number]),
    [parts.state]
  )
  // Track whether the agent has explicitly switched to Other mode so
  // typing "AZ" in the custom field doesn't snap the dropdown back.
  const [stateOther, setStateOther] = useState<boolean>(
    () => !!parts.state && !PRIMARY_STATES.includes(parts.state as PrimaryStateUnion)
  )
  useEffect(() => {
    // Sync to external value changes (edit-mode prefill).
    setStateOther(!!parts.state && !stateIsPrimary)
  }, [parts.state, stateIsPrimary])

  return (
    <div className="space-y-2">
      {/* ---- Street with autocomplete ---- */}
      <div ref={wrapRef} className="relative">
        <label className="mb-1 flex items-center justify-between">
          <span className="block text-xs font-medium text-zinc-600 dark:text-zinc-400">
            Street address
          </span>
          {loading && (
            <Loader2 className="h-3 w-3 animate-spin text-zinc-400" />
          )}
        </label>
        <input
          id={id}
          type="text"
          value={parts.street}
          onChange={(e) => {
            commit({ ...parts, street: e.target.value })
            setOpen(true)
          }}
          onFocus={() => suggestions.length > 0 && setOpen(true)}
          disabled={disabled}
          placeholder="123 Main St"
          autoComplete="off"
          className={inputCls}
        />
        {open && suggestions.length > 0 && (
          <div className="absolute left-0 right-0 z-20 mt-1 max-h-64 overflow-auto rounded-md border border-zinc-200 bg-white shadow-lg dark:border-zinc-700 dark:bg-zinc-900">
            {suggestions.map((s) => (
              <button
                key={s.place_id}
                type="button"
                onClick={() => applySuggestion(s)}
                className="flex w-full items-start gap-2 border-b border-zinc-100 px-3 py-2 text-left text-xs hover:bg-blue-50 last:border-b-0 dark:border-zinc-800 dark:hover:bg-blue-950"
              >
                <MapPin className="mt-0.5 h-3 w-3 flex-shrink-0 text-zinc-400" />
                <span className="leading-tight">{s.display_name}</span>
              </button>
            ))}
            <p className="border-t border-zinc-100 px-3 py-1.5 text-[10px] text-zinc-400 dark:border-zinc-800">
              Suggestions via OpenStreetMap
            </p>
          </div>
        )}
      </div>

      {/* ---- City / State / ZIP grid ---- */}
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,1fr)]">
        <FieldSlot label="City">
          <input
            type="text"
            value={parts.city}
            onChange={(e) => commit({ ...parts, city: e.target.value })}
            disabled={disabled}
            placeholder="Phoenix"
            autoComplete="off"
            className={inputCls}
          />
        </FieldSlot>

        <FieldSlot label="State">
          {!stateOther ? (
            <select
              value={parts.state}
              onChange={(e) => {
                if (e.target.value === STATE_OTHER) {
                  setStateOther(true)
                  commit({ ...parts, state: '' })
                } else {
                  commit({ ...parts, state: e.target.value })
                }
              }}
              disabled={disabled}
              className={inputCls}
            >
              <option value="">—</option>
              {PRIMARY_STATES.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
              <option value={STATE_OTHER}>Other…</option>
            </select>
          ) : (
            <div className="flex items-center gap-1.5">
              <input
                type="text"
                value={parts.state}
                onChange={(e) =>
                  commit({
                    ...parts,
                    state: e.target.value.toUpperCase().slice(0, 2),
                  })
                }
                disabled={disabled}
                placeholder="ST"
                maxLength={2}
                className={`${inputCls} uppercase`}
              />
              <button
                type="button"
                onClick={() => {
                  setStateOther(false)
                  commit({ ...parts, state: '' })
                }}
                className="text-[10px] text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300"
                title="Back to AZ / CA / UT picker"
              >
                ←
              </button>
            </div>
          )}
        </FieldSlot>

        <FieldSlot label="ZIP">
          <input
            type="text"
            value={parts.zip}
            onChange={(e) => commit({ ...parts, zip: e.target.value })}
            disabled={disabled}
            placeholder="85001"
            inputMode="numeric"
            autoComplete="postal-code"
            className={inputCls}
          />
        </FieldSlot>
      </div>
    </div>
  )
}

// ----------------------------------------------------------------------------

const inputCls =
  'w-full rounded-md border border-zinc-200 bg-white px-3 py-2 text-sm focus:border-blue-500 focus:outline-none disabled:opacity-50 dark:border-zinc-800 dark:bg-zinc-950'

function FieldSlot({
  label,
  children,
}: {
  label: string
  children: React.ReactNode
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-[10px] font-semibold uppercase tracking-wide text-zinc-500">
        {label}
      </span>
      {children}
    </label>
  )
}

// ---- Nominatim response shape we care about --------------------------------

type PrimaryStateUnion = (typeof PRIMARY_STATES)[number]

type NominatimResult = {
  place_id: number
  display_name: string
  address?: {
    house_number?: string
    road?: string
    city?: string
    town?: string
    village?: string
    hamlet?: string
    suburb?: string
    county?: string
    state?: string
    postcode?: string
  }
}
