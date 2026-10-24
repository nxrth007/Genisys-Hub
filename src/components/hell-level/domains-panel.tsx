'use client'

import { useState } from 'react'
import { useMutation, useQuery, useQueryClient, type UseMutationResult } from '@tanstack/react-query'
import { ArrowRightLeft, CheckCircle2, ExternalLink, Globe, Link2, Pencil, Plus, RefreshCw, Search, Trash2, TriangleAlert, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useAccount } from './bits'
import { Badge, Button, Card, Empty, ErrorNote, Field, Input, Modal, PageHeader, Select, Spinner, Table, Tabs, Toggle, fmtDateTime, hlFetch } from './ui'

type DomainRow = {
  id: string
  name: string
  origin: 'bought' | 'transfer' | 'linked'
  status: 'active' | 'pending' | 'held' | 'transferring' | 'failed'
  transferStatus: string | null
  costCents: number | null
  expiresAt: string | null
  autoRenew: boolean | null
  lastError: string | null
  meta: { imported?: { created: number; skipped: number; failed: number } } | null
  log: { at: string; by: string; what: string }[]
  createdAt: string
}
type Registrar = { connected: boolean; sandbox: boolean; account: string | null; spendLimitCents: number | null; monthlySpendCents: number | null; error: string | null }
type Check = { name: string; available: boolean; priceCents: number | null; renewalCents: number | null; transferCents: number | null; premium: boolean; promo: boolean; inYourAccount: boolean }
type Quote = { name: string; costCents: number; wouldSucceed: boolean; reason: string | null; balanceCents: number | null; shortfallCents: number | null }
type DnsRecord = { id: string; host: string; type: string; content: string; ttl: number | null; prio: number | null; notes: string | null }
type Part<T> = { data: T | null; error: string | null }
type Detail = {
  domain: DomainRow
  records?: Part<DnsRecord[]>
  nameservers?: Part<string[]> & { onPorkbun: boolean | null }
  forwards?: Part<{ address: string; forwardTo: string }[]>
  redirects?: Part<{ id: string; host: string; location: string; permanent: boolean; includePath: boolean; wildcard: boolean }[]>
}

const usd = (cents: number | null | undefined) => (cents === null || cents === undefined ? '—' : `$${(cents / 100).toFixed(2)}`)
const RECORD_TYPES = ['A', 'AAAA', 'CNAME', 'ALIAS', 'MX', 'TXT', 'NS', 'SRV', 'CAA']

function statusBadge(d: DomainRow) {
  switch (d.status) {
    case 'active':
      return <Badge color="green" dot>Active</Badge>
    case 'pending':
      return <Badge color="amber">Starting</Badge>
    case 'held':
      return <Badge color="amber">Review DNS, then release</Badge>
    case 'transferring':
      return <Badge color="blue">Transferring{d.transferStatus ? ` · ${d.transferStatus.toLowerCase()}` : ''}</Badge>
    default:
      return <Badge color="red">Needs attention</Badge>
  }
}

const ORIGIN: Record<DomainRow['origin'], string> = { bought: 'Bought here', transfer: 'Transferred in', linked: 'Linked' }

/** Settings → Domains & URL Redirects: the sub-account's domains, held in Genisys's Porkbun account. */
export function DomainsPanel({ accountId }: { accountId: string }) {
  const registrar = useQuery<Registrar>({ queryKey: ['hl', 'porkbun'], queryFn: () => hlFetch('/api/hl/settings/porkbun') })
  const connected = !!registrar.data?.connected
  const list = useQuery<{ domains: DomainRow[] }>({ queryKey: ['hl', 'domains', accountId], queryFn: () => hlFetch(`/api/hl/accounts/${accountId}/domains`), enabled: connected })
  const [dialog, setDialog] = useState<null | 'buy' | 'transfer' | 'link'>(null)
  const [openId, setOpenId] = useState<string | null>(null)
  const domains = list.data?.domains ?? []
  const opened = (id: string) => {
    setDialog(null)
    setOpenId(id)
  }

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-5 px-6 py-6">
      <PageHeader
        title="Domains & URL Redirects"
        description="The client’s domains, bought here or transferred in from GoHighLevel, with their DNS, email forwarding and redirects. They’re held in Genisys’s Porkbun account."
        actions={
          connected ? (
            <>
              <Button icon={<Link2 className="h-3.5 w-3.5" />} onClick={() => setDialog('link')}>
                Link existing
              </Button>
              <Button icon={<ArrowRightLeft className="h-3.5 w-3.5" />} onClick={() => setDialog('transfer')}>
                Transfer in
              </Button>
              <Button variant="primary" icon={<Plus className="h-3.5 w-3.5" />} onClick={() => setDialog('buy')}>
                Buy domain
              </Button>
            </>
          ) : undefined
        }
      />

      <RegistrarCard status={registrar.data} loading={registrar.isLoading} />

      {connected && (
        <Card>
          {list.isLoading ? (
            <div className="flex justify-center py-14">
              <Spinner />
            </div>
          ) : !domains.length ? (
            <Empty icon={<Globe className="h-5 w-5" />} title="No domains yet">
              Buy one for this client, or transfer the one GoHighLevel holds so the site and email move with it.
            </Empty>
          ) : (
            <Table head={['Domain', 'Status', 'Expires', 'Auto-renew', '']}>
              {domains.map((d) => (
                <tr key={d.id} className={cn('border-b border-border-soft last:border-0 hover:bg-muted/40', openId === d.id && 'bg-muted/40')}>
                  <td className="px-4 py-2.5">
                    <p className="font-medium text-foreground">{d.name}</p>
                    <p className="text-[12px] text-muted-foreground">{ORIGIN[d.origin]}</p>
                  </td>
                  <td className="px-4 py-2.5">{statusBadge(d)}</td>
                  <td className="whitespace-nowrap px-4 py-2.5 text-foreground/85">{d.expiresAt ? new Date(d.expiresAt).toLocaleDateString() : '—'}</td>
                  <td className="px-4 py-2.5 text-muted-foreground">{d.autoRenew === null ? '—' : d.autoRenew ? 'On' : 'Off'}</td>
                  <td className="px-4 py-2.5 text-right">
                    <Button size="sm" onClick={() => setOpenId(openId === d.id ? null : d.id)}>
                      {openId === d.id ? 'Close' : 'Manage'}
                    </Button>
                  </td>
                </tr>
              ))}
            </Table>
          )}
        </Card>
      )}
      <ErrorNote error={list.error} />

      {openId && domains.some((d) => d.id === openId) && <DomainDetail key={openId} accountId={accountId} domainId={openId} onClose={() => setOpenId(null)} />}

      {dialog === 'buy' && <BuyDialog accountId={accountId} sandbox={!!registrar.data?.sandbox} onClose={() => setDialog(null)} onDone={opened} />}
      {dialog === 'transfer' && <TransferDialog accountId={accountId} sandbox={!!registrar.data?.sandbox} onClose={() => setDialog(null)} onDone={opened} />}
      {dialog === 'link' && <LinkDialog accountId={accountId} onClose={() => setDialog(null)} onDone={opened} />}
    </div>
  )
}

