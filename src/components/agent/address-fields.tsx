'use client'

import { useEffect, useRef, useState } from 'react'
import { MapPin, Loader2 } from 'lucide-react'

/**
 * Single-line address field with Google Places autocomplete (primary)
 * and OpenStreetMap Nominatim fallback (when the vault doesn't yet
 * have a Google Maps Key configured).
 *
 * Why two backends: Places gives faster + more accurate suggestions
 * but needs a billable API key. Until that's wired up, falling back
 * to Nominatim keeps the form usable. The first failed Places call
 * (503) flips the component to Nominatim mode for the rest of the
 * session — no per-keystroke probing.
 *
 * Same single-field UX as before — Mary types, picks a suggestion,
 * input fills with the canonical address. The parent form's
 * <Field label="Address"> wraps this, and downstream code
 * (timezone resolver, master tracker, Slack body) parses the state
 * out of the address string the same way it always did.
 *
 * Manual typing is still allowed for cases neither backend has —
 * the dropdown guides, doesn't gate.
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

type Suggestion = {
  /** Stable key — placeId for Google, place_id (number) for Nominatim. */
  key: string
  /** Display string for the dropdown row. */
  label: string
  /** What gets dropped into the input on selection (after any
   *  upgrade — Places suggestions get upgraded to formattedAddress
   *  via a Place Details call before commit). */
  pickedValue: string
  source: 'google' | 'nominatim'
  /** Set on Google suggestions so we can fetch full details on pick. */
  placeId?: string
}

