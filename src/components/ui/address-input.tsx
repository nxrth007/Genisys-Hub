'use client'

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
 * Single-field UX — type, pick a suggestion, input fills with the
 * canonical address. Downstream code (timezone resolver, master
 * tracker, Slack body) parses the state out of the address string
 * the same way it always did.
 *
 * Manual typing is still allowed for cases neither backend has —
 * the dropdown guides, doesn't gate.
 *
 * Generic by design — pass `endpoint` to point at a different
 * server-proxied API (used by /agent vs the public client onboarding
 * form, which have different auth gates), and `stateBias` to bias
 * suggestions toward a specific US state.
 */
import { useEffect, useRef, useState } from 'react'
import { MapPin, Loader2 } from 'lucide-react'
import { STATE_NAME_TO_CODE } from '@/lib/address'

type Props = {
  value: string
  onChange: (combined: string) => void
  disabled?: boolean
  /** Optional id used by the surrounding form's <label> association. */
  id?: string
  /** When true, the input gets HTML5 required + a red asterisk. */
  requireStreet?: boolean
  /** Base path for the autocomplete + details server proxies. Lets
   *  callers use the gated agent endpoints OR the public-onboarding
   *  endpoints without forking the component. Defaults to the agent
   *  path so existing call sites work unchanged. */
  endpoint?: string
  /** Optional US state hint — full name OR 2-letter code. Biases
   *  Google's autocomplete toward addresses in that state when
   *  provided (Nominatim doesn't support state biasing in its free
   *  tier, so the fallback ignores it). Useful when the surrounding
   *  form has already collected a State value. */
  stateBias?: string | null
  /** Placeholder text. */
  placeholder?: string
  /** Optional CSS class for the input element — overrides the default. */
  className?: string
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

const DEFAULT_ENDPOINT = '/api/agent/maps/places'

/** Normalize a stateBias prop value (full name or 2-letter code in
 *  any case) to a 2-letter uppercased code suitable for Google's
 *  components=administrative_area filter. Returns null if unknown
 *  so we just don't bias. */
function normalizeBias(input: string | null | undefined): string | null {
  if (!input) return null
  const trimmed = input.trim()
  if (!trimmed) return null
  const lower = trimmed.toLowerCase()
  if (STATE_NAME_TO_CODE[lower]) return STATE_NAME_TO_CODE[lower]
  if (trimmed.length === 2) {
    const upper = trimmed.toUpperCase()
    if (Object.values(STATE_NAME_TO_CODE).includes(upper)) return upper
  }
  return null
}

export function AddressInput({
  value,
  onChange,
  disabled,
  id,
  requireStreet,
  endpoint = DEFAULT_ENDPOINT,
  stateBias,
  placeholder = 'Start typing — e.g. 123 Main St Cerritos CA',
  className,
}: Props) {
  const [draft, setDraft] = useState(value)
  const [suggestions, setSuggestions] = useState<Suggestion[]>([])
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [activeIndex, setActiveIndex] = useState(-1)
  const [usingNominatim, setUsingNominatim] = useState(false)
  // Visible status state — when the autocomplete fetch returns empty
  // OR errors, we used to silently render nothing. That made silent
  // failures (auth blocked, vault key missing + Nominatim slow, etc.)
  // look like a UI bug. Now we surface a one-line status in the
  // dropdown footer so the user sees what happened.
  const [status, setStatus] = useState<
    'idle' | 'searching' | 'noResults' | 'error'
  >('idle')
  const wrapRef = useRef<HTMLDivElement | null>(null)
  const inputRef = useRef<HTMLInputElement | null>(null)

  const biasCode = normalizeBias(stateBias)

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

  // Debounced suggestion fetch.
  useEffect(() => {
    const q = draft.trim()
    if (q.length < 3) {
      setSuggestions([])
      setStatus('idle')
      return
    }
    const controller = new AbortController()
    const timer = setTimeout(async () => {
      try {
        setLoading(true)
        setStatus('searching')
        let nextSuggestions: Suggestion[] = []
        if (!usingNominatim) {
          const params = new URLSearchParams({ q })
          if (biasCode) params.set('state', biasCode)
          const res = await fetch(
            `${endpoint}/autocomplete?${params.toString()}`,
            { signal: controller.signal },
          )
          if (res.status === 503) {
            setUsingNominatim(true)
            nextSuggestions = await fetchNominatim(q, controller.signal)
          } else if (!res.ok) {
            // Surface non-OK responses so silent 401/403/500s aren't
            // mistaken for "no results". Console.warn so admin can
            // open DevTools and see what actually went wrong.
            console.warn(
              `[address-input] ${endpoint}/autocomplete returned ${res.status}`,
            )
            setSuggestions([])
            setStatus('error')
            return
          } else {
            const data = (await res.json()) as {
              predictions: Array<{ description: string; placeId: string }>
            }
            nextSuggestions = data.predictions.map((p) => ({
              key: p.placeId,
              label: p.description,
              pickedValue: stripCountryTail(p.description),
              source: 'google',
              placeId: p.placeId,
            }))
          }
        } else {
          nextSuggestions = await fetchNominatim(q, controller.signal)
        }
        setSuggestions(nextSuggestions)
        setStatus(nextSuggestions.length === 0 ? 'noResults' : 'idle')
      } catch (err) {
        if ((err as Error).name === 'AbortError') return
        console.warn('[address-input] suggestion fetch threw:', err)
        setSuggestions([])
        setStatus('error')
      } finally {
        setLoading(false)
      }
    }, 200)

    return () => {
      clearTimeout(timer)
      controller.abort()
    }
  }, [draft, usingNominatim, endpoint, biasCode])

  async function fetchNominatim(
    q: string,
    signal: AbortSignal,
  ): Promise<Suggestion[]> {
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
      console.warn('[address-input] nominatim returned', res.status)
      return []
    }
    const data = (await res.json()) as NominatimResult[]
    const results = (data || []).map((r) => {
      const a = r.address || {}
      const street = [a.house_number, a.road].filter(Boolean).join(' ').trim()
      const city =
        a.city || a.town || a.village || a.hamlet || a.suburb || a.county || ''
      const stateCode =
        STATE_NAME_TO_CODE[(a.state || '').toLowerCase()] || ''
      const zip = a.postcode || ''
      return {
        key: String(r.place_id),
        label: r.display_name,
        pickedValue: formatAddressLine({ street, city, stateCode, zip }),
        source: 'nominatim' as const,
        _stateMatch: biasCode ? stateCode === biasCode : true,
      }
    })
    // Bias: prefer in-state matches, but fall back to the full list
    // when there are none so the user still sees something.
    const inState = results.filter((r) => r._stateMatch)
    const ordered = inState.length > 0 ? inState : results
    return ordered.map((r) => ({
      key: r.key,
      label: r.label,
      pickedValue: r.pickedValue,
      source: r.source,
    }))
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
      setLoading(true)
      try {
        const res = await fetch(
          `${endpoint}/details?placeId=${encodeURIComponent(s.placeId)}`,
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
        placeholder={placeholder}
        autoComplete="off"
        className={className ?? defaultInputCls}
      />

      {/* Dropdown — renders as long as the user has triggered it,
          even when there are no suggestions yet. The status footer
          tells them what's happening (searching / no results /
          suggestions returned an error) so a silent failure doesn't
          look like a UI bug. */}
      {open && draft.trim().length >= 3 && (
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
          {/* Empty / status states. Keep them inside the dropdown so
              the visual chrome is consistent regardless of outcome. */}
          {suggestions.length === 0 && status === 'searching' && (
            <p className="px-3 py-3 text-xs text-zinc-500 dark:text-zinc-400">
              Searching addresses…
            </p>
          )}
          {suggestions.length === 0 && status === 'noResults' && (
            <p className="px-3 py-3 text-xs text-zinc-500 dark:text-zinc-400">
              No matches yet — keep typing your full address.
            </p>
          )}
          {suggestions.length === 0 && status === 'error' && (
            <p className="px-3 py-3 text-xs text-amber-700 dark:text-amber-400">
              Couldn&apos;t load suggestions right now. You can keep
              typing your address manually — we&apos;ll save it as-is.
            </p>
          )}
          <p className="border-t border-zinc-100 px-3 py-1.5 text-[10px] text-zinc-400 dark:border-zinc-800">
            {usingNominatim
              ? 'Suggestions via OpenStreetMap'
              : 'Suggestions via Google Maps'}
            {biasCode && !usingNominatim && ` · biased to ${biasCode}`}
            {' · ↑↓ to navigate · Enter to pick'}
          </p>
        </div>
      )}
    </div>
  )
}

const defaultInputCls =
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