function RegistrarCard({ status, loading }: { status: Registrar | undefined; loading: boolean }) {
  if (loading) {
    return (
      <Card className="flex justify-center py-8">
        <Spinner />
      </Card>
    )
  }
  if (status?.connected) {
    return (
      <Card className="flex flex-wrap items-center gap-4 px-5 py-4">
        <span className={cn('grid h-10 w-10 place-items-center rounded-full', status.sandbox ? 'bg-warning/10 text-warning' : 'bg-success/10 text-success')}>
          {status.sandbox ? <TriangleAlert className="h-5 w-5" /> : <CheckCircle2 className="h-5 w-5" />}
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-[14px] font-semibold text-foreground">
            Porkbun connected{status.account ? `: ${status.account}` : ''}
            {status.sandbox && ' (sandbox)'}
          </p>
          <p className="text-[13px] text-muted-foreground">
            {status.sandbox
              ? 'These are sandbox keys: purchases and transfers use fake credit, so nothing real is bought. Swap in the live keys in the Vault when it all looks right.'
              : `Purchases come out of the Porkbun account’s credit${status.spendLimitCents !== null ? `, capped at ${usd(status.spendLimitCents)} a month${status.monthlySpendCents !== null ? ` (${usd(status.monthlySpendCents)} used)` : ''}` : ''}. Every purchase is confirmed here first.`}
          </p>
        </div>
      </Card>
    )
  }
  return (
    <Card className="flex flex-col gap-3 px-5 py-4">
      <div className="flex items-center gap-3">
        <span className="grid h-10 w-10 place-items-center rounded-full bg-primary-soft text-primary">
          <Globe className="h-5 w-5" />
        </span>
        <div>
          <p className="text-[14px] font-semibold text-foreground">Connect Porkbun to buy and transfer domains</p>
          <p className="text-[13px] text-muted-foreground">{status?.error ?? 'Porkbun is the registrar Hell-level uses: cheap, free WHOIS privacy, and an API for buying, transfers and DNS.'}</p>
        </div>
      </div>
      <ol className="ml-[52px] list-decimal space-y-1 pl-4 text-[13px] text-foreground/85">
        <li>
          Make Genisys’s account at{' '}
          <a href="https://porkbun.com" target="_blank" rel="noreferrer" className="text-primary hover:underline">
            porkbun.com
          </a>{' '}
          and verify its email and phone.
        </li>
        <li>
          Under Account → API Access: create a key (a sandbox key first lets you try everything free), set a monthly spend limit, and turn on API access for all domains.
        </li>
        <li>Add some credit under Account → Billing (purchases are paid from it).</li>
        <li>
          Put the two keys in the{' '}
          <a href="/vault" className="text-primary hover:underline">
            Vault
          </a>{' '}
          as “Porkbun API Key” and “Porkbun Secret API Key”, then reload this page.
        </li>
      </ol>
    </Card>
  )
}

// ---------------------------------------------------------------------------
// Buy
// ---------------------------------------------------------------------------

