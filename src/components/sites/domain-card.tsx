'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { Globe, Loader2, RefreshCw, Search } from 'lucide-react'
import type { DomainChoice } from '@/lib/hl/domain-plan'
import type { SiteDetail } from '@/lib/sites'
import { ConfirmDialog, postAction } from './confirm-dialog'

const usd = (cents: number) => `$${(cents / 100).toFixed(2)}`

const primary =
  'inline-flex items-center gap-1.5 rounded-lg border border-foreground/20 bg-foreground px-3 py-1.5 text-[12.5px] font-medium text-background transition hover:opacity-90 disabled:opacity-50'
const secondary = 'inline-flex items-center gap-1.5 rounded-lg border border-border bg-card px-3 py-1.5 text-[12.5px] font-medium text-foreground transition hover:bg-muted disabled:opacity-50'

/**
 * Their website's domain, Forge's Office question answered from the folder: three available names
 * from Porkbun with the all-in first-year price, bought into their Hell-level → Domains on a press
 * (after the price is confirmed). Any other name: their Hell-level Domains page searches it.
 */
export function DomainCard({ d, canAct }: { d: SiteDetail; canAct: boolean }) {
  const router = useRouter()
  const a = d.actions.domain
  const q = d.domainQuestion
  const [busy, setBusy] = useState<'find' | 'none' | null>(null)
  const [msg, setMsg] = useState<string | null>(null)
  const [pick, setPick] = useState<DomainChoice | null>(null)
  const ready = d.siteDomain && 'name' in d.siteDomain ? d.siteDomain : null
  const moving = d.siteDomain && 'waiting' in d.siteDomain ? d.siteDomain.waiting : null
  const domainsPage = d.account ? `/hell-level/${d.account.id}/settings?tab=domains` : null
  const business = d.account?.businessName || d.client.name

  async function run(kind: 'find' | 'none') {
    setBusy(kind)
    setMsg(null)
    try {
      const r = await postAction(`/api/clients/${d.client.id}/hl-domain`, { action: kind === 'find' ? 'suggest' : 'none' })
      if (!r.ok) setMsg(r.reason)
      else if (kind === 'find') setMsg(typeof r.data.detail === 'string' && r.data.detail ? r.data.detail : null)
      else setMsg('Dropped. Find domains again, or search any name on their Domains page.')
      router.refresh()
    } finally {
      setBusy(null)
    }
  }

  async function buy(): Promise<string | null> {
    if (!pick) return null
    const r = await postAction(`/api/clients/${d.client.id}/hl-domain`, { action: 'buy', name: pick.name })
    router.refresh()
    if (!r.ok) return r.reason
    setMsg(typeof r.data.detail === 'string' && r.data.detail ? r.data.detail : `Bought ${pick.name}.`)
    return null
  }

  const searchLink = domainsPage && (
    <Link href={domainsPage} className="inline-flex items-center gap-1.5 text-[12.5px] text-foreground hover:underline">
      <Search className="h-3.5 w-3.5 text-muted-foreground" /> Search any name
    </Link>
  )

  return (
    <section className="flex flex-col gap-3 rounded-xl border border-border bg-card p-4">
      <h2 className="text-[14px] font-semibold text-foreground">Domain for the site</h2>
      {ready ? (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-[18px] font-semibold tracking-tight text-foreground">{ready.name}</span>
            <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] font-semibold text-muted-foreground">{ready.managed ? 'In Hell-level' : 'DNS managed elsewhere'}</span>
          </div>
          <p className="text-[12.5px] text-muted-foreground">
            {d.build?.status === 'connected'
              ? 'Their website is live on it.'
              : d.build?.status === 'connecting'
                ? 'Being connected to their website (Website build, below).'
                : d.build?.status === 'published'
                  ? 'Their website is published: connect it from Website build, below.'
                  : 'Forge puts it in the site it builds and connects it once the site is published.'}
          </p>
          {domainsPage && (
            <Link href={domainsPage} className="w-fit text-[12.5px] text-foreground hover:underline">
              Their domains
            </Link>
          )}
        </>
      ) : moving ? (
        <p className="text-[12.5px] text-foreground/90">{moving} is still moving into their Hell-level Domains. Forge uses it once it’s in.</p>
      ) : a.kind === 'choose' ? (
        <>
          <p className="text-[12.5px] text-foreground/90">
            Forge’s picks from Porkbun for {business}: available now, with Porkbun’s all-in first-year price. Pick one to buy it into their Hell-level → Domains.
          </p>
          <ul className="flex flex-col divide-y divide-border rounded-lg border border-border">
            {a.choices.map((c) => (
              <li key={c.name} className="flex flex-wrap items-center gap-3 px-3 py-2.5">
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-mono text-[13.5px] text-foreground">{c.name}</span>
                  <span className="text-[11.5px] text-muted-foreground">
                    {usd(c.costCents)} first year{c.renewalCents ? ` · renews ${usd(c.renewalCents)}/yr` : ''}
                  </span>
                </span>
                {canAct && (
                  <button type="button" onClick={() => setPick(c)} disabled={!!busy} className={primary}>
                    Buy
                  </button>
                )}
              </li>
            ))}
          </ul>
          {q?.detail && <p className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-[12.5px] leading-snug">{q.detail}</p>}
          {canAct && (
            <div className="flex flex-wrap items-center gap-2">
              <button type="button" onClick={() => run('find')} disabled={!!busy} className={secondary}>
                {busy === 'find' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />} Different names
              </button>
              <button type="button" onClick={() => run('none')} disabled={!!busy} className={secondary}>
                {busy === 'none' && <Loader2 className="h-3.5 w-3.5 animate-spin" />} None of these
              </button>
              {searchLink}
            </div>
          )}
        </>
      ) : a.kind === 'find' ? (
        <>
          <p className="text-[12.5px] text-foreground/90">
            {q?.status === 'failed' && q.detail
              ? q.detail
              : q?.status === 'declined'
                ? 'None of Forge’s last picks was bought.'
                : q?.status === 'awaiting_approval'
                  ? (q.detail ?? 'Porkbun had no name to suggest.')
                  : 'No domain yet.'}{' '}
            Forge checks Porkbun for three available names from {business} and shows each price (checking is free). Nothing is bought until you pick one.
          </p>
          {canAct && (
            <div className="flex flex-wrap items-center gap-3">
              <button type="button" onClick={() => run('find')} disabled={!!busy} className={primary}>
                {busy === 'find' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Globe className="h-3.5 w-3.5" />} Find domains
              </button>
              {searchLink}
            </div>
          )}
        </>
      ) : (
        <p className="text-[12.5px] text-foreground/90">{a.reason}</p>
      )}
      {msg && <p className="text-[12px] text-muted-foreground">{msg}</p>}
      <ConfirmDialog
        open={!!pick}
        title={`Buy ${pick?.name ?? 'this domain'}?`}
        confirmLabel={pick ? `Buy it for ${usd(pick.costCents)}` : 'Buy it'}
        onConfirm={buy}
        onClose={() => setPick(null)}
      >
        {pick && (
          <>
            <p>
              {usd(pick.costCents)} for the first year on Porkbun, paid from Genisys’s Porkbun account credit{pick.renewalCents ? `; it renews at ${usd(pick.renewalCents)} a year` : ''}.
            </p>
            <p>It goes into {d.client.name}’s Hell-level → Domains. Forge puts it in their website when it builds it, and connects it once the site is published.</p>
            <p className="text-muted-foreground">Porkbun’s price is checked again as it buys: that price or nothing, and never twice.</p>
          </>
        )}
      </ConfirmDialog>
    </section>
  )
}
