'use client'

import { useState } from 'react'
import { useMutation, useQuery, useQueryClient, type UseMutationResult } from '@tanstack/react-query'
import { ArrowLeft, ArrowRightLeft, Check, CheckCircle2, Copy, ExternalLink, Globe, Link2, Pencil, Plus, RefreshCw, Search, ShoppingCart, Trash2, TriangleAlert, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { fqdnOf, metaOf, type DomainMeta, type HostConnection, type SiteRecord } from '@/lib/hl/domain-shared'
import { useAccount } from './bits'
import { Badge, Button, Card, ErrorNote, Field, Input, Modal, Select, Spinner, Table, Tabs, Toggle, copyText, fmtDateTime, hlFetch } from './ui'

type DomainRow = {
  id: string
  name: string
  origin: 'bought' | 'transfer' | 'linked' | 'external'
  status: 'active' | 'pending' | 'held' | 'transferring' | 'failed'
  transferStatus: string | null
  costCents: number | null
  expiresAt: string | null
  autoRenew: boolean | null
  lastError: string | null
  meta: DomainMeta | null
  log: { at: string; by: string; what: string }[]
  createdAt: string
}
type Registrar = { connected: boolean; sandbox: boolean; account: string | null; spendLimitCents: number | null; monthlySpendCents: number | null; error: string | null }
type Check = { name: string; available: boolean; priceCents: number | null; renewalCents: number | null; transferCents: number | null; premium: boolean; promo: boolean; inYourAccount: boolean }
type Quote = { name: string; costCents: number; wouldSucceed: boolean; reason: string | null; balanceCents: number | null; shortfallCents: number | null }
type DnsRecord = { id: string; host: string; type: string; content: string; ttl: number | null; prio: number | null; notes: string | null }
type Part<T> = { data: T | null; error: string | null }
type HostView = HostConnection & { records: SiteRecord[] }
type Detail = {
  domain: DomainRow
  records?: Part<DnsRecord[]>
  nameservers?: Part<string[]> & { onPorkbun: boolean | null }
  forwards?: Part<{ address: string; forwardTo: string }[]>
  hosts?: HostView[]
}
type Redirect = { id: string; host: string; location: string; permanent: boolean; includePath: boolean; wildcard: boolean; domainId: string; domain: string }
type Act = UseMutationResult<{ domain?: DomainRow; needsConfirm?: boolean; message?: string }, Error, Record<string, unknown>>

const usd = (cents: number | null | undefined) => (cents === null || cents === undefined ? '—' : `$${(cents / 100).toFixed(2)}`)
const day = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '—')
const RECORD_TYPES = ['A', 'AAAA', 'CNAME', 'ALIAS', 'MX', 'TXT', 'NS', 'SRV', 'CAA']

