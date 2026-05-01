'use client'

import { useState } from 'react'
import { Sun, Loader2, AlertCircle, Cpu, Maximize2, Zap } from 'lucide-react'
import { cn } from '@/lib/utils'

/**
 * "Check solar potential" button + result card on the booking form.
 *
 * Mary clicks → Hub geocodes the address → calls Google Solar API
 * → shows roof viability, sunshine hours, panel count, energy.
 * Manual click instead of auto-fire so each billable lookup is a
 * deliberate action, not a side-effect of typing.
 *
 * Cache means same-address re-clicks are free, so Mary can re-pull
 * the data later without worrying about cost. The "Cached" indicator
 * tells her when a click was free vs. billed.
 */

type SolarSummary = {
  viability: 'excellent' | 'good' | 'limited' | 'unavailable'
  imageryQuality: 'HIGH' | 'MEDIUM' | 'LOW' | null
  imageryCapturedAt: string | null
  roofAreaM2: number | null
  maxSunshineHoursPerYear: number | null
  maxPanelCount: number | null
  recommendedAnnualKwh: number | null
  recommendedPanelCount: number | null
  latitude: number | null
  longitude: number | null
  fromCache: boolean
}

const VIABILITY_TONE: Record<SolarSummary['viability'], string> = {
  excellent:
    'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900/50 dark:bg-emerald-950/40 dark:text-emerald-300',
  good:
    'border-blue-200 bg-blue-50 text-blue-700 dark:border-blue-900/50 dark:bg-blue-950/40 dark:text-blue-300',
  limited:
    'border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-900/50 dark:bg-amber-950/40 dark:text-amber-300',
  unavailable:
    'border-zinc-200 bg-zinc-50 text-zinc-600 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-400',
}

const VIABILITY_LABEL: Record<SolarSummary['viability'], string> = {
  excellent: 'Excellent',
  good: 'Good',
  limited: 'Limited',
  unavailable: 'No data',
}

export function SolarInsightsCard({ address }: { address: string }) {
  const [state, setState] = useState<
    | { kind: 'idle' }
    | { kind: 'loading' }
    | { kind: 'error'; message: string; soft?: boolean }
    | { kind: 'ok'; summary: SolarSummary }
  >({ kind: 'idle' })

  const trimmed = address.trim()
  const ready = trimmed.length >= 5

  async function fetchInsights() {
    setState({ kind: 'loading' })
    try {
      const res = await fetch(
        `/api/agent/solar/insights?address=${encodeURIComponent(trimmed)}`
      )
      const json = await res.json()
      if (res.status === 503) {
        // Vault key missing — soft hide rather than blocking. Mary
        // sees nothing; admin sees the original error in the logs.
        setState({ kind: 'idle' })
        return
      }
      if (!res.ok) {
        setState({
          kind: 'error',
          message: json.error || 'Lookup failed',
          // 422 = "address not found" / "no data for location" —
          // user-correctable, not a real failure
          soft: res.status === 422,
        })
        return
      }
      setState({ kind: 'ok', summary: json.summary })
    } catch (err) {
      setState({
        kind: 'error',
        message: err instanceof Error ? err.message : 'Lookup failed',
      })
    }
  }

  return (
    <div className="mt-2">
      {state.kind === 'idle' && (
        <button
          type="button"
          onClick={fetchInsights}
          disabled={!ready}
          className={cn(
            'inline-flex items-center gap-1.5 rounded-md border border-dashed border-amber-300 px-2.5 py-1.5 text-xs font-medium text-amber-700 transition',
            ready
              ? 'hover:border-amber-400 hover:bg-amber-50 dark:border-amber-800 dark:text-amber-300 dark:hover:bg-amber-950/30'
              : 'opacity-50 cursor-not-allowed dark:border-zinc-800 dark:text-zinc-500'
          )}
          title={
            ready
              ? 'Look up roof solar potential via Google Solar API'
              : 'Type an address first'
          }
        >
          <Sun className="h-3.5 w-3.5" />
          Check solar potential
        </button>
      )}

      {state.kind === 'loading' && (
        <div className="inline-flex items-center gap-1.5 rounded-md border border-amber-300 bg-amber-50 px-2.5 py-1.5 text-xs text-amber-700 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-300">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          Pulling solar data…
        </div>
      )}

      {state.kind === 'error' && (
        <div
          className={cn(
            'flex items-start gap-2 rounded-md border px-3 py-2 text-xs',
            state.soft
              ? 'border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-900/50 dark:bg-amber-950/40 dark:text-amber-200'
              : 'border-rose-200 bg-rose-50 text-rose-700 dark:border-rose-900/50 dark:bg-rose-950/40 dark:text-rose-300'
          )}
        >
          <AlertCircle className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" />
          <div className="flex-1">
            {state.message}
            <button
              type="button"
              onClick={fetchInsights}
              className="ml-2 underline underline-offset-2"
            >
              Retry
            </button>
          </div>
        </div>
      )}

      {state.kind === 'ok' && (
        <SolarResultCard summary={state.summary} onRefresh={fetchInsights} />
      )}
    </div>
  )
}