function BuyDialog({ accountId, sandbox, onClose, onDone }: { accountId: string; sandbox: boolean; onClose: () => void; onDone: (id: string) => void }) {
  const qc = useQueryClient()
  const account = useAccount(accountId)
  const suggestion = account.data?.account.profile.businessName || account.data?.account.name || ''
  const [term, setTerm] = useState<string | null>(null)
  const value = term ?? suggestion
  const [picked, setPicked] = useState<Check | null>(null)
  const search = useMutation({ mutationFn: (t: string) => hlFetch<{ results: Check[] }>(`/api/hl/accounts/${accountId}/domains?search=${encodeURIComponent(t)}`) })
  const quote = useQuery<{ quote: Quote }>({
    queryKey: ['hl', 'domain-quote', picked?.name],
    queryFn: () => hlFetch(`/api/hl/accounts/${accountId}/domains?quote=${encodeURIComponent(picked!.name)}`),
    enabled: !!picked,
    retry: false,
  })
  const buy = useMutation({
    mutationFn: (q: Quote) => hlFetch<{ domain: DomainRow }>(`/api/hl/accounts/${accountId}/domains`, { method: 'POST', json: { action: 'buy', name: q.name, costCents: q.costCents } }),
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: ['hl', 'domains', accountId] })
      onDone(r.domain.id)
    },
  })
  const q = quote.data?.quote
  return (
    <Modal open onClose={onClose} title="Buy a domain" description={sandbox ? 'Sandbox: nothing real is bought.' : 'Registered in Genisys’s Porkbun account for this client, with WHOIS privacy.'} width="max-w-2xl">
      {!picked ? (
        <div className="flex flex-col gap-4">
          <form
            className="flex gap-2"
            onSubmit={(e) => {
              e.preventDefault()
              if (value.trim()) search.mutate(value.trim())
            }}
          >
            <Input value={value} onChange={(e) => setTerm(e.target.value)} placeholder="acmeroofing or acmeroofing.com" autoFocus />
            <Button type="submit" variant="primary" loading={search.isPending} icon={<Search className="h-3.5 w-3.5" />}>
              Search
            </Button>
          </form>
          <ErrorNote error={search.error} />
          {search.data && (
            <div className="flex max-h-[50vh] flex-col overflow-y-auto rounded-lg border border-border">
              {!search.data.results.length && <p className="px-4 py-6 text-center text-[13px] text-muted-foreground">Nothing came back for that name.</p>}
              {search.data.results.map((r) => (
                <div key={r.name} className="flex items-center gap-3 border-b border-border-soft px-4 py-2.5 last:border-0">
                  <div className="min-w-0 flex-1">
                    <p className={cn('font-medium', r.available ? 'text-foreground' : 'text-muted-foreground line-through')}>{r.name}</p>
                    {r.available && (
                      <p className="text-[12px] text-muted-foreground">
                        {usd(r.priceCents)} first year{r.promo ? ' (promo)' : ''}, renews at {usd(r.renewalCents)}/yr{r.premium ? ' · premium name' : ''}
                      </p>
                    )}
                  </div>
                  {r.available ? (
                    <Button size="sm" variant="primary" onClick={() => setPicked(r)}>
                      Select
                    </Button>
                  ) : (
                    <span className="text-[12px] text-muted-foreground">{r.inYourAccount ? 'Already ours' : 'Taken'}</span>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          <div className="rounded-lg border border-border p-4">
            <p className="text-[18px] font-semibold text-foreground">{picked.name}</p>
            {quote.isLoading ? (
              <div className="flex items-center gap-2 pt-2 text-[13px] text-muted-foreground">
                <Spinner /> Getting the exact price…
              </div>
            ) : q ? (
              <div className="pt-2 text-[13px] text-foreground/85">
                <p>
                  <span className="text-[20px] font-semibold text-foreground">{usd(q.costCents)}</span> today, then {usd(picked.renewalCents)} a year (auto-renews from Porkbun credit).
                </p>
                {!q.wouldSucceed && (
                  <p className="mt-2 flex items-start gap-2 text-warning">
                    <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" />
                    {q.reason ?? 'Porkbun says this wouldn’t go through right now.'}
                    {q.shortfallCents ? ` Add at least ${usd(q.shortfallCents)} of credit.` : ''}
                  </p>
                )}
              </div>
            ) : null}
          </div>
          <ErrorNote error={quote.error || buy.error} />
          <div className="flex justify-between gap-2">
            <Button onClick={() => setPicked(null)}>Back</Button>
            <Button variant="primary" disabled={!q?.wouldSucceed || !q.costCents} loading={buy.isPending} onClick={() => q && buy.mutate(q)}>
              {q?.costCents ? `Buy for ${usd(q.costCents)}` : 'Buy'}
            </Button>
          </div>
        </div>
      )}
    </Modal>
  )
}

// ---------------------------------------------------------------------------
// Transfer in
// ---------------------------------------------------------------------------

type TransferCheck = { name: string; inPorkbun: boolean; linkedTo: string | null; available: boolean; transferCents: number | null; records: { host: string; type: string; content: string }[]; scanError: string | null }

function TransferDialog({ accountId, sandbox, onClose, onDone }: { accountId: string; sandbox: boolean; onClose: () => void; onDone: (id: string) => void }) {
  const qc = useQueryClient()
  const [name, setName] = useState('')
  const [authCode, setAuthCode] = useState('')
  const check = useMutation({ mutationFn: (n: string) => hlFetch<{ check: TransferCheck }>(`/api/hl/accounts/${accountId}/domains?transferCheck=${encodeURIComponent(n)}`) })
  const quote = useMutation({ mutationFn: () => hlFetch<{ quote: Quote }>(`/api/hl/accounts/${accountId}/domains`, { method: 'POST', json: { action: 'transfer-quote', name: c!.name, authCode } }) })
  const start = useMutation({
    mutationFn: (q: Quote) => hlFetch<{ domain: DomainRow }>(`/api/hl/accounts/${accountId}/domains`, { method: 'POST', json: { action: 'transfer', name: q.name, authCode, costCents: q.costCents } }),
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: ['hl', 'domains', accountId] })
      onDone(r.domain.id)
    },
  })
  const link = useMutation({
    mutationFn: (n: string) => hlFetch<{ domain: DomainRow }>(`/api/hl/accounts/${accountId}/domains`, { method: 'POST', json: { action: 'link', name: n } }),
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: ['hl', 'domains', accountId] })
      onDone(r.domain.id)
    },
  })
  const c = check.data?.check
  const q = quote.data?.quote
  return (
    <Modal open onClose={onClose} title="Transfer a domain in" description={sandbox ? 'Sandbox: nothing real is bought.' : 'For domains bought through GoHighLevel (or anywhere else). The site and email keep working while it moves.'} width="max-w-2xl">
      <div className="flex flex-col gap-4">
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault()
            quote.reset()
            if (name.trim()) check.mutate(name.trim())
          }}
        >
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="acmeroofing.com" autoFocus />
          <Button type="submit" loading={check.isPending} icon={<Search className="h-3.5 w-3.5" />}>
            Check
          </Button>
        </form>
        <ErrorNote error={check.error} />

        {c && c.linkedTo && <p className="text-[13px] text-warning">{c.name} is already in Hell-level, on {c.linkedTo}.</p>}
        {c && !c.linkedTo && c.inPorkbun && (
          <div className="flex items-center justify-between gap-3 rounded-lg border border-border p-3 text-[13px]">
            <span className="text-foreground/85">{c.name} is already in the Porkbun account: no transfer needed.</span>
            <Button size="sm" variant="primary" loading={link.isPending} onClick={() => link.mutate(c.name)}>
              Link it here
            </Button>
          </div>
        )}
        {c && !c.linkedTo && !c.inPorkbun && c.available && <p className="text-[13px] text-warning">Nobody owns {c.name} yet, so there’s nothing to transfer: buy it instead.</p>}

        {c && !c.linkedTo && !c.inPorkbun && !c.available && (
          <>
            <div className="rounded-lg border border-border p-4">
              <p className="text-[14px] font-semibold text-foreground">What gets copied</p>
              <p className="mb-2 text-[12.5px] text-muted-foreground">
                The DNS the domain answers with now, copied to Porkbun before it moves, so nothing goes dark. You review it before the transfer is released.
              </p>
              {c.scanError ? (
                <p className="text-[13px] text-warning">Couldn’t read its DNS just now ({c.scanError}). It’s read again when the transfer starts.</p>
              ) : !c.records.length ? (
                <p className="text-[13px] text-warning">No records found. You can add them by hand before releasing the transfer.</p>
              ) : (
                <div className="max-h-44 overflow-y-auto rounded-md border border-border-soft">
                  {c.records.map((r, i) => (
                    <p key={i} className="truncate border-b border-border-soft px-3 py-1.5 font-mono text-[12px] text-foreground/85 last:border-0">
                      {r.type.padEnd(5)} {r.host || '@'} → {r.content}
                    </p>
                  ))}
                </div>
              )}
            </div>

            <div className="rounded-lg border border-border p-4">
              <p className="text-[14px] font-semibold text-foreground">Get the transfer code from GoHighLevel</p>
              <ol className="mt-1 list-decimal space-y-0.5 pl-5 text-[13px] text-foreground/85">
                <li>Settings → Domains & URL Redirects → find {c.name} → Manage.</li>
                <li>Advanced Settings → Configuration → Transfer to Another Registrar (pick Porkbun, or Other).</li>
                <li>Unlock the domain if it asks, then Get Code. GHL emails the code to the domain owner and the agency owner.</li>
              </ol>
              <p className="mt-2 text-[12px] text-muted-foreground">Domains bought or moved in the last 60 days can’t be transferred yet. A transfer adds a year to the domain{c.transferCents ? ` (about ${usd(c.transferCents)})` : ''}.</p>
              <div className="mt-3 flex gap-2">
                <Input value={authCode} onChange={(e) => setAuthCode(e.target.value)} placeholder="Transfer (EPP) code" autoComplete="off" spellCheck={false} />
                <Button loading={quote.isPending} disabled={!authCode.trim()} onClick={() => quote.mutate()}>
                  Get price
                </Button>
              </div>
            </div>
            <ErrorNote error={quote.error || start.error} />
            {q && (
              <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border p-4">
                <div className="text-[13px] text-foreground/85">
                  <p>
                    <span className="text-[20px] font-semibold text-foreground">{usd(q.costCents)}</span> to transfer {q.name}, including a year’s renewal.
                  </p>
                  {!q.wouldSucceed && <p className="mt-1 text-warning">{q.reason ?? 'Porkbun says this wouldn’t go through right now.'}{q.shortfallCents ? ` Add at least ${usd(q.shortfallCents)} of credit.` : ''}</p>}
                </div>
                <Button variant="primary" disabled={!q.wouldSucceed || !q.costCents} loading={start.isPending} onClick={() => start.mutate(q)}>
                  Pay {usd(q.costCents)} and start
                </Button>
              </div>
            )}
          </>
        )}
      </div>
    </Modal>
  )
}

