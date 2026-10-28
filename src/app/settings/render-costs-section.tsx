'use client'

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Loader2, RefreshCw, Server } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { RenderCosts } from '@/lib/render-costs'

async function readJson<T>(res: Response): Promise<T> {
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error((data as { error?: string }).error || `HTTP ${res.status}`)
  return data as T
}

function dollars(n: number): string {
  const cents = Math.round(n * 100) % 100 !== 0
  return n.toLocaleString('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: cents ? 2 : 0, maximumFractionDigits: 2 })
}

function Tile({ label, value, note }: { label: string; value: string; note: string }) {
  return (
    <div className="rounded-lg border border-border px-3 py-2">
      <p className="eyebrow text-muted-foreground">{label}</p>
      <p className="mt-0.5 text-2xl font-bold tabular-nums">{value}</p>
      <p className="text-[10px] text-muted-foreground">{note}</p>
    </div>
  )
}

/**
 * Settings → Render costs: what hosting the Hub on Render costs a month.
 * Render's API has no billing data, so lib/render-costs.ts prices each
 * service and database from its plan. Took the Solar API usage card's place.
 */
export function RenderCostsSection() {
  const qc = useQueryClient()
  const query = useQuery<RenderCosts>({
    queryKey: ['render-costs'],
    queryFn: async () => readJson<RenderCosts>(await fetch('/api/admin/render/costs')),
    staleTime: 10 * 60_000,
    retry: false,
  })
  const refresh = useMutation({
    mutationFn: async () => readJson<RenderCosts>(await fetch('/api/admin/render/costs?refresh=1')),
    onSuccess: (data) => qc.setQueryData(['render-costs'], data),
  })
  const setPlan = useMutation({
    mutationFn: async (plan: string) =>
      readJson<RenderCosts>(
        await fetch('/api/admin/render/costs', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ plan }),
        }),
      ),
    onSuccess: (data) => qc.setQueryData(['render-costs'], data),
    onError: (err) => window.alert(`Couldn't save the plan: ${(err as Error).message}`),
  })

  const data = query.data
  const error = (refresh.error ?? query.error) as Error | null
  const month = new Date().toLocaleDateString('en-US', { month: 'long' })
  const planName = data?.plans.find((p) => p.id === data.plan)?.label

  return (
    <section className="rounded-xl border border-border bg-card p-6">
      <div className="flex items-start gap-3">
        <div className="rounded-lg bg-muted p-2">
          <Server className="h-5 w-5 text-foreground/80" />
        </div>
        <div className="flex-1">
          <h3 className="text-base font-semibold">Render costs</h3>
          <p className="mt-1 text-sm text-muted-foreground">
            What hosting the Hub on Render costs a month. Render&apos;s API doesn&apos;t give out bills, so each
            service and database is priced from its plan with Render&apos;s price list.
          </p>
        </div>
        <button
          type="button"
          onClick={() => refresh.mutate()}
          disabled={refresh.isPending || query.isLoading}
          title="Read Render again"
          className="grid h-8 w-8 shrink-0 place-items-center rounded-md text-muted-foreground transition hover:bg-muted hover:text-foreground disabled:opacity-50"
        >
          {refresh.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
        </button>
      </div>

      {error && (
        <p className="mt-4 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error.message === 'forbidden' ? 'Only admins can see Render costs.' : `Couldn’t read Render: ${error.message}`}
        </p>
      )}

      {query.isLoading ? (
        <p className="mt-4 text-sm text-muted-foreground">Loading…</p>
      ) : data ? (
        <>
          <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-3">
            <Tile
              label="A month at today's plans"
              value={dollars(data.total)}
              note={planName ? `${planName} plan included` : 'without the workspace plan'}
            />
            <Tile
              label={`Bandwidth in ${month}`}
              value={data.usage.bandwidthGB === null ? '—' : `${data.usage.bandwidthGB.toFixed(1)} GB`}
              note={data.usage.includedGB === null ? 'pick the plan to see what’s included' : `of ${data.usage.includedGB.toLocaleString('en-US')} GB included`}
            />
            <Tile
              label={`Build minutes in ${month}`}
              value={data.usage.buildMinutes === null ? '—' : `≈${data.usage.buildMinutes.toLocaleString('en-US')}`}
              note={data.usage.includedMinutes === null ? 'pick the plan to see what’s included' : `of ${data.usage.includedMinutes.toLocaleString('en-US')} included`}
            />
          </div>

          <div className="mt-4 flex flex-wrap items-center gap-2 text-sm">
            <label htmlFor="render-plan" className="text-muted-foreground">
              Workspace plan
            </label>
            <select
              id="render-plan"
              value={data.plan ?? ''}
              disabled={setPlan.isPending}
              onChange={(e) => setPlan.mutate(e.target.value)}
              className="rounded-md border border-border bg-background px-2 py-1 text-sm focus:border-primary/50 focus:outline-none disabled:opacity-50"
            >
              {!data.plan && <option value="">Choose…</option>}
              {data.plans.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label} ({dollars(p.fee)} a month)
                </option>
              ))}
            </select>
            {!data.plan && (
              <span className="text-xs text-warning">Render&apos;s API doesn&apos;t say which one you&apos;re on.</span>
            )}
          </div>

          <ul className="mt-4 divide-y divide-border rounded-lg border border-border">
            {data.lines.map((l, i) => (
              <li key={i} className="flex items-start justify-between gap-3 px-3 py-2">
                <div className="min-w-0">
                  <p className="text-sm font-medium">
                    {l.url ? (
                      <a href={l.url} target="_blank" rel="noreferrer" className="hover:underline">
                        {l.name}
                      </a>
                    ) : (
                      l.name
                    )}
                  </p>
                  <p className="text-xs text-muted-foreground">{l.detail}</p>
                </div>
                <p className={cn('shrink-0 text-sm tabular-nums', l.monthly === null && 'text-muted-foreground')}>
                  {l.monthly === null ? 'not priced' : dollars(l.monthly)}
                </p>
              </li>
            ))}
          </ul>

          {data.usage.error && (
            <p className="mt-3 text-xs text-warning">Couldn&apos;t read this month&apos;s usage: {data.usage.error}</p>
          )}
          <p className="mt-3 text-[11px] text-muted-foreground">
            {data.unpriced > 0 &&
              `${data.unpriced} ${data.unpriced === 1 ? 'item isn’t' : 'items aren’t'} in the price list, so the total leaves ${data.unpriced === 1 ? 'it' : 'them'} out. `}
            Prices from render.com/pricing as of October 2026. Build minutes are counted from deploy times, so they run a
            little high. Render bills by the second, and its{' '}
            <a
              href="https://dashboard.render.com/billing"
              target="_blank"
              rel="noreferrer"
              className="underline underline-offset-2 hover:text-primary"
            >
              billing page
            </a>{' '}
            has the actual invoice. Read from Render{' '}
            {new Date(data.checkedAt).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}.
          </p>
        </>
      ) : null}
    </section>
  )
}
