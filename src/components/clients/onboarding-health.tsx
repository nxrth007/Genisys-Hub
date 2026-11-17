'use client'

import Link from 'next/link'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, CheckCircle2, CreditCard, Loader2, RefreshCw, Webhook } from 'lucide-react'
import { cn } from '@/lib/utils'

/**
 * One strip under the Clients header: is the onboarding form still
 * landing in the Hub? Two paths feed it — the form's webhook (instant)
 * and the Hub's own read of the form's Google Sheet (every few minutes,
 * and on demand here). A submission that misses the first is caught by
 * the second, and this says which is doing the work.
 *
 * A second line is the Stripe sign-up gate (the form only takes answers
 * from a client whose free trial started in Stripe): whether the Hub can
 * ask Stripe, the form's last question to the Hub, Stripe's last event,
 * and the last sign-up. The team doesn't read Slack, so this is where
 * those answers live.
 */

type SheetStatus = {
  ok: boolean
  checkedAt: string
  sheetRows: number
  imported: { businessName: string | null; at: string | null }[]
  recoveredTotal: number
  error: string | null
  account: string | null
}

type StripeStatus = {
  selfCheck: { at: string; ok: boolean; problems: string[]; notes?: string[]; keyMode: 'live' | 'test' | null; sameAccount?: boolean | null } | null
  verify: { at: string; outcome: 'ok' | 'not_member' | 'unauthorized' | 'unavailable'; asked: 'session' | 'email' | 'unknown' } | null
  webhook: { at: string; type: string; livemode: boolean } | null
  signup: { at: string; who: string; email: string | null; price: string | null; trialEnd: string | null; livemode: boolean } | null
}