// ---------------------------------------------------------------------------
// Link
// ---------------------------------------------------------------------------

function LinkDialog({ accountId, onClose, onDone }: { accountId: string; onClose: () => void; onDone: (id: string) => void }) {
  const qc = useQueryClient()
  const unlinked = useQuery<{ domains: { name: string; expiresAt: string | null }[] }>({ queryKey: ['hl', 'domains-unlinked'], queryFn: () => hlFetch(`/api/hl/accounts/${accountId}/domains?unlinked=1`) })
  const link = useMutation({
    mutationFn: (name: string) => hlFetch<{ domain: DomainRow }>(`/api/hl/accounts/${accountId}/domains`, { method: 'POST', json: { action: 'link', name } }),
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: ['hl', 'domains', accountId] })
      qc.invalidateQueries({ queryKey: ['hl', 'domains-unlinked'] })
      onDone(r.domain.id)
    },
  })
  const rows = unlinked.data?.domains ?? []
  return (
    <Modal open onClose={onClose} title="Link a domain" description="Domains already in the Porkbun account that no sub-account has yet (bought on porkbun.com, or unlinked).">
      {unlinked.isLoading ? (
        <div className="flex justify-center py-8">
          <Spinner />
        </div>
      ) : !rows.length ? (
        <p className="py-4 text-[13px] text-muted-foreground">Every domain in the Porkbun account is already linked.</p>
      ) : (
        <div className="flex max-h-[50vh] flex-col overflow-y-auto rounded-lg border border-border">
          {rows.map((d) => (
            <div key={d.name} className="flex items-center justify-between gap-3 border-b border-border-soft px-4 py-2.5 last:border-0">
              <span>
                <span className="block font-medium text-foreground">{d.name}</span>
                {d.expiresAt && <span className="block text-[12px] text-muted-foreground">Expires {new Date(d.expiresAt).toLocaleDateString()}</span>}
              </span>
              <Button size="sm" loading={link.isPending && link.variables === d.name} onClick={() => link.mutate(d.name)}>
                Link here
              </Button>
            </div>
          ))}
        </div>
      )}
      <ErrorNote error={unlinked.error || link.error} />
    </Modal>
  )
}