export function AddressFields({
  value,
  onChange,
  disabled,
  id,
  requireStreet,
}: Props) {
  const [draft, setDraft] = useState(value)
  const [suggestions, setSuggestions] = useState<Suggestion[]>([])
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [activeIndex, setActiveIndex] = useState(-1)
  // Once Google returns 503 (vault key missing) we stop probing it
  // and use Nominatim for the rest of the session. Resets on full
  // page reload — handy after admin adds the key without forcing a
  // new browser tab.
  const [usingNominatim, setUsingNominatim] = useState(false)
  const wrapRef = useRef<HTMLDivElement | null>(null)
  const inputRef = useRef<HTMLInputElement | null>(null)

  // Re-sync from parent on edit-mode prefill or external clear.
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

  // Debounced suggestion fetch. 200ms (vs the old 300 for Nominatim)
  // since Google handles request rate without complaint and lower
  // latency makes the field feel snappier. Aborts in-flight on every
  // keystroke so the dropdown only ever shows results for the
  // current input.
  useEffect(() => {
    const q = draft.trim()
    if (q.length < 3) {
      setSuggestions([])
      return
    }
    const controller = new AbortController()
    const timer = setTimeout(async () => {
      try {
        setLoading(true)
        if (!usingNominatim) {
          const res = await fetch(
            `/api/agent/maps/places/autocomplete?q=${encodeURIComponent(q)}`,
            { signal: controller.signal },
          )
          if (res.status === 503) {
            // Vault key missing — flip to Nominatim for this session
            // and immediately re-run the query so the user doesn't
            // have to wait for the next keystroke.
            setUsingNominatim(true)
            await fetchNominatim(q, controller.signal)
            return
          }
          if (!res.ok) {
            // Transient Google error — swallow + show no suggestions
            // rather than fall back, so that one bad keystroke doesn't
            // permanently kick us off Google for the session.
            setSuggestions([])
            return
          }
          const data = (await res.json()) as {
            predictions: Array<{ description: string; placeId: string }>
          }
          setSuggestions(
            data.predictions.map((p) => ({
              key: p.placeId,
              label: p.description,
              pickedValue: stripCountryTail(p.description),
              source: 'google',
              placeId: p.placeId,
            })),
          )
        } else {
          await fetchNominatim(q, controller.signal)
        }
      } catch (err) {
        if ((err as Error).name === 'AbortError') return
        setSuggestions([])
      } finally {
        setLoading(false)
      }
    }, 200)

    return () => {
      clearTimeout(timer)
      controller.abort()
    }
  }, [draft, usingNominatim])

  async function fetchNominatim(q: string, signal: AbortSignal) {
    const url = new URL('https://nominatim.openstreetmap.org/search')
    url.searchParams.set('q', q)
    url.searchParams.set('format', 'json')
    url.searchParams.set('addressdetails', '1')
    url.searchParams.set('countrycodes', 'us')
    url.searchParams.set('limit', '6')
    const res = await fetch(url.toString(), {
      signal,
      headers: { Accept: 'application/json' },
    })
    if (!res.ok) {
      setSuggestions([])
      return
    }
    const data = (await res.json()) as NominatimResult[]
    setSuggestions(
      (data || []).map((r) => {
        const a = r.address || {}
        const street = [a.house_number, a.road].filter(Boolean).join(' ').trim()
        const city =
          a.city ||
          a.town ||
          a.village ||
          a.hamlet ||
          a.suburb ||
          a.county ||
          ''
        const stateCode =
          STATE_NAME_TO_CODE[(a.state || '').toLowerCase()] || ''
        const zip = a.postcode || ''
        return {
          key: String(r.place_id),
          label: r.display_name,
          pickedValue: formatAddressLine({ street, city, stateCode, zip }),
          source: 'nominatim',
        }
      }),
    )
  }

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

  // Reset hover-highlight when the suggestion list changes.
  useEffect(() => {
    setActiveIndex(-1)
  }, [suggestions])

  async function applySuggestion(s: Suggestion) {
    if (s.source === 'google' && s.placeId) {
      // Upgrade the prediction's "Street, City, ST, USA" string to
      // the full Place Details "Street, City, ST 12345, USA" so the
      // stored address has the ZIP. Best-effort — if Details fails,
      // fall back to the prediction's description (no ZIP, but still
      // routable for tz derivation).
      setLoading(true)
      try {
        const res = await fetch(
          `/api/agent/maps/places/details?placeId=${encodeURIComponent(s.placeId)}`,
        )
        if (res.ok) {
          const data = (await res.json()) as { formattedAddress: string }
          if (data.formattedAddress) {
            commit(stripCountryTail(data.formattedAddress))
            setOpen(false)
            inputRef.current?.focus()
            setLoading(false)
            return
          }
        }
      } catch {
        // fall through to the prediction-only path below
      } finally {
        setLoading(false)
      }
    }
    commit(s.pickedValue)
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
      setActiveIndex((i) => (i <= 0 ? suggestions.length - 1 : i - 1))
    } else if (e.key === 'Enter' && activeIndex >= 0) {
      e.preventDefault()
      void applySuggestion(suggestions[activeIndex])
    } else if (e.key === 'Escape') {
      setOpen(false)
    }
  }

  return (
    <div ref={wrapRef} className="relative">
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
              key={s.key}
              type="button"
              onClick={() => void applySuggestion(s)}
              onMouseEnter={() => setActiveIndex(i)}
              className={`flex w-full items-start gap-2 border-b border-zinc-100 px-3 py-2 text-left text-xs last:border-b-0 dark:border-zinc-800 ${
                i === activeIndex
                  ? 'bg-blue-50 dark:bg-blue-950'
                  : 'hover:bg-zinc-50 dark:hover:bg-zinc-800'
              }`}
            >
              <MapPin className="mt-0.5 h-3 w-3 flex-shrink-0 text-zinc-400" />
              <span className="leading-tight">{s.label}</span>
            </button>
          ))}
          <p className="border-t border-zinc-100 px-3 py-1.5 text-[10px] text-zinc-400 dark:border-zinc-800">
            {usingNominatim
              ? 'Suggestions via OpenStreetMap (add "Google Maps Key" to vault for faster results)'
              : 'Suggestions via Google Maps'}{' '}
            · ↑↓ to navigate · Enter to pick
          </p>
        </div>
      )}
    </div>
  )
}

// ----------------------------------------------------------------------------

const inputCls =
  'w-full rounded-md border border-zinc-200 bg-white px-3 py-2 text-sm focus:border-blue-500 focus:outline-none disabled:opacity-50 dark:border-zinc-800 dark:bg-zinc-950'

/**
 * Strip the trailing ", USA" / ", United States" tail that Google
 * adds to every US address. Our stored format and the timezone
 * resolver don't need it — and it shows up cluttered in the
 * master tracker / Slack post otherwise.
 */
function stripCountryTail(s: string): string {
  return s.replace(/,\s*(USA|United States)\s*$/i, '').trim()
}

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
  const streetCity = [parts.street, parts.city].filter(Boolean).join(', ')
  const stateZip = [parts.stateCode, parts.zip].filter(Boolean).join(' ')
  return [streetCity, stateZip].filter(Boolean).join(', ')
}

// ---- Nominatim response shape ---------------------------------------------

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
