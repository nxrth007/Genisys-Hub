'use client'

import { useEffect, useState } from 'react'
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
    'border-success/30 bg-success/15 text-success border-success/30 bg-success/15 text-success',
  good:
    'border-primary/30 bg-primary-soft text-primary border-primary/30 bg-primary-soft text-primary',
  limited:
    'border-warning/30 bg-warning/15 text-warning border-warning/30 bg-warning/15 text-warning',
  unavailable:
    'border-border bg-surface-muted text-muted-foreground border-border bg-background text-muted-foreground',
}

const VIABILITY_LABEL: Record<SolarSummary['viability'], string> = {
  excellent: 'Excellent',
  good: 'Good',
  limited: 'Limited',
  unavailable: 'No data',
}

export function SolarInsightsCard({
  address,
  initialSummary,
}: {
  address: string
  /** Pre-loaded summary from a prior lookup (e.g. snapshotted on
   *  the appointment row at booking time). When provided, the card
   *  renders the result immediately instead of the "Check solar
   *  potential" button — Mary still has the Refresh affordance to
   *  re-pull current data, which hits cache and is free. */
  initialSummary?: SolarSummary | null
}) {
  // Match AddressMapPreview's pattern — gate on a post-mount flag so
  // server HTML and client HTML can't diverge. Both components share
  // the same parent form; if either hydrated inconsistently the
  // whole tree got torn down (React error #418), which broke the
  // map's debounced fetch chain too.
  const [mounted, setMounted] = useState(false)
  useEffect(() => {
    setMounted(true)
  }, [])

  const [state, setState] = useState<
    | { kind: 'idle' }
    | { kind: 'loading' }
    | { kind: 'error'; message: string; soft?: boolean }
    | { kind: 'ok'; summary: SolarSummary }
  >(() =>
    initialSummary ? { kind: 'ok', summary: initialSummary } : { kind: 'idle' },
  )

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

  if (!mounted) return null

  return (
    <div className="mt-2">
      {state.kind === 'idle' && (
        <button
          type="button"
          onClick={fetchInsights}
          disabled={!ready}
          className={cn(
            'inline-flex items-center gap-1.5 rounded-md border border-dashed border-warning/30 px-2.5 py-1.5 text-xs font-medium text-warning transition',
            ready
              ? 'hover:border-amber-400 hover:bg-warning/15 border-warning/30 text-warning hover:bg-warning/10'
              : 'opacity-50 cursor-not-allowed border-border text-muted-foreground/70'
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
        <div className="inline-flex items-center gap-1.5 rounded-md border border-warning/30 bg-warning/15 px-2.5 py-1.5 text-xs text-warning border-warning/30 bg-warning/15 text-warning">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          Pulling solar data…
        </div>
      )}

      {state.kind === 'error' && (
        <div
          className={cn(
            'flex items-start gap-2 rounded-md border px-3 py-2 text-xs',
            state.soft
              ? 'border-warning/30 bg-warning/15 text-warning border-warning/30 bg-warning/15 text-warning'
              : 'border-destructive/30 bg-destructive/10 text-destructive border-destructive/30 bg-destructive/10 text-destructive'
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
          <span className="eyebrow">
            Solar potential — {VIABILITY_LABEL[summary.viability]}
          </span>
        </div>
        <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
          {summary.fromCache && (
            <span
              className="rounded bg-muted px-1.5 py-0.5 font-medium text-muted-foreground bg-surface-muted text-muted-foreground"
              title="This result came from local cache — no API charge"
            >
              Cached
            </span>
          )}
          <button
            type="button"
            onClick={onRefresh}
            className="underline underline-offset-2 hover:text-foreground"
            title="Re-pull from Google. Will reuse cache if available."
          >
            Refresh
          </button>
        </div>
      </div>

      {summary.viability === 'unavailable' ? (
        <p className="mt-2 text-xs text-muted-foreground">
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
        <p className="mt-3 text-[10px] text-muted-foreground">
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
      <p className="flex items-center gap-1 eyebrow text-muted-foreground">
        <Icon className="h-3 w-3" />
        {label}
      </p>
      <p className="mt-0.5 text-sm font-semibold tabular-nums">{value}</p>
      {subtitle && (
        <p className="text-[10px] text-muted-foreground">{subtitle}</p>
      )}
    </div>
  )
}
