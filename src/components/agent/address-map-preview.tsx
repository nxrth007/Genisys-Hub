'use client'

import { useQuery } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { Loader2, MapPin, AlertCircle } from 'lucide-react'

/**
 * Embedded Google Maps preview for the booking form's address field.
 * Mary uses this to visually verify the customer's home location
 * before confirming the appointment.
 *
 * Behavior:
 *   - Empty address → renders nothing (no placeholder noise)
 *   - Vault key not configured (503) → renders nothing too, so the
 *     form ships before the key lands and just lights up later
 *   - Address typed → debounced fetch of /api/agent/maps/embed-url,
 *     iframe with the resolved URL when ready
 *
 * Debouncing matters because the address-fields autocomplete rewrites
 * the combined string on every keystroke; without debounce we'd
 * thrash both Google and the vault on every letter typed.
 */

export function AddressMapPreview({ address }: { address: string }) {
  const trimmed = address.trim()

  // Local debounce so we only ask the API once the user has stopped
  // typing (or paused for 500ms). The vault read is cheap but the
  // Google Embed iframe re-renders cause a visual flicker we'd
  // rather avoid mid-typing.
  const [debounced, setDebounced] = useState(trimmed)
  useEffect(() => {
    const id = setTimeout(() => setDebounced(trimmed), 500)
    return () => clearTimeout(id)
  }, [trimmed])

  const query = useQuery<
    { url: string } | { error: string },
    Error
  >({
    queryKey: ['maps-embed-url', debounced],
    enabled: debounced.length >= 5,
    queryFn: async () => {
      const res = await fetch(
        `/api/agent/maps/embed-url?address=${encodeURIComponent(debounced)}`
      )
      const json = await res.json()
      if (!res.ok) {
        // 503 = no API key in vault yet. Treat as a soft "feature off"
        // so the parent renders nothing rather than an error stripe.
        const err = new Error(json.error || 'failed') as Error & {
          status?: number
        }
        err.status = res.status
        throw err
      }
      return json
    },
    retry: (failureCount, err) => {
      const status = (err as { status?: number }).status
      // Don't retry "key missing" — it'll just keep failing until an
      // admin pastes the key. Retry transient errors twice.
      if (status === 503) return false
      return failureCount < 2
    },
    staleTime: 60_000,
  })

  if (debounced.length < 5) return null
  // Soft-hide on missing-key — admins see a hint via the error block,
  // agents see nothing. Distinguishes the two by error.status if we
  // had it, but keeping a single pattern simpler.
  const status = (query.error as { status?: number } | null)?.status
  if (status === 503) return null

  return (
    <div className="mt-2 overflow-hidden rounded-lg border border-zinc-200 dark:border-zinc-700">
      <div className="flex items-center gap-1.5 border-b border-zinc-200 bg-zinc-50 px-3 py-1.5 text-[11px] font-medium text-zinc-500 dark:border-zinc-700 dark:bg-zinc-900">
        <MapPin className="h-3 w-3" />
        Verify on map
      </div>
      <div className="relative aspect-[16/7] w-full bg-zinc-100 dark:bg-zinc-800">
        {query.isLoading ? (
          <div className="absolute inset-0 flex items-center justify-center text-xs text-zinc-500">
            <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
            Loading map…
          </div>
        ) : query.isError ? (
          <div className="absolute inset-0 flex items-center justify-center gap-1.5 px-4 text-center text-xs text-rose-600">
            <AlertCircle className="h-3.5 w-3.5 flex-shrink-0" />
            <span>{(query.error as Error).message || 'Failed to load map'}</span>
          </div>
        ) : 'url' in (query.data ?? {}) ? (
          <iframe
            src={(query.data as { url: string }).url}
            // Google's Embed API explicitly supports loading="lazy" +
            // referrerpolicy="no-referrer-when-downgrade". Width/height
            // controlled via the wrapper's aspect-ratio for responsive.
            className="absolute inset-0 h-full w-full border-0"
            loading="lazy"
            referrerPolicy="no-referrer-when-downgrade"
            allowFullScreen
            title={`Map of ${debounced}`}
          />
        ) : null}
      </div>
    </div>
  )
}