function statusBadge(d: DomainRow) {
  if (d.origin === 'external') return <Badge color="gray">External</Badge>
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

/** GHL's "Connected Products" chips. */
function Products({ d }: { d: DomainRow }) {
  const meta = metaOf(d.meta)
  const site = (meta.hosts ?? []).length
  const email = (meta.emailForwards ?? 0) > 0
  if (!site && !email) return <span className="text-[12.5px] text-muted-foreground">—</span>
  return (
    <span className="flex flex-wrap gap-1.5">
      {site > 0 && <Badge color="blue">Website</Badge>}
      {email && <Badge color="purple">Email</Badge>}
    </span>
  )
}

/** Settings → Domains & URL Redirects, laid out like GHL's: Domains (internal and external) and URL Redirects. */
export function DomainsPanel({ accountId }: { accountId: string }) {
  const [view, setView] = useState<'domains' | 'redirects'>('domains')
  const [managing, setManaging] = useState<string | null>(null)
  const registrar = useQuery<Registrar>({ queryKey: ['hl', 'porkbun'], queryFn: () => hlFetch('/api/hl/settings/porkbun') })
  const list = useQuery<{ domains: DomainRow[] }>({ queryKey: ['hl', 'domains', accountId], queryFn: () => hlFetch(`/api/hl/accounts/${accountId}/domains`) })
  const domains = list.data?.domains ?? []
  const open = domains.find((d) => d.id === managing)
  return (
    <div className="flex flex-col">
      <div className="flex items-center gap-6 border-b border-border px-6">
        <p className="py-3 text-[15px] font-semibold text-foreground">Domains & URL Redirects</p>
        <div className="flex gap-4">
          {(['domains', 'redirects'] as const).map((v) => (
            <button
              key={v}
              type="button"
              onClick={() => {
                setView(v)
                setManaging(null)
              }}
              className={cn('-mb-px border-b-2 py-3 text-[13px] font-medium transition', view === v ? 'border-primary text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground')}
            >
              {v === 'domains' ? 'Domains' : 'URL Redirects'}
            </button>
          ))}
        </div>
      </div>
      <div className="mx-auto w-full max-w-5xl px-6 py-6">
        {view === 'redirects' ? (
          <UrlRedirects accountId={accountId} connected={!!registrar.data?.connected} />
        ) : open ? (
          open.origin === 'external' ? (
            <ManageExternal key={open.id} accountId={accountId} domainId={open.id} onBack={() => setManaging(null)} />
          ) : (
            <ManageInternal key={open.id} accountId={accountId} domainId={open.id} onBack={() => setManaging(null)} />
          )
        ) : (
          <DomainsHome accountId={accountId} registrar={registrar.data} registrarLoading={registrar.isLoading} domains={domains} loading={list.isLoading} error={list.error} onManage={setManaging} />
        )}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// The list
// ---------------------------------------------------------------------------

function DomainsHome({
  accountId,
  registrar,
  registrarLoading,
  domains,
  loading,
  error,
  onManage,
}: {
  accountId: string
  registrar: Registrar | undefined
  registrarLoading: boolean
  domains: DomainRow[]
  loading: boolean
  error: unknown
  onManage: (id: string) => void
}) {
  const [search, setSearch] = useState('')
  const [dialog, setDialog] = useState<null | { kind: 'purchase'; tab: 'buy' | 'transfer'; name?: string } | { kind: 'connect'; name?: string } | { kind: 'link' }>(null)
  const connected = !!registrar?.connected
  const q = search.trim().toLowerCase()
  const internal = domains.filter((d) => d.origin !== 'external' && (!q || d.name.includes(q)))
  const external = domains.filter((d) => d.origin === 'external' && (!q || d.name.includes(q)))
  const done = (id: string) => {
    setDialog(null)
    onManage(id)
  }
  return (
    <div className="flex flex-col gap-7">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-[24px] font-semibold tracking-tight text-foreground">Domains</h1>
        <div className="flex flex-wrap gap-2">
          <Button icon={<ShoppingCart className="h-3.5 w-3.5" />} disabled={!connected} title={connected ? undefined : 'Connect Porkbun first (below)'} onClick={() => setDialog({ kind: 'purchase', tab: 'buy' })}>
            Purchase/Transfer domain
          </Button>
          <Button variant="primary" icon={<Plus className="h-3.5 w-3.5" />} onClick={() => setDialog({ kind: 'connect' })}>
            Connect a domain
          </Button>
        </div>
      </div>

      {!registrarLoading && !connected && <RegistrarSetup status={registrar} />}
      {connected && registrar?.sandbox && (
        <p className="flex items-center gap-2 rounded-lg border border-warning/40 bg-warning/5 px-4 py-2.5 text-[13px] text-warning">
          <TriangleAlert className="h-4 w-4 shrink-0" /> Porkbun sandbox keys: purchases and transfers use fake credit. Swap in the live keys in the Vault when it all looks right.
        </p>
      )}

      <section className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-[16px] font-semibold text-foreground">Internal Domains ({internal.length})</h2>
          <div className="flex items-center gap-3">
            {connected && (
              <button type="button" onClick={() => setDialog({ kind: 'link' })} className="flex items-center gap-1 text-[12.5px] text-muted-foreground hover:text-foreground" title="A domain already in the Porkbun account">
                <Link2 className="h-3.5 w-3.5" /> Link existing
              </button>
            )}
            <div className="relative">
              <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
              <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search domains" className="w-60 pl-8" />
            </div>
          </div>
        </div>
        {loading ? (
          <Card className="flex justify-center py-12">
            <Spinner />
          </Card>
        ) : !internal.length && !q ? (
          <PurchaseCard disabled={!connected} onPurchase={() => setDialog({ kind: 'purchase', tab: 'buy' })} onTransfer={() => setDialog({ kind: 'purchase', tab: 'transfer' })} />
        ) : !internal.length ? (
          <Card className="px-5 py-8 text-center text-[13px] text-muted-foreground">No internal domain matches “{search}”.</Card>
        ) : (
          <Card>
            {internal.map((d) => (
              <div key={d.id} className="grid items-center gap-4 border-b border-border-soft px-5 py-4 last:border-0 md:grid-cols-[1.4fr_1fr_1fr_auto]">
                <div className="min-w-0">
                  <p className="truncate text-[15px] font-semibold text-foreground">{d.name}</p>
                  <p className="text-[12px] text-muted-foreground">
                    {d.expiresAt ? `Expires ${day(d.expiresAt)}` : d.origin === 'transfer' ? 'Transferring in' : 'Held at Porkbun'}
                    {d.autoRenew !== null && d.expiresAt ? ` · auto-renew ${d.autoRenew ? 'on' : 'off'}` : ''}
                  </p>
                </div>
                <div>
                  <p className="eyebrow mb-1 text-muted-foreground">Status</p>
                  {statusBadge(d)}
                </div>
                <div>
                  <p className="eyebrow mb-1 text-muted-foreground">Connected products</p>
                  <Products d={d} />
                </div>
                <Button size="sm" onClick={() => onManage(d.id)}>
                  Manage
                </Button>
              </div>
            ))}
          </Card>
        )}
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-[16px] font-semibold text-foreground">External Domains ({external.length})</h2>
        {!external.length ? (
          <Card className="px-5 py-6 text-[13px] text-muted-foreground">Domains registered somewhere else (Namecheap, GoDaddy, Cloudflare…) that you connect to the client’s site show up here. Use “Connect a domain”.</Card>
        ) : (
          <Card>
            {external.map((d) => {
              const meta = metaOf(d.meta)
              const subs = (meta.hosts ?? []).filter((h) => h.host)
              return (
                <div key={d.id} className="grid items-center gap-4 border-b border-border-soft px-5 py-4 last:border-0 md:grid-cols-[1.4fr_1fr_1fr_auto]">
                  <div className="min-w-0">
                    <p className="truncate text-[15px] font-semibold text-foreground">{d.name}</p>
                    <p className="text-[12px] text-muted-foreground">{meta.provider ? `DNS managed by ${meta.provider}` : 'DNS provider unknown'}</p>
                  </div>
                  <div className="min-w-0">
                    <p className="eyebrow mb-1 text-muted-foreground">Sub domains</p>
                    {subs.length ? subs.map((s) => <p key={s.host} className="truncate text-[13px] text-foreground/85">{fqdnOf(d.name, s.host)}</p>) : <span className="text-[12.5px] text-muted-foreground">—</span>}
                  </div>
                  <div>
                    <p className="eyebrow mb-1 text-muted-foreground">Connected products</p>
                    <Products d={d} />
                  </div>
                  <div className="flex flex-col gap-2">
                    <Button size="sm" onClick={() => onManage(d.id)}>
                      Manage
                    </Button>
                    <Button size="sm" variant="primary" icon={<ArrowRightLeft className="h-3.5 w-3.5" />} disabled={!connected} title={connected ? 'Move it to Genisys’s Porkbun account' : 'Connect Porkbun first'} onClick={() => setDialog({ kind: 'purchase', tab: 'transfer', name: d.name })}>
                      Transfer-In
                    </Button>
                  </div>
                </div>
              )
            })}
          </Card>
        )}
      </section>
      <ErrorNote error={error} />

      {dialog?.kind === 'purchase' && <PurchaseDialog accountId={accountId} sandbox={!!registrar?.sandbox} tab={dialog.tab} name={dialog.name} onClose={() => setDialog(null)} onDone={done} />}
      {dialog?.kind === 'connect' && <ConnectDialog accountId={accountId} name={dialog.name} onClose={() => setDialog(null)} onDone={done} />}
      {dialog?.kind === 'link' && <LinkDialog accountId={accountId} onClose={() => setDialog(null)} onDone={done} />}
    </div>
  )
}

/** GHL's empty state for internal domains: what buying here gets you, and the two ways in. */
function PurchaseCard({ disabled, onPurchase, onTransfer }: { disabled: boolean; onPurchase: () => void; onTransfer: () => void }) {
  const perks = ['DNS managed right here', 'All client domains under one roof', 'Free WHOIS privacy', 'Connects to the client’s site in one step', 'Renews at cost from Genisys’s Porkbun credit']
  return (
    <Card className="grid gap-6 p-6 md:grid-cols-2">
      <div className="flex flex-col gap-4">
        <span className="grid h-10 w-10 place-items-center rounded-full bg-muted text-muted-foreground">
          <ShoppingCart className="h-5 w-5" />
        </span>
        <p className="text-[17px] font-semibold text-foreground">Purchase or Transfer-In Domain</p>
        <ul className="flex flex-col gap-2.5">
          {perks.map((p) => (
            <li key={p} className="flex items-center gap-2.5 text-[13.5px] text-foreground/90">
              <span className="grid h-5 w-5 place-items-center rounded-full bg-success/15 text-success">
                <Check className="h-3 w-3" />
              </span>
              {p}
            </li>
          ))}
        </ul>
        <div className="flex flex-wrap gap-2 pt-1">
          <Button variant="primary" icon={<ShoppingCart className="h-3.5 w-3.5" />} disabled={disabled} onClick={onPurchase}>
            Purchase domain
          </Button>
          <Button icon={<ArrowRightLeft className="h-3.5 w-3.5" />} disabled={disabled} onClick={onTransfer}>
            Transfer-In Domain
          </Button>
        </div>
      </div>
      {/* A small picture of the DNS manager, standing in for GHL's screenshot carousel. */}
      <div className="hidden overflow-hidden rounded-lg border border-border bg-muted/40 p-4 md:block" aria-hidden>
        <p className="mb-1 text-[13px] font-semibold text-foreground">acmeroofing.com</p>
        <p className="mb-3 text-[11px] text-muted-foreground">
          <span className="text-success">● Active</span> · Expires Oct 24, 2027 · Auto-renew on
        </p>
        <div className="flex gap-3 border-b border-border pb-2 text-[11px] text-muted-foreground">
          <span>Connected Products</span>
          <span className="border-b-2 border-primary pb-2 text-foreground">DNS Records</span>
        </div>
        {[
          ['A', '@', '185.158.133.1'],
          ['A', 'www', '185.158.133.1'],
          ['TXT', '_lovable', 'lovable_verify=…'],
          ['MX', '@', 'fwd1.porkbun.com'],
        ].map(([t, h, v]) => (
          <div key={t + h} className="grid grid-cols-[48px_72px_1fr] gap-2 border-b border-border-soft py-2 font-mono text-[11px] text-foreground/80 last:border-0">
            <span>{t}</span>
            <span>{h}</span>
            <span className="truncate">{v}</span>
          </div>
        ))}
      </div>
    </Card>
  )
}

function RegistrarSetup({ status }: { status: Registrar | undefined }) {
  return (
    <Card className="flex flex-col gap-3 px-5 py-4">
      <div className="flex items-center gap-3">
        <span className="grid h-10 w-10 place-items-center rounded-full bg-primary-soft text-primary">
          <Globe className="h-5 w-5" />
        </span>
        <div>
          <p className="text-[14px] font-semibold text-foreground">Connect Porkbun to buy and transfer domains</p>
          <p className="text-[13px] text-muted-foreground">{status?.error ?? 'Porkbun is the registrar Hell-level uses: cheap, free WHOIS privacy, and an API for buying, transfers and DNS.'} Connecting external domains works without it.</p>
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
        <li>Under Account → API Access: create a key (a sandbox key first lets you try everything free), set a monthly spend limit, and turn on API access for all domains.</li>
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
// Purchase / Transfer (GHL's "Purchase/Transfer domain"), Connect, Link
// ---------------------------------------------------------------------------

function PurchaseDialog({ accountId, sandbox, tab: initial, name, onClose, onDone }: { accountId: string; sandbox: boolean; tab: 'buy' | 'transfer'; name?: string; onClose: () => void; onDone: (id: string) => void }) {
  const [tab, setTab] = useState(initial)
  return (
    <Modal open onClose={onClose} title="Purchase or transfer a domain" description={sandbox ? 'Sandbox: nothing real is bought.' : 'Held in Genisys’s Porkbun account for this client, with WHOIS privacy.'} width="max-w-2xl">
      <div className="flex flex-col gap-4">
        <Tabs
          value={tab}
          onChange={setTab}
          tabs={[
            { key: 'buy', label: 'Purchase' },
            { key: 'transfer', label: 'Transfer-In' },
          ]}
        />
        {tab === 'buy' ? <BuyFlow accountId={accountId} onDone={onDone} /> : <TransferFlow accountId={accountId} initialName={name} onDone={onDone} />}
      </div>
    </Modal>
  )
}

function BuyFlow({ accountId, onDone }: { accountId: string; onDone: (id: string) => void }) {
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
  if (!picked) {
    return (
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
    )
  }
  return (
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
  )
}

type TransferCheck = { name: string; inPorkbun: boolean; linkedTo: string | null; available: boolean; transferCents: number | null; records: { host: string; type: string; content: string }[]; scanError: string | null }

function TransferFlow({ accountId, initialName, onDone }: { accountId: string; initialName?: string; onDone: (id: string) => void }) {
  const qc = useQueryClient()
  const [name, setName] = useState(initialName ?? '')
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
    <div className="flex flex-col gap-4">
      <p className="text-[13px] text-muted-foreground">For domains bought through GoHighLevel (or anywhere else). The site and email keep working while it moves.</p>
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
      {c && c.linkedTo && c.inPorkbun && <p className="text-[13px] text-warning">{c.name} is already in Hell-level, on {c.linkedTo}.</p>}
      {c && !c.linkedTo && c.inPorkbun && (
        <div className="flex items-center justify-between gap-3 rounded-lg border border-border p-3 text-[13px]">
          <span className="text-foreground/85">{c.name} is already in the Porkbun account: no transfer needed.</span>
          <Button size="sm" variant="primary" loading={link.isPending} onClick={() => link.mutate(c.name)}>
            Link it here
          </Button>
        </div>
      )}
      {c && !c.inPorkbun && c.available && <p className="text-[13px] text-warning">Nobody owns {c.name} yet, so there’s nothing to transfer: buy it instead.</p>}
      {c && !c.inPorkbun && !c.available && (
        <>
          <div className="rounded-lg border border-border p-4">
            <p className="text-[14px] font-semibold text-foreground">What gets copied</p>
            <p className="mb-2 text-[12.5px] text-muted-foreground">The DNS the domain answers with now, copied to Porkbun before it moves. You review it before the transfer is released.</p>
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
                {!q.wouldSucceed && (
                  <p className="mt-1 text-warning">
                    {q.reason ?? 'Porkbun says this wouldn’t go through right now.'}
                    {q.shortfallCents ? ` Add at least ${usd(q.shortfallCents)} of credit.` : ''}
                  </p>
                )}
              </div>
              <Button variant="primary" disabled={!q.wouldSucceed || !q.costCents} loading={start.isPending} onClick={() => start.mutate(q)}>
                Pay {usd(q.costCents)} and start
              </Button>
            </div>
          )}
        </>
      )}
    </div>
  )
}

/** GHL's "Connect a domain": a domain or subdomain for the client's site, wherever its DNS is. */
function ConnectDialog({ accountId, name: initial, onClose, onDone }: { accountId: string; name?: string; onClose: () => void; onDone: (id: string) => void }) {
  const qc = useQueryClient()
  const account = useAccount(accountId)
  const [name, setName] = useState(initial ?? '')
  const [txt, setTxt] = useState('')
  const [wwwTxt, setWwwTxt] = useState('')
  const connect = useMutation({
    mutationFn: () => hlFetch<{ domain: DomainRow; internal: boolean }>(`/api/hl/accounts/${accountId}/domains`, { method: 'POST', json: { action: 'connect', name, txt, wwwTxt } }),
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: ['hl', 'domains', accountId] })
      onDone(r.domain.id)
    },
  })
  const isSub = /^[^.]+\.[^.]+\.[^.]+/.test(name.trim()) && !/^www\./i.test(name.trim())
  const siteUrl = account.data?.client?.siteUrl
  return (
    <Modal
      open
      onClose={onClose}
      title="Connect a domain"
      description="Point a domain or subdomain at the client’s Lovable site. If it’s held here, the records are set for you; if it’s registered elsewhere, you get the records to add there and the Hub checks them."
      width="max-w-xl"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={connect.isPending} disabled={!name.trim()} onClick={() => connect.mutate()}>
            Connect
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <Field label="Domain or subdomain">
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="acmeroofing.com or try.acmeroofing.com" autoFocus />
        </Field>
        <Field label="Connect to">
          <Select value="site" disabled>
            <option value="site">Website (the client’s Lovable site{siteUrl ? `, ${siteUrl.replace(/^https?:\/\//, '')}` : ''})</option>
          </Select>
        </Field>
        <div className="rounded-lg border border-border p-3 text-[12.5px] text-foreground/85">
          In Lovable: the client’s project → Settings → Domains → Connect domain → {name.trim() || 'the domain'} → manual setup. Copy the TXT value it shows (lovable_verify=…). It can be added later too.
        </div>
        <Field label={isSub ? `_lovable.${name.trim()} TXT` : '_lovable TXT'}>
          <Input value={txt} onChange={(e) => setTxt(e.target.value)} placeholder="lovable_verify=…" spellCheck={false} />
        </Field>
        {!isSub && (
          <Field label="_lovable.www TXT (optional)">
            <Input value={wwwTxt} onChange={(e) => setWwwTxt(e.target.value)} placeholder="lovable_verify=…" spellCheck={false} />
          </Field>
        )}
        <ErrorNote error={connect.error} />
      </div>
    </Modal>
  )
}

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
                {d.expiresAt && <span className="block text-[12px] text-muted-foreground">Expires {day(d.expiresAt)}</span>}
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
// Manage: a domain held here (GHL's domain page: products, DNS records…)
// ---------------------------------------------------------------------------

