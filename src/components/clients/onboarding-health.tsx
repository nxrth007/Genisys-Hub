'use client'

import Link from 'next/link'
import { useQuery } from '@tanstack/react-query'
import { AlertTriangle, CheckCircle2, Webhook } from 'lucide-react'
import { cn } from '@/lib/utils'

/**
 * One line under the Clients header: is the onboarding form still
 * landing in the Hub? A submission the Hub can't accept is a client
 * nobody knows about, so this shows the secret is set, when the last one
 * arrived, and whether any intake never became a Client.
 */

type Health = {
  webhookUrl: string
  secretConfigured: boolean
  lastIntake: { id: string; at: string; businessName: string | null; clientId: string | null } | null
  intakes30d: number
  unlinked: number
  total: number
}

function ago(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime()
  const d = Math.floor(ms / 86_400_000)
  if (d >= 1) return d === 1 ? 'yesterday' : `${d} days ago`
  const h = Math.floor(ms / 3_600_000)
  if (h >= 1) return `${h}h ago`
  const m = Math.max(1, Math.floor(ms / 60_000))
  return `${m}m ago`
}

export function OnboardingHealth() {
  const q = useQuery<Health>({
    queryKey: ['clients-onboarding-health'],
    queryFn: async () => {
      const res = await fetch('/api/clients/onboarding-health')
      if (!res.ok) throw new Error(`Failed to load (${res.status})`)
      return res.json()
    },
    staleTime: 60_000,
  })
  if (!q.data) return null
  const h = q.data
  const problem = !h.secretConfigured
    ? 'The webhook secret is missing from the Vault — every submission is being rejected.'
    : h.unlinked > 0
      ? `${h.unlinked} submission${h.unlinked === 1 ? '' : 's'} never became a client (no business name?).`
      : null

  return (
    <div
      className={cn(
        'flex flex-wrap items-center gap-x-4 gap-y-1 rounded-xl border px-4 py-2.5 text-[12.5px]',
        problem ? 'border-warning/40 bg-warning/10 text-warning' : 'border-border-soft bg-surface text-muted-foreground',
      )}
    >
      <span className="inline-flex items-center gap-1.5 font-medium text-foreground/85">
        <Webhook className="h-3.5 w-3.5" /> Onboarding webhook
      </span>
      <span className="inline-flex items-center gap-1.5">
        {problem ? <AlertTriangle className="h-3.5 w-3.5" /> : <CheckCircle2 className="h-3.5 w-3.5 text-success" />}
        {problem ?? 'Live, secret set'}
      </span>
      <span>
        Last submission:{' '}
        {h.lastIntake ? (
          <>
            <span className="text-foreground/85">{h.lastIntake.businessName ?? 'unnamed'}</span>, {ago(h.lastIntake.at)}
          </>
        ) : (
          'none yet'
        )}
      </span>
      <span>{h.intakes30d} in the last 30 days</span>
      <Link href="/clients/onboarding" className="ml-auto underline underline-offset-2 hover:text-foreground">
        Onboarding answers
      </Link>
    </div>
  )
}