type Health = {
  webhookUrl: string
  secretConfigured: boolean
  lastIntake: { id: string; at: string; businessName: string | null; clientId: string | null } | null
  intakes30d: number
  unlinked: number
  total: number
  sheet: SheetStatus | null
  stripe: StripeStatus | null
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

const VERIFY_WORDS: Record<NonNullable<StripeStatus['verify']>['outcome'], string> = {
  ok: 'last check passed',
  not_member: 'last check: no live trial for that link or email (a bad or unfinished checkout)',
  unauthorized: 'the form’s password doesn’t match the Vault — fix HUB_VERIFICATION_KEY in Lovable',
  unavailable: 'Stripe couldn’t be asked — see the check above',
}

export function OnboardingHealth() {
  const qc = useQueryClient()
  const q = useQuery<Health>({
    queryKey: ['clients-onboarding-health'],
    queryFn: async () => {
      const res = await fetch('/api/clients/onboarding-health')
      if (!res.ok) throw new Error(`Failed to load (${res.status})`)
      return res.json()
    },
    staleTime: 60_000,
  })
  const sync = useMutation({
    mutationFn: async (): Promise<Health> => {
      const res = await fetch('/api/clients/onboarding-health', { method: 'POST' })
      if (!res.ok) throw new Error(`Sync failed (${res.status})`)
      return res.json()
    },
    onSuccess: (data) => {
      qc.setQueryData(['clients-onboarding-health'], data)
      // New clients may have just arrived.
      qc.invalidateQueries({ queryKey: ['clients-roster'] })
    },
  })
  const stripeCheck = useMutation({
    mutationFn: async (): Promise<Health> => {
      const res = await fetch('/api/clients/onboarding-health', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'stripe' }) })
      if (!res.ok) throw new Error(`Check failed (${res.status})`)
      return res.json()
    },
    onSuccess: (data) => qc.setQueryData(['clients-onboarding-health'], data),
  })

  if (!q.data) return null
  const h = q.data
  const s = h.sheet
  const st = h.stripe
  const justImported = sync.isSuccess ? (sync.data?.sheet?.imported.length ?? 0) : 0

  const problem = !h.secretConfigured
    ? 'The webhook secret is missing from the Vault — the form can’t deliver by webhook.'
    : s?.error
      ? s.error
      : h.unlinked > 0
        ? `${h.unlinked} submission${h.unlinked === 1 ? '' : 's'} never became a client (no business name?).`
        : null

  const stripeProblem = (st?.selfCheck && !st.selfCheck.ok) || st?.verify?.outcome === 'unauthorized'

  return (
    <div
      className={cn(
        'flex flex-col gap-1.5 rounded-xl border px-4 py-2.5 text-[12.5px]',
        problem || stripeProblem ? 'border-warning/40 bg-warning/10 text-warning' : 'border-border-soft bg-surface text-muted-foreground',
      )}
    >
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
        <span className="inline-flex items-center gap-1.5 font-medium text-foreground/85">
          <Webhook className="h-3.5 w-3.5" /> Onboarding form
        </span>
        <span className="inline-flex items-center gap-1.5">
          {problem ? <AlertTriangle className="h-3.5 w-3.5 shrink-0" /> : <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-success" />}
          {problem ?? 'Connected'}
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
        <span className="ml-auto inline-flex items-center gap-3">
          <button
            type="button"
            onClick={() => sync.mutate()}
            disabled={sync.isPending}
            className="inline-flex items-center gap-1.5 rounded-md border border-border px-2 py-1 text-[11.5px] font-medium text-foreground/85 transition hover:bg-muted disabled:opacity-50"
          >
            {sync.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
            Check the sheet now
          </button>
          <Link href="/clients/onboarding" className="underline underline-offset-2 hover:text-foreground">
            Onboarding answers
          </Link>
        </span>
      </div>
      <p className={cn('text-[12px]', problem ? 'text-warning/90' : 'text-muted-foreground')}>
        {s
          ? s.ok
            ? `Google Sheet: ${s.sheetRows} submission${s.sheetRows === 1 ? '' : 's'}, ${h.total} in the Hub, checked ${ago(s.checkedAt)}.${
                s.recoveredTotal > 0
                  ? ` ${s.recoveredTotal} ${s.recoveredTotal === 1 ? 'was' : 'were'} recovered from the sheet because the form’s webhook didn’t deliver ${s.recoveredTotal === 1 ? 'it' : 'them'} — set INTAKE_WEBHOOK_URL in the form’s Lovable settings.`
                  : ''
              }`
            : `Google Sheet: couldn’t be read (${ago(s.checkedAt)}).`
          : 'Google Sheet: not checked yet — the Hub reads it every 10 minutes.'}
        {sync.isSuccess && (justImported > 0 ? ` Just added ${justImported} from the sheet.` : ' Nothing new in the sheet.')}
        {sync.isError && ' The check failed — try again.'}
      </p>
      <div className={cn('flex flex-wrap items-center gap-x-4 gap-y-1 border-t pt-1.5 text-[12px]', stripeProblem ? 'border-warning/30 text-warning/90' : 'border-border-soft text-muted-foreground')}>
        <span className="inline-flex items-center gap-1.5 font-medium text-foreground/85">
          <CreditCard className="h-3.5 w-3.5" /> Sign-ups (Stripe)
        </span>
        <span className="inline-flex items-center gap-1.5">
          {st?.selfCheck ? (
            st.selfCheck.ok ? (
              <>
                <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-success" /> Hub ↔ Stripe connected{st.selfCheck.sameAccount ? ' (the signup’s account)' : ''}, checked {ago(st.selfCheck.at)}
                {st.selfCheck.notes?.length ? ` · ${st.selfCheck.notes.join('; ')}` : ''}
              </>
            ) : (
              <>
                <AlertTriangle className="h-3.5 w-3.5 shrink-0" /> {st.selfCheck.problems.join('; ')} (checked {ago(st.selfCheck.at)})
              </>
            )
          ) : (
            'Hub ↔ Stripe: not checked yet'
          )}
        </span>
        <span>Form → Hub: {st?.verify ? `${VERIFY_WORDS[st.verify.outcome]}, ${ago(st.verify.at)}` : 'the form hasn’t asked yet'}</span>
        <span>Stripe → Hub: {st?.webhook ? `last event ${st.webhook.type}${st.webhook.livemode ? '' : ' (test)'}, ${ago(st.webhook.at)}` : 'no events yet'}</span>
        <span>
          Last sign-up:{' '}
          {st?.signup ? (
            <>
              <span className="text-foreground/85">{st.signup.who}</span>
              {st.signup.price ? ` (${st.signup.price})` : ''}, {ago(st.signup.at)}
            </>
          ) : (
            'none yet'
          )}
        </span>
        <button
          type="button"
          onClick={() => stripeCheck.mutate()}
          disabled={stripeCheck.isPending}
          className="ml-auto inline-flex items-center gap-1.5 rounded-md border border-border px-2 py-1 text-[11.5px] font-medium text-foreground/85 transition hover:bg-muted disabled:opacity-50"
        >
          {stripeCheck.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
          Check Stripe now
        </button>
        {stripeCheck.isError && <span>The check failed — try again.</span>}
      </div>
    </div>
  )
}