function useDomain(accountId: string, domainId: string) {
  const qc = useQueryClient()
  const url = `/api/hl/accounts/${accountId}/domains/${domainId}`
  const detail = useQuery<Detail>({ queryKey: ['hl', 'domain', domainId], queryFn: () => hlFetch(url) })
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['hl', 'domain', domainId] })
    qc.invalidateQueries({ queryKey: ['hl', 'domains', accountId] })
  }
  const act = useMutation({
    mutationFn: (body: Record<string, unknown>) => hlFetch<{ domain?: DomainRow; needsConfirm?: boolean; message?: string }>(url, { method: 'POST', json: body }),
    onSuccess: refresh,
  })
  const unlink = useMutation({ mutationFn: () => hlFetch(url, { method: 'DELETE' }), onSuccess: refresh })
  return { detail, act, unlink }
}

function ManageHeader({ d, onBack, right }: { d: DomainRow; onBack: () => void; right?: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-wrap items-center gap-3">
        <button type="button" onClick={onBack} className="grid h-8 w-8 place-items-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground" title="Back to domains">
          <ArrowLeft className="h-4 w-4" />
        </button>
        <a href={`https://${d.name}`} target="_blank" rel="noreferrer" className="flex items-center gap-1.5 text-[20px] font-semibold text-foreground hover:underline">
          {d.name} <ExternalLink className="h-3.5 w-3.5 text-muted-foreground" />
        </a>
        {statusBadge(d)}
        <span className="ml-auto flex gap-2">{right}</span>
      </div>
      {d.origin !== 'external' && (
        <p className="pl-11 text-[12.5px] text-muted-foreground">
          {d.origin === 'bought' ? 'Purchased' : d.origin === 'transfer' ? 'Transferred in' : 'Linked'} {day(d.createdAt)}
          {d.expiresAt ? ` · Expires ${day(d.expiresAt)}` : ''}
          {d.autoRenew !== null && d.expiresAt ? ` · Auto-renew ${d.autoRenew ? 'on' : 'off'}` : ''}
          {d.costCents ? ` · ${usd(d.costCents)}` : ''}
        </p>
      )}
    </div>
  )
}

