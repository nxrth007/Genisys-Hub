'use client'

import { useEffect, useRef, useState } from 'react'
import { MapPin, Loader2 } from 'lucide-react'

/**
 * Single-line address field with OpenStreetMap (Nominatim) autocomplete.
 *
 * Was previously a four-input grid (street + city + state + zip). Mary
 * could type the city into the street field, the autocomplete would
 * then ALSO populate the city field, and the joined output was
 * "...Cerritos, Cerritos, CA 90703" — duplicate city. Single field
 * with one source of truth (the picked suggestion's display string)
 * makes that class of bug impossible.
 *
 * The parent form keeps its same `value: string` / `onChange(combined)`
 * contract — DB column is unchanged, sheet column is unchanged, the
 * timezone resolver still parses the state code out of the address
 * string. Drop-in replacement.
 *
 * Manual typing is still allowed for addresses Nominatim doesn't
 * have — the dropdown just guides; it doesn't gate.
 */

type Props = {
  value: string
  onChange: (combined: string) => void
  disabled?: boolean
  /** Optional id used by the surrounding form's <label> association. */
  id?: string
  /** When true, the input gets HTML5 required + a red asterisk. */
  requireStreet?: boolean
}

export function AddressFields({
  value,
  onChange,
  disabled,
  id,
  requireStreet,
}: Props) {
  const [draft, setDraft] = useState(value)
  const [suggestions, setSuggestions] = useState<NominatimResult[]>([])
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [activeIndex, setActiveIndex] = useState(-1)
  const wrapRef = useRef<HTMLDivElement | null>(null)
  const inputRef = useRef<HTMLInputElement | null>(null)

  // Re-sync from parent on edit-mode prefill or external clear.
  // We track the last value we emitted so a controlled re-render
  // with the same value we just sent up doesn't reset the cursor.
  const lastEmittedRef = useRef<string>(value)
  useEffect(() => {
    if (value !== lastEmittedRef.current) {
      setDraft(value)
      lastEmittedRef.current = value
    }
  }, [value])

  function commit(next: string) {
    setDraft(next)
    lastEmittedRef.current = next
    onChange(next)
  }

  // Debounced Nominatim query. Aborts in-flight + cancels timer on
  // every keystroke so the dropdown only ever shows results for the
  // CURRENT input — keeps us under Nominatim's 1 req/sec ceiling and
  // avoids out-of-order results stomping the list.
  useEffect(() => {
    const q = draft.trim()
    if (q.length < 4) {
      setSuggestions([])
      return
    }
    const controller = new AbortController()
    const timer = setTimeout(async () => {
      try {
        setLoading(true)
        const url = new URL('https://nominatim.openstreetmap.org/search')
        url.searchParams.set('q', q)
        url.searchParams.set('format', 'json')
        url.searchParams.set('addressdetails', '1')
        url.searchParams.set('countrycodes', 'us')
        url.searchParams.set('limit', '6')
        const res = await fetch(url.toString(), {
          signal: controller.signal,
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
  }, [draft])

  // Click-outside closes the dropdown.
  useEffect(() => {
    if (!open) return
    function onClick(e: MouseEvent) {
      if (!wrapRef.current) return
      if (!wrapRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onClick)
    return () => document.removeEventListener('mousedown', onClick)
  }, [open])

  // Reset hover-highlight when the suggestion list changes so the
  // arrow-key navigation always starts from a known position.
  useEffect(() => {
    setActiveIndex(-1)
  }, [suggestions])

  function applySuggestion(s: NominatimResult) {
    // Build a clean, canonical address from Nominatim's structured
    // parts rather than using `display_name` directly. display_name
    // includes county / country tail ("Los Angeles County, California,
    // 90703, United States") which is noisy and breaks our state-code
    // regex if the country phrase happens to contain a state-name
    // substring.
    const a = s.address || {}
    const street = [a.house_number, a.road].filter(Boolean).join(' ').trim()
    const city =
      a.city || a.town || a.village || a.hamlet || a.suburb || a.county || ''
    const stateCode = STATE_NAME_TO_CODE[(a.state || '').toLowerCase()] || ''
    const zip = a.postcode || ''
    const formatted = formatAddressLine({ street, city, stateCode, zip })
    commit(formatted)
    setOpen(false)
    inputRef.current?.focus()
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (!open || suggestions.length === 0) return
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActiveIndex((i) => (i + 1) % suggestions.length)
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActiveIndex((i) =>
        i <= 0 ? suggestions.length - 1 : i - 1,
      )
    } else if (e.key === 'Enter' && activeIndex >= 0) {
      e.preventDefault()
      applySuggestion(suggestions[activeIndex])
    } else if (e.key === 'Escape') {
      setOpen(false)
    }
  }

  return (
    <div ref={wrapRef} className="relative">
      {/* No internal label — the parent form's <Field label="Address">
          wrapper already renders one. The loading spinner sits in
          the input's right padding instead. */}
      {loading && (
        <div className="pointer-events-none absolute right-3 top-2.5 z-10">
          <Loader2 className="h-3 w-3 animate-spin text-zinc-400" />
        </div>
      )}
      <input
        ref={inputRef}
        id={id}
        type="text"
        value={draft}
        onChange={(e) => {
          commit(e.target.value)
          setOpen(true)
        }}
        onFocus={() => suggestions.length > 0 && setOpen(true)}
        onKeyDown={onKeyDown}
        disabled={disabled}
        required={requireStreet}
        placeholder="Start typing — e.g. 123 Main St Cerritos CA"
        autoComplete="off"
        className={inputCls}
      />
      <p className="mt-1 text-[10px] text-zinc-500 dark:text-zinc-500">
        Type the address; pick a suggestion to auto-fill the
        canonical form. State + ZIP are inferred from the address —
        no separate fields to keep in sync.
      </p>

      {open && suggestions.length > 0 && (
        <div className="absolute left-0 right-0 z-20 mt-1 max-h-72 overflow-auto rounded-md border border-zinc-200 bg-white shadow-lg dark:border-zinc-700 dark:bg-zinc-900">
          {suggestions.map((s, i) => (
            <button
              key={s.place_id}
              type="button"
              onClick={() => applySuggestion(s)}
              onMouseEnter={() => setActiveIndex(i)}
              className={`flex w-full items-start gap-2 border-b border-zinc-100 px-3 py-2 text-left text-xs last:border-b-0 dark:border-zinc-800 ${
                i === activeIndex
                  ? 'bg-blue-50 dark:bg-blue-950'
                  : 'hover:bg-zinc-50 dark:hover:bg-zinc-800'
              }`}
            >
              <MapPin className="mt-0.5 h-3 w-3 flex-shrink-0 text-zinc-400" />
              <span className="leading-tight">{s.display_name}</span>
            </button>
          ))}
          <p className="border-t border-zinc-100 px-3 py-1.5 text-[10px] text-zinc-400 dark:border-zinc-800">
            Suggestions via OpenStreetMap · ↑↓ to navigate · Enter to pick
          </p>
        </div>
      )}
    </div>
  )
}

// ----------------------------------------------------------------------------

const inputCls =
  'w-full rounded-md border border-zinc-200 bg-white px-3 py-2 text-sm focus:border-blue-500 focus:outline-none disabled:opacity-50 dark:border-zinc-800 dark:bg-zinc-950'

// State-name → 2-letter code lookup. Local (instead of importing from
// lib/address) so this component is self-contained — the rest of
// lib/address is the four-field parser/formatter that no longer has
// any callers.
const STATE_NAME_TO_CODE: Record<string, string> = {
  alabama: 'AL', alaska: 'AK', arizona: 'AZ', arkansas: 'AR',
  california: 'CA', colorado: 'CO', connecticut: 'CT', delaware: 'DE',
  'district of columbia': 'DC', florida: 'FL', georgia: 'GA', hawaii: 'HI',
  idaho: 'ID', illinois: 'IL', indiana: 'IN', iowa: 'IA', kansas: 'KS',
  kentucky: 'KY', louisiana: 'LA', maine: 'ME', maryland: 'MD',
  massachusetts: 'MA', michigan: 'MI', minnesota: 'MN', mississippi: 'MS',
  missouri: 'MO', montana: 'MT', nebraska: 'NE', nevada: 'NV',
  'new hampshire': 'NH', 'new jersey': 'NJ', 'new mexico': 'NM',
  'new york': 'NY', 'north carolina': 'NC', 'north dakota': 'ND',
  ohio: 'OH', oklahoma: 'OK', oregon: 'OR', pennsylvania: 'PA',
  'rhode island': 'RI', 'south carolina': 'SC', 'south dakota': 'SD',
  tennessee: 'TN', texas: 'TX', utah: 'UT', vermont: 'VT',
  virginia: 'VA', washington: 'WA', 'west virginia': 'WV',
  wisconsin: 'WI', wyoming: 'WY',
}

function formatAddressLine(parts: {
  street: string
  city: string
  stateCode: string
  zip: string
}): string {
  // "Street, City, ST 12345" — same shape stateCodeFromAddress and
  // the master tracker / Slack message formatters expect.
  const streetCity = [parts.street, parts.city].filter(Boolean).join(', ')
  const stateZip = [parts.stateCode, parts.zip].filter(Boolean).join(' ')
  return [streetCity, stateZip].filter(Boolean).join(', ')
}

// ---- Nominatim response shape we care about --------------------------------

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