// ---------------------------------------------------------------------------
// One domain
// ---------------------------------------------------------------------------

function DomainDetail({ accountId, domainId, onClose }: { accountId: string; domainId: string; onClose: () => void }) {
  const qc = useQueryClient()
  const url = `/api/hl/accounts/${accountId}/domains/${domainId}`
  const detail = useQuery<Detail>({ queryKey: ['hl', 'domain', domainId], queryFn: () => hlFetch(url) })
  const [tab, setTab] = useState<'dns' | 'email' | 'redirects' | 'history'>('dns')
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['hl', 'domain', domainId] })
    qc.invalidateQueries({ queryKey: ['hl', 'domains', accountId] })
  }
  const act = useMutation({
    mutationFn: (body: Record<string, unknown>) => hlFetch<{ domain?: DomainRow; needsConfirm?: boolean; message?: string }>(url, { method: 'POST', json: body }),
    onSuccess: refresh,
  })
  const unlink = useMutation({
    mutationFn: () => hlFetch(url, { method: 'DELETE' }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['hl', 'domains', accountId] })
      onClose()
    },
  })
  const d = detail.data?.domain
  if (detail.isLoading || !d) {
    return (
      <Card className="flex justify-center py-10">
        {detail.error ? <ErrorNote error={detail.error} /> : <Spinner />}
      </Card>
    )
  }
  return (
    <Card>
      <div className="flex flex-wrap items-center gap-3 border-b border-border px-5 py-4">
        <a href={`https://${d.name}`} target="_blank" rel="noreferrer" className="flex items-center gap-1.5 text-[18px] font-semibold text-foreground hover:underline">
          {d.name} <ExternalLink className="h-3.5 w-3.5 text-muted-foreground" />
        </a>
        {statusBadge(d)}
        <span className="ml-auto flex gap-2">
          <Button size="sm" variant="ghost" icon={<RefreshCw className="h-3.5 w-3.5" />} loading={act.isPending && act.variables?.action === 'refresh'} onClick={() => act.mutate({ action: 'refresh' })}>
            {d.status === 'failed' && d.origin === 'bought' ? 'Check again' : 'Refresh'}
          </Button>
          <Button size="sm" variant="ghost" icon={<X className="h-3.5 w-3.5" />} onClick={onClose}>
            Close
          </Button>
        </span>
      </div>

      {d.lastError && (
        <p className="flex items-start gap-2 border-b border-border bg-warning/5 px-5 py-3 text-[13px] text-warning">
          <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" /> {d.lastError}
        </p>
      )}

      {d.status === 'held' && <HeldTransfer d={d} recordCount={detail.data?.records?.data?.length ?? 0} act={act} />}
      {d.status === 'transferring' && <MovingTransfer d={d} act={act} />}

      {(d.status === 'active' || d.status === 'held' || d.status === 'transferring') && (
        <div className="px-5 pt-3">
          <Tabs
            value={tab}
            onChange={setTab}
            tabs={[
              { key: 'dns', label: 'DNS records' },
              ...(d.status === 'active'
                ? [
                    { key: 'email' as const, label: 'Email forwarding' },
                    { key: 'redirects' as const, label: 'URL redirects' },
                  ]
                : []),
              { key: 'history', label: 'History' },
            ]}
          />
        </div>
      )}
      <div className="px-5 py-4">
        {tab === 'dns' && (d.status === 'active' || d.status === 'held' || d.status === 'transferring') && <DnsTab accountId={accountId} d={d} detail={detail.data!} act={act} />}
        {tab === 'email' && d.status === 'active' && <EmailTab d={d} detail={detail.data!} act={act} />}
        {tab === 'redirects' && d.status === 'active' && <RedirectsTab d={d} detail={detail.data!} act={act} />}
        {(tab === 'history' || !['active', 'held', 'transferring'].includes(d.status)) && <History d={d} />}
        <ErrorNote error={act.error || unlink.error} />
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border px-5 py-3 text-[12px] text-muted-foreground">
        <span>
          {ORIGIN[d.origin]} {fmtDateTime(d.createdAt)}
          {d.costCents ? ` · ${usd(d.costCents)}` : ''}
        </span>
        {!['held', 'transferring', 'pending'].includes(d.status) && (
          <button
            type="button"
            onClick={() => {
              if (window.confirm(`Unlink ${d.name} from this sub-account? It stays in the Porkbun account (nothing is cancelled), and you can link it again.`)) unlink.mutate()
            }}
            className="flex items-center gap-1.5 font-medium text-destructive hover:underline"
          >
            <Trash2 className="h-3.5 w-3.5" /> Unlink
          </button>
        )}
      </div>
    </Card>
  )
}

type Act = UseMutationResult<{ domain?: DomainRow; needsConfirm?: boolean; message?: string }, Error, Record<string, unknown>>