function ManageInternal({ accountId, domainId, onBack }: { accountId: string; domainId: string; onBack: () => void }) {
  const { detail, act, unlink } = useDomain(accountId, domainId)
  const [tab, setTab] = useState<'products' | 'dns' | 'email' | 'history'>('products')
  const d = detail.data?.domain
  if (detail.isLoading || !d) return <div className="flex justify-center py-16">{detail.error ? <ErrorNote error={detail.error} /> : <Spinner />}</div>
  const here = d.status === 'active' || d.status === 'held' || d.status === 'transferring'
  return (
    <div className="flex flex-col gap-5">
      <ManageHeader
        d={d}
        onBack={onBack}
        right={
          <Button size="sm" variant="ghost" icon={<RefreshCw className="h-3.5 w-3.5" />} loading={act.isPending && act.variables?.action === 'refresh'} onClick={() => act.mutate({ action: 'refresh' })}>
            {d.status === 'failed' && d.origin === 'bought' ? 'Check again' : 'Refresh'}
          </Button>
        }
      />
      {d.lastError && (
        <p className="flex items-start gap-2 rounded-lg border border-warning/40 bg-warning/5 px-4 py-3 text-[13px] text-warning">
          <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" /> {d.lastError}
        </p>
      )}
      {d.status === 'held' && <HeldTransfer d={d} recordCount={detail.data?.records?.data?.length ?? 0} act={act} />}
      {d.status === 'transferring' && <MovingTransfer d={d} act={act} />}
      {here && (
        <Tabs
          value={tab}
          onChange={setTab}
          tabs={[
            { key: 'products', label: 'Connected Products' },
            { key: 'dns', label: 'DNS Records' },
            ...(d.status === 'active' ? [{ key: 'email' as const, label: 'Email Forwarding' }] : []),
            { key: 'history', label: 'History' },
          ]}
        />
      )}
      {here && tab === 'products' && <ProductsTab accountId={accountId} d={d} hosts={detail.data?.hosts ?? []} forwards={detail.data?.forwards?.data?.length ?? 0} act={act} onEmail={() => setTab('email')} />}
      {here && tab === 'dns' && <DnsTab d={d} detail={detail.data!} act={act} />}
      {here && tab === 'email' && d.status === 'active' && <EmailTab d={d} detail={detail.data!} act={act} />}
      {(tab === 'history' || !here) && <History d={d} />}
      <ErrorNote error={act.error || unlink.error} />
      {!['held', 'transferring', 'pending'].includes(d.status) && (
        <div className="flex justify-end border-t border-border pt-4">
          <button
            type="button"
            onClick={() => {
              if (window.confirm(`Unlink ${d.name} from this sub-account? It stays in the Porkbun account (nothing is cancelled), and you can link it again.`)) unlink.mutate(undefined, { onSuccess: onBack })
            }}
            className="flex items-center gap-1.5 text-[13px] font-medium text-destructive hover:underline"
          >
            <Trash2 className="h-3.5 w-3.5" /> Unlink from this sub-account
          </button>
        </div>
      )}
    </div>
  )
}

