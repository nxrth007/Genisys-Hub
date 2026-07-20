'use client'

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

/**
 * Shared types + data hooks for the two roofing tabs.
 *
 * Roofing Clients (who we bill, at what rate, under what cap) and NCT
 * Leads (the live pipeline) read the same overview payload under one
 * query key, so editing a cap on one tab is immediately reflected on
 * the other without a refetch storm.
 */

export type RoofingClient = {
  id: string
  clientName: string
  stripeCustomerId: string
  pricePerLeadCents: number
  costPerLeadCents: number
  weeklyCapCents: number
  sourceKey: string
  active: boolean
  contactName: string | null
  contactEmail: string | null
  contactPhone: string | null
  notes: string | null
  createdAt: string
  weekSpentCents: number
  weekLeadCount: number
  lifetimeRevenueCents: number
  lifetimeLeadCount: number
  lifetimeCostCents: number
  lastLeadAt: string | null
}

export type NctOverview = {
  ok: true
  settings: {
    webhookToken: string
    chargingEnabled: boolean
    sweepEnabled: boolean
    sweepMethod: string
    sweepDestinationId: string | null
    sweepFloorCents: number
    sweepMinCents: number
    alertChannel: string | null
    lastSweepAt: string | null
  }
  destinations: Array<{ id: string; kind: string; label: string }>
  configs: RoofingClient[]
  week: {
    startsAt: string
    chargedCents: number
    leadCount: number
    costCents: number
    marginCents: number
  }
  alerts: { failedCount: number; cappedCount: number }
  leads: Array<{
    id: string
    leadId: string
    name: string | null
    phone: string | null
    email: string | null
    address: string | null
    service: string | null
    clientName: string | null
    amountCents: number
    chargeStatus: string
    failureReason: string | null
    receivedAt: string
    chargedAt: string | null
  }>
  sweeps: Array<{
    id: string
    amountCents: number
    method: string
    status: string
    detail: string | null
    manual: boolean
    stripePayoutId: string | null
    createdAt: string
  }>
}

export type Notice = { tone: 'ok' | 'err'; text: string } | null

export function useNctOverview() {
  return useQuery<NctOverview>({
    queryKey: ['payments-nct'],
    queryFn: async () => {
      const res = await fetch('/api/payments/nct/overview')
      const d = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(d.message || d.error || 'Failed to load')
      return d
    },
    refetchInterval: 30_000,
  })
}

export function useNctAction(onNotice: (n: Notice) => void) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (payload: Record<string, unknown>) => {
      const res = await fetch('/api/payments/nct/actions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      const d = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(d.error || 'Action failed.')
      return d as { message?: string }
    },
    onSuccess: (d) => {
      onNotice({ tone: 'ok', text: d.message || 'Done.' })
      queryClient.invalidateQueries({ queryKey: ['payments-nct'] })
    },
    onError: (e) =>
      onNotice({
        tone: 'err',
        text: e instanceof Error ? e.message : 'Action failed.',
      }),
  })
}