function HeldTransfer({ d, recordCount, act }: { d: DomainRow; recordCount: number; act: Act }) {
  const imported = d.meta?.imported
  return (
    <div className="flex flex-col gap-3 border-b border-border px-5 py-4">
      <p className="text-[14px] font-semibold text-foreground">Paid and parked: check the DNS, then release it</p>
      <p className="text-[13px] text-muted-foreground">
        {imported ? `${imported.created + imported.skipped} record(s) were copied from the domain’s current DNS. ` : ''}
        Compare them below with GoHighLevel’s DNS page for {d.name} (Settings → Domains & URL Redirects → Manage → DNS Records) and add anything missing, like email (MX) or verification (TXT) records. Nothing moves until you release it.
      </p>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" loading={act.isPending && act.variables?.action === 'copy-dns'} icon={<RefreshCw className="h-3.5 w-3.5" />} onClick={() => act.mutate({ action: 'copy-dns' })}>
          Copy the DNS again
        </Button>
        <Button
          size="sm"
          variant="primary"
          disabled={!recordCount}
          loading={act.isPending && act.variables?.action === 'release'}
          onClick={() => {
            if (window.confirm(`Release the transfer of ${d.name}? GoHighLevel then has up to 5 days to let it go, and the DNS here takes over when it arrives.`)) act.mutate({ action: 'release' })
          }}
        >
          Records look right: release the transfer
        </Button>
      </div>
    </div>
  )
}

function MovingTransfer({ d, act }: { d: DomainRow; act: Act }) {
  const [code, setCode] = useState('')
  return (
    <div className="flex flex-col gap-3 border-b border-border px-5 py-4">
      <p className="text-[14px] font-semibold text-foreground">On its way</p>
      <p className="text-[13px] text-muted-foreground">
        Waiting on the registry and GoHighLevel (up to 5 days, often 1–2). Hell-level checks every 30 minutes and switches the domain to the DNS here when it lands. Status: {d.transferStatus ?? 'started'}.
      </p>
      {d.transferStatus === 'PENDINGAUTH' && (
        <div className="flex max-w-lg gap-2">
          <Input value={code} onChange={(e) => setCode(e.target.value)} placeholder="New transfer code from GoHighLevel" autoComplete="off" spellCheck={false} />
          <Button size="sm" disabled={!code.trim()} loading={act.isPending && act.variables?.action === 'auth-code'} onClick={() => act.mutate({ action: 'auth-code', authCode: code.trim() })}>
            Send code
          </Button>
        </div>
      )}
    </div>
  )
}

function DnsTab({ accountId, d, detail, act }: { accountId: string; d: DomainRow; detail: Detail; act: Act }) {
  const account = useAccount(accountId)
  const [editing, setEditing] = useState<DnsRecord | 'new' | null>(null)
  const [lovable, setLovable] = useState(false)
  const records = detail.records
  const ns = detail.nameservers
  const editable = d.status === 'active' || d.status === 'held'
  return (
    <div className="flex flex-col gap-3">
      {ns?.data && ns.onPorkbun === false && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-warning/40 bg-warning/5 px-4 py-3 text-[13px]">
          <span className="text-foreground/85">
            Its nameservers are {ns.data.join(', ')}, so the records here aren’t in use: changes here won’t show until it uses Porkbun’s.
          </span>
          <Button
            size="sm"
            loading={act.isPending && act.variables?.action === 'use-porkbun-ns'}
            onClick={() => {
              if (window.confirm(`Switch ${d.name} to Porkbun’s nameservers? The records listed here take over (check the site and email records are here first).`)) act.mutate({ action: 'use-porkbun-ns' })
            }}
          >
            Use Porkbun DNS
          </Button>
        </div>
      )}
      {editable && (
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="primary" icon={<Globe className="h-3.5 w-3.5" />} onClick={() => setLovable(true)}>
            Connect the Lovable site
          </Button>
          <Button size="sm" icon={<Plus className="h-3.5 w-3.5" />} onClick={() => setEditing('new')}>
            Add record
          </Button>
        </div>
      )}
      {records?.error ? (
        <p className="text-[13px] text-warning">Couldn’t read the DNS: {records.error}</p>
      ) : !records?.data?.length ? (
        <p className="py-4 text-[13px] text-muted-foreground">No records yet.</p>
      ) : (
        <div className="overflow-hidden rounded-lg border border-border">
          <Table head={['Type', 'Name', 'Value', 'TTL', '']}>
            {records.data.map((r) => (
              <tr key={r.id} className="border-b border-border-soft last:border-0">
                <td className="px-4 py-2 font-mono text-[12px] text-foreground">{r.type}</td>
                <td className="px-4 py-2 font-mono text-[12px] text-foreground/85">{r.host || '@'}</td>
                <td className="max-w-[340px] px-4 py-2 font-mono text-[12px] text-foreground/85">
                  <span className="line-clamp-2 break-all">
                    {r.prio !== null && (r.type === 'MX' || r.type === 'SRV') ? `${r.prio} ` : ''}
                    {r.content}
                  </span>
                </td>
                <td className="px-4 py-2 text-[12px] text-muted-foreground">{r.ttl ?? '—'}</td>
                <td className="whitespace-nowrap px-4 py-2 text-right">
                  {editable && (
                    <>
                      <button type="button" className="mr-3 text-muted-foreground hover:text-foreground" title="Edit" onClick={() => setEditing(r)}>
                        <Pencil className="h-3.5 w-3.5" />
                      </button>
                      <button
                        type="button"
                        className="text-muted-foreground hover:text-destructive"
                        title="Delete"
                        onClick={() => {
                          if (window.confirm(`Delete ${r.type} ${r.host || '@'} → ${r.content}?`)) act.mutate({ action: 'delete-record', recordId: r.id })
                        }}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </>
                  )}
                </td>
              </tr>
            ))}
          </Table>
        </div>
      )}
      {editing && <RecordModal domain={d.name} record={editing === 'new' ? null : editing} act={act} onClose={() => setEditing(null)} />}
      {lovable && <LovableModal domain={d.name} siteUrl={account.data?.client?.siteUrl ?? null} act={act} onClose={() => setLovable(false)} />}
    </div>
  )
}