function SolarResultCard({
  summary,
  onRefresh,
}: {
  summary: SolarSummary
  onRefresh: () => void
}) {
  return (
    <div
      className={cn(
        'rounded-lg border p-3',
        VIABILITY_TONE[summary.viability]
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Sun className="h-4 w-4" />
          <span className="text-xs font-semibold uppercase tracking-wider">
            Solar potential — {VIABILITY_LABEL[summary.viability]}
          </span>
        </div>
        <div className="flex items-center gap-2 text-[10px] text-zinc-500">
          {summary.fromCache && (
            <span
              className="rounded bg-zinc-100 px-1.5 py-0.5 font-medium text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400"
              title="This result came from local cache — no API charge"
            >
              Cached
            </span>
          )}
          <button
            type="button"
            onClick={onRefresh}
            className="underline underline-offset-2 hover:text-zinc-700 dark:hover:text-zinc-200"
            title="Re-pull from Google. Will reuse cache if available."
          >
            Refresh
          </button>
        </div>
      </div>

      {summary.viability === 'unavailable' ? (
        <p className="mt-2 text-xs text-zinc-600 dark:text-zinc-400">
          Google has no solar imagery for this location. Common in rural areas
          or recent construction. The customer is still bookable — Mary can
          rely on her own qualifying questions instead.
        </p>
      ) : (
        <div className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 text-xs sm:grid-cols-4">
          <Stat
            icon={Sun}
            label="Sunshine"
            value={
              summary.maxSunshineHoursPerYear != null
                ? `${Math.round(summary.maxSunshineHoursPerYear).toLocaleString()} hrs/yr`
                : '—'
            }
          />
          <Stat
            icon={Cpu}
            label="Max panels"
            value={
              summary.maxPanelCount != null
                ? `${summary.maxPanelCount}`
                : '—'
            }
            subtitle={
              summary.recommendedPanelCount != null &&
              summary.recommendedPanelCount !== summary.maxPanelCount
                ? `${summary.recommendedPanelCount} typical`
                : null
            }
          />
          <Stat
            icon={Zap}
            label="Est. production"
            value={
              summary.recommendedAnnualKwh != null
                ? `${Math.round(summary.recommendedAnnualKwh).toLocaleString()} kWh/yr`
                : '—'
            }
          />
          <Stat
            icon={Maximize2}
            label="Roof area"
            value={
              summary.roofAreaM2 != null
                ? `${Math.round(summary.roofAreaM2 * 10.7639).toLocaleString()} sq ft`
                : '—'
            }
          />
        </div>
      )}

      {(summary.imageryQuality || summary.imageryCapturedAt) && (
        <p className="mt-3 text-[10px] text-zinc-500">
          Imagery:{' '}
          {summary.imageryQuality
            ? summary.imageryQuality.toLowerCase() + ' quality'
            : 'unknown quality'}
          {summary.imageryCapturedAt && ` · captured ${summary.imageryCapturedAt}`}
        </p>
      )}
    </div>
  )
}

function Stat({
  icon: Icon,
  label,
  value,
  subtitle,
}: {
  icon: React.ComponentType<{ className?: string }>
  label: string
  value: string
  subtitle?: string | null
}) {
  return (
    <div className="min-w-0">
      <p className="flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wider text-zinc-500">
        <Icon className="h-3 w-3" />
        {label}
      </p>
      <p className="mt-0.5 text-sm font-semibold tabular-nums">{value}</p>
      {subtitle && (
        <p className="text-[10px] text-zinc-500">{subtitle}</p>
      )}
    </div>
  )
}