function ProductsTab({ accountId, d, hosts, forwards, act, onEmail }: { accountId: string; d: DomainRow; hosts: HostView[]; forwards: number; act: Act; onEmail: () => void }) {
  const account = useAccount(accountId)
  const [connecting, setConnecting] = useState<string | null>(null)
  const editable = d.status === 'active' || d.status === 'held'
  return (
    <div className="flex flex-col gap-3">
      <Card>
        <div className="flex flex-wrap items-center gap-3 border-b border-border px-5 py-3">
          <p className="text-[14px] font-semibold text-foreground">Website</p>
          <p className="text-[12.5px] text-muted-foreground">The client’s Lovable site{account.data?.client?.siteUrl ? ` (${account.data.client.siteUrl.replace(/^https?:\/\//, '')})` : ''}</p>
          {editable && (
            <span className="ml-auto flex gap-2">
              <Button size="sm" variant="primary" icon={<Plus className="h-3.5 w-3.5" />} onClick={() => setConnecting('')}>
                Connect {hosts.some((h) => !h.host) ? 'a subdomain' : d.name}
              </Button>
            </span>
          )}
        </div>
        {!hosts.length ? (
          <p className="px-5 py-5 text-[13px] text-muted-foreground">Not connected to the site yet.</p>
        ) : (
          hosts.map((h) => (
            <div key={h.host} className="flex flex-wrap items-center gap-3 border-b border-border-soft px-5 py-3 last:border-0">
              <CheckCircle2 className="h-4 w-4 text-success" />
              <span className="text-[13.5px] font-medium text-foreground">{h.host ? fqdnOf(d.name, h.host) : `${d.name} and www`}</span>
              <span className="text-[12px] text-muted-foreground">Records set here · press Verify in Lovable if it isn’t live yet</span>
              {editable && (
                <span className="ml-auto flex gap-3">
                  <button type="button" className="text-[12.5px] text-muted-foreground hover:text-foreground" onClick={() => setConnecting(h.host)}>
                    Update TXT
                  </button>
                  <button
                    type="button"
                    className="text-[12.5px] text-destructive hover:underline"
                    onClick={() => {
                      if (window.confirm(`Stop listing ${fqdnOf(d.name, h.host)} as connected? Its DNS records stay; delete them under DNS Records to take it off the site.`)) act.mutate({ action: 'disconnect', host: h.host })
                    }}
                  >
                    Disconnect
                  </button>
                </span>
              )}
            </div>
          ))
        )}
      </Card>
      <Card className="flex flex-wrap items-center gap-3 px-5 py-3">
        <p className="text-[14px] font-semibold text-foreground">Email</p>
        <p className="text-[12.5px] text-muted-foreground">{forwards ? `${forwards} address${forwards === 1 ? '' : 'es'} forwarding to existing inboxes` : 'No email set up on this domain'}</p>
        {d.status === 'active' && (
          <Button size="sm" className="ml-auto" onClick={onEmail}>
            Email forwarding
          </Button>
        )}
      </Card>
      {connecting !== null && <LovableModal domain={d.name} host={connecting} siteUrl={account.data?.client?.siteUrl ?? null} act={act} onClose={() => setConnecting(null)} />}
    </div>
  )
}