function RecordModal({ domain, record, act, onClose }: { domain: string; record: DnsRecord | null; act: Act; onClose: () => void }) {
  const [f, setF] = useState({ type: record?.type ?? 'A', host: record?.host ?? '', content: record?.content ?? '', ttl: String(record?.ttl ?? 600), prio: record?.prio === null || record?.prio === undefined ? '' : String(record.prio) })
  const needsPrio = f.type === 'MX' || f.type === 'SRV'
  return (
    <Modal
      open
      onClose={onClose}
      title={record ? 'Edit record' : 'Add a DNS record'}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            loading={act.isPending}
            disabled={!f.content.trim()}
            onClick={() =>
              act.mutate(
                { action: record ? 'edit-record' : 'add-record', recordId: record?.id, type: f.type, host: f.host, content: f.content, ttl: Number(f.ttl) || undefined, prio: needsPrio ? f.prio : null },
                { onSuccess: onClose },
              )
            }
          >
            Save
          </Button>
        </>
      }
    >
      <div className="grid gap-3 sm:grid-cols-[110px_1fr]">
        <Field label="Type">
          <Select value={f.type} onChange={(e) => setF({ ...f, type: e.target.value })}>
            {RECORD_TYPES.map((t) => (
              <option key={t}>{t}</option>
            ))}
          </Select>
        </Field>
        <Field label="Name" hint={`Blank for ${domain} itself`}>
          <div className="flex items-center gap-1.5">
            <Input value={f.host} onChange={(e) => setF({ ...f, host: e.target.value })} placeholder="www" />
            <span className="whitespace-nowrap text-[12px] text-muted-foreground">.{domain}</span>
          </div>
        </Field>
        <Field label="Value" className="sm:col-span-2">
          <Input value={f.content} onChange={(e) => setF({ ...f, content: e.target.value })} placeholder={f.type === 'A' ? '185.158.133.1' : f.type === 'CNAME' ? 'target.example.com' : f.type === 'MX' ? 'mail.example.com' : ''} />
        </Field>
        <Field label="TTL (seconds)">
          <Input value={f.ttl} onChange={(e) => setF({ ...f, ttl: e.target.value })} inputMode="numeric" />
        </Field>
        {needsPrio && (
          <Field label="Priority">
            <Input value={f.prio} onChange={(e) => setF({ ...f, prio: e.target.value })} inputMode="numeric" placeholder="10" />
          </Field>
        )}
      </div>
      <ErrorNote error={act.error} />
    </Modal>
  )
}

function LovableModal({ domain, siteUrl, act, onClose }: { domain: string; siteUrl: string | null; act: Act; onClose: () => void }) {
  const [rootTxt, setRootTxt] = useState('')
  const [wwwTxt, setWwwTxt] = useState('')
  return (
    <Modal
      open
      onClose={onClose}
      title="Connect the Lovable site"
      description="Points the domain at the client’s Lovable site: the A records for the domain and www, and Lovable’s verification TXT records. Other A, AAAA and CNAME records at the domain and www are replaced; email records aren’t touched."
      width="max-w-xl"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={act.isPending} disabled={!rootTxt.trim()} onClick={() => act.mutate({ action: 'connect-lovable', rootTxt, wwwTxt }, { onSuccess: onClose })}>
            Set the records
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <ol className="list-decimal space-y-0.5 pl-5 text-[13px] text-foreground/85">
          <li>In Lovable, open the client’s project{siteUrl ? ` (${siteUrl.replace(/^https?:\/\//, '')})` : ''} → Settings → Domains → Connect domain → {domain}.</li>
          <li>Choose the manual setup and copy the TXT value it shows (it starts with lovable_verify=).</li>
          <li>Paste it below. If Lovable lists www as its own domain with a second value, paste that too.</li>
        </ol>
        <Field label={`_lovable.${domain}`}>
          <Input value={rootTxt} onChange={(e) => setRootTxt(e.target.value)} placeholder="lovable_verify=…" spellCheck={false} />
        </Field>
        <Field label={`_lovable.www.${domain} (optional)`}>
          <Input value={wwwTxt} onChange={(e) => setWwwTxt(e.target.value)} placeholder="lovable_verify=…" spellCheck={false} />
        </Field>
        <p className="text-[12px] text-muted-foreground">Then press Verify in Lovable. DNS can take a few minutes to a few hours to update.</p>
        <ErrorNote error={act.error} />
      </div>
    </Modal>
  )
}