function HeldTransfer({ d, recordCount, act }: { d: DomainRow; recordCount: number; act: Act }) {
  const imported = metaOf(d.meta).imported
  return (
    <div className="flex flex-col gap-3 rounded-lg border border-warning/40 bg-warning/5 px-5 py-4">
      <p className="text-[14px] font-semibold text-foreground">Paid and parked: check the DNS, then release it</p>
      <p className="text-[13px] text-muted-foreground">
        {imported ? `${imported.created + imported.skipped} record(s) were copied from the domain’s current DNS. ` : ''}
        Compare them under DNS Records with GoHighLevel’s DNS page for {d.name} (Settings → Domains & URL Redirects → Manage → DNS Records) and add anything missing, like email (MX) or verification (TXT) records. Nothing moves until you release it.
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
    <div className="flex flex-col gap-3 rounded-lg border border-border px-5 py-4">
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

function DnsTab({ d, detail, act }: { d: DomainRow; detail: Detail; act: Act }) {
  const [editing, setEditing] = useState<DnsRecord | 'new' | null>(null)
  const [filter, setFilter] = useState('')
  const records = detail.records
  const ns = detail.nameservers
  const editable = d.status === 'active' || d.status === 'held'
  const f = filter.trim().toLowerCase()
  const shown = (records?.data ?? []).filter((r) => !f || `${r.type} ${r.host} ${r.content}`.toLowerCase().includes(f))
  return (
    <div className="flex flex-col gap-3">
      {ns?.data && ns.onPorkbun === false && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-warning/40 bg-warning/5 px-4 py-3 text-[13px]">
          <span className="text-foreground/85">Its nameservers are {ns.data.join(', ')}, so the records here aren’t in use: changes won’t show until it uses Porkbun’s.</span>
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
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Type to search" className="w-60 pl-8" />
        </div>
        {editable && (
          <Button size="sm" variant="primary" icon={<Plus className="h-3.5 w-3.5" />} onClick={() => setEditing('new')}>
            Add Record
          </Button>
        )}
      </div>
      {records?.error ? (
        <p className="text-[13px] text-warning">Couldn’t read the DNS: {records.error}</p>
      ) : !shown.length ? (
        <p className="py-4 text-[13px] text-muted-foreground">{f ? 'No record matches.' : 'No records yet.'}</p>
      ) : (
        <Card className="overflow-hidden">
          <Table head={['Type', 'Name', 'Value', 'TTL', '']}>
            {shown.map((r) => (
              <tr key={r.id} className="border-b border-border-soft last:border-0">
                <td className="px-4 py-2 font-mono text-[12px] text-foreground">{r.type}</td>
                <td className="px-4 py-2 font-mono text-[12px] text-foreground/85">{r.host || '@'}</td>
                <td className="max-w-[340px] px-4 py-2 font-mono text-[12px] text-foreground/85">
                  <span className="line-clamp-2 break-all">
                    {r.prio !== null && (r.type === 'MX' || r.type === 'SRV') ? `${r.prio} ` : ''}
                    {r.content}
                  </span>
                </td>
                <td className="px-4 py-2 text-[12px] text-muted-foreground">{r.ttl ?? 'Auto'}</td>
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
        </Card>
      )}
      {editing && <RecordModal domain={d.name} record={editing === 'new' ? null : editing} act={act} onClose={() => setEditing(null)} />}
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
      title={record ? 'Edit DNS Record' : 'Add DNS Record'}
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
        <Field label="Name" hint={`Use @ or leave blank for ${domain} itself`}>
          <div className="flex items-center gap-1.5">
            <Input value={f.host} onChange={(e) => setF({ ...f, host: e.target.value })} placeholder="www" />
            <span className="whitespace-nowrap text-[12px] text-muted-foreground">.{domain}</span>
          </div>
        </Field>
        <Field label={f.type === 'A' ? 'IPv4 address' : f.type === 'AAAA' ? 'IPv6 address' : 'Value'} className="sm:col-span-2">
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

function LovableModal({ domain, host: initialHost, siteUrl, act, onClose }: { domain: string; host: string; siteUrl: string | null; act: Act; onClose: () => void }) {
  const [host, setHost] = useState(initialHost)
  const [rootTxt, setRootTxt] = useState('')
  const [wwwTxt, setWwwTxt] = useState('')
  const fq = fqdnOf(domain, host.trim().toLowerCase())
  return (
    <Modal
      open
      onClose={onClose}
      title="Connect the Lovable site"
      description="Sets the A records to Lovable’s IP and its verification TXT. Other A, AAAA and CNAME records at the same names are replaced; email records aren’t touched."
      width="max-w-xl"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={act.isPending} disabled={!rootTxt.trim()} onClick={() => act.mutate({ action: 'connect-lovable', host: host.trim().toLowerCase(), rootTxt, wwwTxt }, { onSuccess: onClose })}>
            Set the records
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <Field label="Subdomain" hint={`Blank connects ${domain} itself (and www)`}>
          <div className="flex items-center gap-1.5">
            <Input value={host} onChange={(e) => setHost(e.target.value)} placeholder="(blank) or try" />
            <span className="whitespace-nowrap text-[12px] text-muted-foreground">.{domain}</span>
          </div>
        </Field>
        <ol className="list-decimal space-y-0.5 pl-5 text-[13px] text-foreground/85">
          <li>In Lovable, open the client’s project{siteUrl ? ` (${siteUrl.replace(/^https?:\/\//, '')})` : ''} → Settings → Domains → Connect domain → {fq}.</li>
          <li>Choose the manual setup and copy the TXT value it shows (it starts with lovable_verify=).</li>
        </ol>
        <Field label={`_lovable.${fq}`}>
          <Input value={rootTxt} onChange={(e) => setRootTxt(e.target.value)} placeholder="lovable_verify=…" spellCheck={false} />
        </Field>
        {!host.trim() && (
          <Field label={`_lovable.www.${domain} (optional)`}>
            <Input value={wwwTxt} onChange={(e) => setWwwTxt(e.target.value)} placeholder="lovable_verify=…" spellCheck={false} />
          </Field>
        )}
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
        <Card className="overflow-hidden">
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
        </Card>
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

// ---------------------------------------------------------------------------
// Manage: an external domain (its DNS stays where it is)
// ---------------------------------------------------------------------------

function ManageExternal({ accountId, domainId, onBack }: { accountId: string; domainId: string; onBack: () => void }) {
  const { detail, act, unlink } = useDomain(accountId, domainId)
  const [adding, setAdding] = useState(false)
  const d = detail.data?.domain
  if (detail.isLoading || !d) return <div className="flex justify-center py-16">{detail.error ? <ErrorNote error={detail.error} /> : <Spinner />}</div>
  const meta = metaOf(d.meta)
  const hosts = detail.data?.hosts ?? []
  return (
    <div className="flex flex-col gap-5">
      <ManageHeader
        d={d}
        onBack={onBack}
        right={
          <Button size="sm" variant="ghost" icon={<RefreshCw className="h-3.5 w-3.5" />} loading={act.isPending && act.variables?.action === 'verify'} onClick={() => act.mutate({ action: 'verify' })}>
            Verify DNS
          </Button>
        }
      />
      <p className="pl-11 text-[12.5px] text-muted-foreground">
        {meta.provider ? `DNS managed by ${meta.provider}` : 'DNS provider unknown'}
        {meta.nameservers?.length ? ` (${meta.nameservers.join(', ')})` : ''}. Add the records below there; the Hub checks public DNS every 30 minutes.
      </p>
      {hosts.map((h) => {
        const ok = !!h.lastCheck?.ok
        return (
          <Card key={h.host}>
            <div className="flex flex-wrap items-center gap-3 border-b border-border px-5 py-3">
              <Badge color="blue">Website</Badge>
              <p className="text-[14px] font-semibold text-foreground">{h.host ? fqdnOf(d.name, h.host) : `${d.name} and www`}</p>
              {ok ? (
                <Badge color="green" dot>
                  Records live
                </Badge>
              ) : (
                <Badge color="amber">Waiting on DNS</Badge>
              )}
              <span className="ml-auto flex items-center gap-3 text-[12px] text-muted-foreground">
                {h.lastCheck ? `Checked ${fmtDateTime(h.lastCheck.at)}` : 'Not checked yet'}
                <button
                  type="button"
                  className="text-destructive hover:underline"
                  onClick={() => {
                    if (window.confirm(`Disconnect ${fqdnOf(d.name, h.host)}? Remove its records at ${meta.provider ?? 'the DNS provider'} too.`)) act.mutate({ action: 'disconnect', host: h.host })
                  }}
                >
                  Disconnect
                </button>
              </span>
            </div>
            <Table head={['Type', 'Name', 'Value', '']}>
              {h.records.map((r) => {
                const live = r.type === 'A' ? (r.host === '@' || r.host === h.host ? !!h.lastCheck?.a.includes(r.value) : ok) : !!h.lastCheck?.txtOk
                return (
                  <tr key={r.type + r.host} className="border-b border-border-soft last:border-0">
                    <td className="px-4 py-2 font-mono text-[12px] text-foreground">{r.type}</td>
                    <td className="px-4 py-2 font-mono text-[12px] text-foreground/85">{r.host}</td>
                    <td className="max-w-[320px] px-4 py-2 font-mono text-[12px] text-foreground/85">
                      <span className="break-all">{r.value}</span>
                    </td>
                    <td className="whitespace-nowrap px-4 py-2 text-right">
                      <span className={cn('mr-3 text-[12px]', live ? 'text-success' : 'text-muted-foreground')}>{live ? 'Live' : 'Not yet'}</span>
                      <button type="button" className="text-muted-foreground hover:text-foreground" title="Copy the value" onClick={() => copyText(r.value)}>
                        <Copy className="h-3.5 w-3.5" />
                      </button>
                    </td>
                  </tr>
                )
              })}
            </Table>
            {!h.txt && <p className="px-5 py-3 text-[12px] text-muted-foreground">Add Lovable’s TXT value too (Connect again with it) so Lovable can verify the domain.</p>}
          </Card>
        )
      })}
      <div className="flex flex-wrap gap-2">
        <Button icon={<Plus className="h-3.5 w-3.5" />} onClick={() => setAdding(true)}>
          Connect {hosts.some((h) => !h.host) ? 'a subdomain' : 'the domain or a subdomain'}
        </Button>
      </div>
      <Card className="px-5 py-4">
        <p className="mb-2 text-[14px] font-semibold text-foreground">History</p>
        <History d={d} />
      </Card>
      <ErrorNote error={act.error || unlink.error} />
      <div className="flex justify-end border-t border-border pt-4">
        <button
          type="button"
          onClick={() => {
            if (window.confirm(`Remove ${d.name} from this sub-account? Its DNS stays where it is.`)) unlink.mutate(undefined, { onSuccess: onBack })
          }}
          className="flex items-center gap-1.5 text-[13px] font-medium text-destructive hover:underline"
        >
          <X className="h-3.5 w-3.5" /> Remove domain
        </button>
      </div>
      {adding && <ConnectDialog accountId={accountId} name={d.name} onClose={() => setAdding(false)} onDone={() => setAdding(false)} />}
    </div>
  )
}

// ---------------------------------------------------------------------------
// URL Redirects
// ---------------------------------------------------------------------------

function UrlRedirects({ accountId, connected }: { accountId: string; connected: boolean }) {
  const qc = useQueryClient()
  const q = useQuery<{ redirects: Redirect[]; domains: { id: string; name: string }[]; errors: string[] }>({ queryKey: ['hl', 'redirects', accountId], queryFn: () => hlFetch(`/api/hl/accounts/${accountId}/domains?redirects=1`), enabled: connected })
  const [adding, setAdding] = useState(false)
  const remove = useMutation({
    mutationFn: (r: Redirect) => hlFetch(`/api/hl/accounts/${accountId}/domains/${r.domainId}`, { method: 'POST', json: { action: 'delete-redirect', redirectId: r.id } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['hl', 'redirects', accountId] }),
  })
  const domains = q.data?.domains ?? []
  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-[24px] font-semibold tracking-tight text-foreground">URL Redirects</h1>
          <p className="text-[13px] text-muted-foreground">Send a domain (or one of its subdomains) somewhere else, like an old domain to the new site. Works on domains held here.</p>
        </div>
        <Button variant="primary" icon={<Plus className="h-3.5 w-3.5" />} disabled={!domains.length} title={domains.length ? undefined : 'Needs a domain held here (Domains → Purchase/Transfer)'} onClick={() => setAdding(true)}>
          Add Redirect
        </Button>
      </div>
      {!connected ? (
        <Card className="px-5 py-6 text-[13px] text-muted-foreground">Redirects run on domains held in Genisys’s Porkbun account. Connect Porkbun on the Domains tab first.</Card>
      ) : q.isLoading ? (
        <Card className="flex justify-center py-12">
          <Spinner />
        </Card>
      ) : !q.data?.redirects.length ? (
        <Card className="px-5 py-8 text-center text-[13px] text-muted-foreground">No redirects yet.</Card>
      ) : (
        <Card className="overflow-hidden">
          <Table head={['From', 'To', 'Type', '']}>
            {q.data.redirects.map((r) => (
              <tr key={`${r.domainId}-${r.id}`} className="border-b border-border-soft last:border-0">
                <td className="px-4 py-2.5 text-foreground">{fqdnOf(r.domain, r.host)}</td>
                <td className="max-w-[320px] truncate px-4 py-2.5 text-foreground/85">{r.location}</td>
                <td className="px-4 py-2.5 text-[12px] text-muted-foreground">
                  {r.permanent ? '301' : '302'}
                  {r.includePath ? ' · keeps path' : ''}
                  {r.wildcard ? ' · all subdomains' : ''}
                </td>
                <td className="px-4 py-2.5 text-right">
                  <button
                    type="button"
                    className="text-muted-foreground hover:text-destructive"
                    title="Remove"
                    onClick={() => {
                      if (window.confirm(`Remove the redirect from ${fqdnOf(r.domain, r.host)} to ${r.location}?`)) remove.mutate(r)
                    }}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </td>
              </tr>
            ))}
          </Table>
        </Card>
      )}
      {!!q.data?.errors.length && <p className="text-[12.5px] text-warning">Couldn’t read: {q.data.errors.join('; ')}</p>}
      <ErrorNote error={q.error || remove.error} />
      {adding && <RedirectModal accountId={accountId} domains={domains} onClose={() => setAdding(false)} />}
    </div>
  )
}

function RedirectModal({ accountId, domains, onClose }: { accountId: string; domains: { id: string; name: string }[]; onClose: () => void }) {
  const qc = useQueryClient()
  const [f, setF] = useState({ domainId: domains[0]?.id ?? '', host: '', location: '', permanent: true, includePath: true, wildcard: false })
  const domain = domains.find((d) => d.id === f.domainId)
  const add = useMutation({
    mutationFn: () => hlFetch(`/api/hl/accounts/${accountId}/domains/${f.domainId}`, { method: 'POST', json: { action: 'add-redirect', host: f.host, location: f.location, permanent: f.permanent, includePath: f.includePath, wildcard: f.wildcard } }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['hl', 'redirects', accountId] })
      onClose()
    },
  })
  return (
    <Modal
      open
      onClose={onClose}
      title="Add Redirect"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={add.isPending} disabled={!f.domainId || !f.location.trim()} onClick={() => add.mutate()}>
            Save
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Domain">
            <Select value={f.domainId} onChange={(e) => setF({ ...f, domainId: e.target.value })}>
              {domains.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Subdomain" hint="Blank for the domain itself">
            <Input value={f.host} onChange={(e) => setF({ ...f, host: e.target.value })} placeholder="(blank) or www" />
          </Field>
        </div>
        <Field label="Redirect to">
          <Input value={f.location} onChange={(e) => setF({ ...f, location: e.target.value })} placeholder="https://newsite.com" />
        </Field>
        <p className="text-[12.5px] text-muted-foreground">From {domain ? fqdnOf(domain.name, f.host.trim().toLowerCase()) : '…'}</p>
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
        <ErrorNote error={add.error} />
      </div>
    </Modal>
  )
}