function EmailTab({ d, detail, act }: { d: DomainRow; detail: Detail; act: Act }) {
  const [address, setAddress] = useState('')
  const [forwardTo, setForwardTo] = useState('')
  const forwards = detail.forwards
  const add = (confirm: boolean) =>
    act.mutate(
      { action: 'add-forward', address, forwardTo, confirm },
      {
        onSuccess: (r) => {
          if (r.needsConfirm) {
            if (window.confirm(`${r.message ?? 'This changes the domain’s mail records.'}\n\nForwarding replaces the domain’s current email (MX) records, so mail hosted elsewhere for ${d.name} would stop arriving there. Go ahead?`)) add(true)
            return
          }
          setAddress('')
          setForwardTo('')
        },
      },
    )
  return (
    <div className="flex flex-col gap-3">
      <p className="text-[13px] text-muted-foreground">Free with the domain: mail to an address here lands in someone’s existing inbox (like info@{d.name} → the owner’s Gmail). Up to 20 addresses.</p>
      <div className="flex flex-wrap items-end gap-2">
        <Field label="Address">
          <div className="flex items-center gap-1.5">
            <Input value={address} onChange={(e) => setAddress(e.target.value)} placeholder="info" className="w-36" />
            <span className="text-[12px] text-muted-foreground">@{d.name}</span>
          </div>
        </Field>
        <Field label="Forward to">
          <Input value={forwardTo} onChange={(e) => setForwardTo(e.target.value)} placeholder="owner@gmail.com" className="w-60" />
        </Field>
        <Button variant="primary" loading={act.isPending && act.variables?.action === 'add-forward'} disabled={!address.trim() || !forwardTo.trim()} onClick={() => add(false)}>
          Add
        </Button>
      </div>
      {forwards?.error ? (
        <p className="text-[13px] text-warning">Couldn’t read the forwards: {forwards.error}</p>
      ) : !forwards?.data?.length ? (
        <p className="py-2 text-[13px] text-muted-foreground">No forwarding yet.</p>
      ) : (
        <div className="overflow-hidden rounded-lg border border-border">
          <Table head={['Address', 'Goes to', '']}>
            {forwards.data.map((f) => (
              <tr key={f.address} className="border-b border-border-soft last:border-0">
                <td className="px-4 py-2 text-foreground">{f.address.includes('@') ? f.address : `${f.address}@${d.name}`}</td>
                <td className="px-4 py-2 text-foreground/85">{f.forwardTo}</td>
                <td className="px-4 py-2 text-right">
                  <button
                    type="button"
                    className="text-muted-foreground hover:text-destructive"
                    title="Stop forwarding"
                    onClick={() => {
                      if (window.confirm(`Stop forwarding ${f.address}?`)) act.mutate({ action: 'delete-forward', address: f.address })
                    }}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </td>
              </tr>
            ))}
          </Table>
        </div>
      )}
    </div>
  )
}

function RedirectsTab({ d, detail, act }: { d: DomainRow; detail: Detail; act: Act }) {
  const [f, setF] = useState({ host: '', location: '', permanent: true, includePath: true, wildcard: false })
  const redirects = detail.redirects
  return (
    <div className="flex flex-col gap-3">
      <p className="text-[13px] text-muted-foreground">Send visitors of this domain (or a subdomain) somewhere else, like an old domain to the new site.</p>
      <div className="flex flex-wrap items-end gap-2">
        <Field label="From">
          <div className="flex items-center gap-1.5">
            <Input value={f.host} onChange={(e) => setF({ ...f, host: e.target.value })} placeholder="(blank) or www" className="w-32" />
            <span className="text-[12px] text-muted-foreground">.{d.name}</span>
          </div>
        </Field>
        <Field label="To">
          <Input value={f.location} onChange={(e) => setF({ ...f, location: e.target.value })} placeholder="https://newsite.com" className="w-64" />
        </Field>
        <Button
          variant="primary"
          loading={act.isPending && act.variables?.action === 'add-redirect'}
          disabled={!f.location.trim()}
          onClick={() => act.mutate({ action: 'add-redirect', ...f }, { onSuccess: () => setF({ host: '', location: '', permanent: true, includePath: true, wildcard: false }) })}
        >
          Add
        </Button>
      </div>
      <div className="flex flex-wrap gap-5 text-[13px] text-foreground/85">
        <label className="flex items-center gap-2">
          <Toggle checked={f.permanent} onChange={(v) => setF({ ...f, permanent: v })} label="Permanent" /> Permanent (301)
        </label>
        <label className="flex items-center gap-2">
          <Toggle checked={f.includePath} onChange={(v) => setF({ ...f, includePath: v })} label="Keep the path" /> Keep the path
        </label>
        <label className="flex items-center gap-2">
          <Toggle checked={f.wildcard} onChange={(v) => setF({ ...f, wildcard: v })} label="All subdomains" /> All subdomains
        </label>
      </div>
      {redirects?.error ? (
        <p className="text-[13px] text-warning">Couldn’t read the redirects: {redirects.error}</p>
      ) : !redirects?.data?.length ? (
        <p className="py-2 text-[13px] text-muted-foreground">No redirects.</p>
      ) : (
        <div className="overflow-hidden rounded-lg border border-border">
          <Table head={['From', 'To', 'Type', '']}>
            {redirects.data.map((r) => (
              <tr key={r.id} className="border-b border-border-soft last:border-0">
                <td className="px-4 py-2 text-foreground">{r.host ? `${r.host}.${d.name}` : d.name}</td>
                <td className="max-w-[300px] truncate px-4 py-2 text-foreground/85">{r.location}</td>
                <td className="px-4 py-2 text-[12px] text-muted-foreground">
                  {r.permanent ? '301' : '302'}
                  {r.includePath ? ' · keeps path' : ''}
                  {r.wildcard ? ' · all subdomains' : ''}
                </td>
                <td className="px-4 py-2 text-right">
                  <button
                    type="button"
                    className="text-muted-foreground hover:text-destructive"
                    title="Remove"
                    onClick={() => {
                      if (window.confirm(`Remove the redirect to ${r.location}?`)) act.mutate({ action: 'delete-redirect', redirectId: r.id })
                    }}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </td>
              </tr>
            ))}
          </Table>
        </div>
      )}
    </div>
  )
}

function History({ d }: { d: DomainRow }) {
  const entries = [...(d.log ?? [])].reverse()
  if (!entries.length) return <p className="py-2 text-[13px] text-muted-foreground">Nothing yet.</p>
  return (
    <ol className="flex flex-col gap-2">
      {entries.map((e, i) => (
        <li key={i} className="flex gap-3 text-[13px]">
          <span className="w-36 shrink-0 text-muted-foreground">{fmtDateTime(e.at)}</span>
          <span className="text-foreground/90">
            {e.what}
            <span className="text-muted-foreground"> · {e.by}</span>
          </span>
        </li>
      ))}
    </ol>
  )
}
