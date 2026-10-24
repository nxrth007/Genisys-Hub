'use client'

import Link from 'next/link'
import { Suspense, useState } from 'react'
import { useParams, useSearchParams } from 'next/navigation'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Phone, Plus, RefreshCw, ShieldCheck, Trash2 } from 'lucide-react'
import { prettyPhone } from '@/lib/hl/merge'
import { cn } from '@/lib/utils'
import { PROFILE_FIELDS, type HlProfile } from '@/lib/hl/types'
import { textingBadge, useAccount, type PhoneNumberRow } from '@/components/hell-level/bits'
import { Badge, Button, Card, ErrorNote, Field, Input, Modal, PageHeader, Select, Spinner, Table, Toggle, fmtDateTime, hlFetch } from '@/components/hell-level/ui'
import { NotYet, RecordsTable, rv } from '@/components/hell-level/section'
import { SETTINGS_PAGES } from '@/components/hell-level/nav'
import { PipelinesManager } from '@/components/hell-level/pipelines-manager'
import { ImportPanel } from '@/components/hell-level/import-panel'
import { DomainsPanel } from '@/components/hell-level/domains-panel'
import { StaffPanel } from '@/components/hell-level/staff-panel'

const ZONES = ['America/New_York', 'America/Chicago', 'America/Denver', 'America/Phoenix', 'America/Los_Angeles', 'America/Anchorage', 'Pacific/Honolulu']

export default function SettingsPage() {
  return (
    <Suspense fallback={<div className="flex justify-center py-24"><Spinner /></div>}>
      <Settings />
    </Suspense>
  )
}

/** GHL's Settings: a menu down the left, the page on the right (?tab=). */
function Settings() {
  const { accountId } = useParams<{ accountId: string }>()
  const sp = useSearchParams()
  const page = SETTINGS_PAGES.find((p) => p.key === sp.get('tab'))?.key ?? 'business-profile'
  const account = useAccount(accountId)
  return (
    <div className="flex min-h-full">
      <aside className="w-[232px] shrink-0 border-r border-border px-3 py-5">
        <p className="eyebrow px-2.5 pb-2 text-muted-foreground">Settings</p>
        <nav className="flex flex-col gap-px">
          {SETTINGS_PAGES.map((p) => (
            <Link
              key={p.key}
              href={`/hell-level/${accountId}/settings?tab=${p.key}`}
              className={cn(
                'rounded-md px-2.5 py-1.5 text-[13px] transition',
                page === p.key ? 'bg-white/[0.06] text-foreground' : 'text-muted-foreground hover:bg-white/[0.04] hover:text-foreground',
              )}
            >
              {p.label}
            </Link>
          ))}
        </nav>
      </aside>
      <div className="min-w-0 flex-1">
        {account.isLoading ? (
          <div className="flex justify-center py-16">
            <Spinner />
          </div>
        ) : !account.data ? (
          <div className="p-6">
            <ErrorNote error={account.error} />
          </div>
        ) : (
          <SettingsContent key={page} page={page} accountId={accountId} numbers={account.data.numbers} />
        )}
      </div>
    </div>
  )
}

function Panel({ title, description, children }: { title: string; description?: string; children: React.ReactNode }) {
  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-5 px-6 py-6">
      <PageHeader title={title} description={description} />
      {children}
    </div>
  )
}

function SettingsContent({ page, accountId, numbers }: { page: string; accountId: string; numbers: PhoneNumberRow[] }) {
  switch (page) {
    case 'business-profile':
      return (
        <Panel title="Business Profile" description="Fills the {{account.*}} fields in every automation (GHL’s custom values) and the texting verification.">
          <ProfileTab accountId={accountId} />
        </Panel>
      )
    case 'my-staff':
      return <StaffPanel accountId={accountId} />
    case 'pipelines':
      return (
        <Panel title="Opportunities & Pipelines" description="Pipelines and their stages. Opportunities point at a stage, so a stage with opportunities in it can’t be removed.">
          <PipelinesManager accountId={accountId} />
        </Panel>
      )
    case 'phone-numbers':
      return (
        <Panel title="Phone Numbers" description="Numbers bought for this sub-account on the Hub’s Twilio account, where calls ring, and texting verification.">
          <NumbersTab accountId={accountId} numbers={numbers} />
        </Panel>
      )
    case 'custom-fields':
      return (
        <RecordsTable
          accountId={accountId}
          kind="custom_field"
          title="Custom Fields"
          emptyText="Custom fields from GoHighLevel show up here after the import; their values are on each contact."
          columns={[
            { label: 'Name', render: (r) => <span className="font-medium text-foreground">{r.name}</span> },
            { label: 'Key', render: (r) => <span className="font-mono text-[12px] text-muted-foreground">{rv(r, 'fieldKey')}</span> },
            { label: 'Type', render: (r) => <span className="eyebrow text-muted-foreground">{rv(r, 'dataType') || '—'}</span> },
            { label: 'Object', render: (r) => rv(r, 'model') || 'contact' },
          ]}
        />
      )
    case 'custom-values':
      return <CustomValuesPanel accountId={accountId} />
    case 'tags':
      return (
        <RecordsTable
          accountId={accountId}
          kind="tag"
          title="Tags"
          emptyText="Tags from GoHighLevel show up here after the import. Tags added in Hell-level live on the contacts."
          columns={[{ label: 'Tag', render: (r) => <Badge color="blue">{r.name}</Badge> }]}
        />
      )
    case 'companies':
      return (
        <RecordsTable
          accountId={accountId}
          kind="company"
          title="Companies"
          emptyText="Companies from GoHighLevel show up here after the import."
          columns={[
            { label: 'Name', render: (r) => <span className="font-medium text-foreground">{r.name}</span> },
            { label: 'Phone', render: (r) => rv(r, 'phone') || '—' },
            { label: 'Email', render: (r) => rv(r, 'email') || '—' },
          ]}
        />
      )
    case 'integrations':
      return (
        <Panel title="Integrations" description="Services Hell-level runs on. Twilio carries every sub-account’s calls and texts.">
          <TwilioTab />
        </Panel>
      )
    case 'import':
      return (
        <Panel title="GoHighLevel Import" description="Bring a GHL sub-account’s data across, so this one can take over from GHL.">
          <ImportPanel accountId={accountId} />
        </Panel>
      )
    case 'domains':
      return <DomainsPanel accountId={accountId} />
    case 'automation':
      return <NotYet title="Automation" what="GHL’s sub-account-wide automation settings. Hell-level’s are under Automation → Global Workflow Settings." />
    case 'calendars':
      return <NotYet title="Calendars" what="Calendar setup (availability, booking forms, notifications). Imported calendars and their appointments are under Calendars." />
    case 'email-services':
      return <NotYet title="Email Services" what="A sending domain so email to leads comes from the client’s own address. Owner notifications go out through the Hub’s Google account today." />
    case 'whatsapp':
      return <NotYet title="WhatsApp" what="WhatsApp Business messaging in Conversations." />
    case 'reputation':
      return <NotYet title="Reputation Management" what="Review request and review reply settings. Review requests already run as the “Google Review Request” workflow." />
    case 'scoring':
      return <NotYet title="Manage Scoring" what="Lead scoring rules that add points for opens, replies and visits." />
    case 'conversation-providers':
      return <NotYet title="Conversation Providers" what="Which service carries texts and email. In Hell-level that is always Twilio for texts and calls." />
    case 'labs':
      return <NotYet title="Labs" what="GHL’s beta features switchboard." />
    case 'audit-logs':
      return <NotYet title="Audit Logs" what="Who changed what in the sub-account. Hell-level logs purchases and verifications on the server for now." />
    case 'brand-boards':
      return <NotYet title="Brand Boards" what="Logos, colours and fonts for the client’s brand." />
    case 'private-integrations':
      return <NotYet title="Private Integrations" what="API keys for the sub-account. Hell-level’s own keys live in the Hub’s Vault." />
    default:
      return <NotYet title="Settings" what="Pick a settings page on the left." />
  }
}

/** Custom Values: the business-profile values automations use ({{account.*}}) and the ones imported from GHL. */
function CustomValuesPanel({ accountId }: { accountId: string }) {
  const account = useAccount(accountId)
  const p = account.data?.account.profile ?? {}
  return (
    <div className="flex flex-col">
      <Panel title="Custom Values" description="Values every automation can drop into a message. Edit Hell-level’s under Business Profile.">
        <Card>
          <Table head={['Name', 'Merge field', 'Value']}>
            {PROFILE_FIELDS.filter((f) => f.key !== 'ein').map((f) => (
              <tr key={f.key} className="border-b border-border-soft last:border-0">
                <td className="px-4 py-2.5 text-foreground">{f.label}</td>
                <td className="px-4 py-2.5 font-mono text-[12px] text-muted-foreground">{`{{${f.merge}}}`}</td>
                <td className="px-4 py-2.5 text-foreground/85">{p[f.key] || <span className="text-muted-foreground/60">not set</span>}</td>
              </tr>
            ))}
          </Table>
        </Card>
      </Panel>
      <RecordsTable
        accountId={accountId}
        kind="custom_value"
        title="From GoHighLevel"
        emptyText="Custom values from GoHighLevel show up here after the import."
        columns={[
          { label: 'Name', render: (r) => <span className="font-medium text-foreground">{r.name}</span> },
          { label: 'Key', render: (r) => <span className="font-mono text-[12px] text-muted-foreground">{rv(r, 'fieldKey')}</span> },
          { label: 'Value', render: (r) => <span className="line-clamp-2 max-w-md break-all text-foreground/85">{rv(r, 'value')}</span> },
        ]}
      />
    </div>
  )
}

function ProfileTab({ accountId }: { accountId: string }) {
  const account = useAccount(accountId)
  const a = account.data!.account
  // Re-mounts with the saved values after each save (a refill changes them server-side).
  return <ProfileForm key={JSON.stringify([a.name, a.timezone, a.profile])} accountId={accountId} a={a} />
}

function ProfileForm({ accountId, a }: { accountId: string; a: { name: string; timezone: string; clientId: string | null; profile: HlProfile } }) {
  const qc = useQueryClient()
  const [name, setName] = useState(a.name)
  const [timezone, setTimezone] = useState(a.timezone)
  const [profile, setProfile] = useState<HlProfile>(a.profile)
  const save = useMutation({
    mutationFn: (body: Record<string, unknown>) => hlFetch(`/api/hl/accounts/${accountId}`, { method: 'PATCH', json: body }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['hl', 'account', accountId] })
      qc.invalidateQueries({ queryKey: ['hl', 'accounts'] })
    },
  })
  return (
    <Card className="flex flex-col gap-5 p-6">
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Sub-account name">
          <Input value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="Timezone" hint="Delayed texts wait for daytime here">
          <Select value={timezone} onChange={(e) => setTimezone(e.target.value)}>
            {[...new Set([timezone, ...ZONES])].map((z) => (
              <option key={z} value={z}>
                {z.replace('America/', '').replace('Pacific/', '').replace('_', ' ')}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      <div className="border-t border-border pt-5">
        <p className="text-[15px] font-semibold text-foreground">Business profile</p>
        <p className="mb-4 text-[13px] text-muted-foreground">These fill the {'{{account.*}}'} fields in every automation (GHL’s custom values), and the texting verification.</p>
        <div className="grid gap-4 sm:grid-cols-2">
          {PROFILE_FIELDS.map((f) => (
            <Field key={f.key} label={f.label} hint={f.hint ?? `{{${f.merge}}}`}>
              <Input value={profile[f.key] ?? ''} onChange={(e) => setProfile({ ...profile, [f.key]: e.target.value })} />
            </Field>
          ))}
        </div>
      </div>
      <ErrorNote error={save.error} />
      <div className="flex flex-wrap justify-between gap-2 border-t border-border pt-5">
        {a.clientId ? (
          <Button loading={save.isPending && !!save.variables?.refillProfile} onClick={() => save.mutate({ refillProfile: true })} title="Fills only the blank fields">
            Fill blanks from onboarding answers
          </Button>
        ) : (
          <span />
        )}
        <Button variant="primary" loading={save.isPending && !save.variables?.refillProfile} onClick={() => save.mutate({ name, timezone, profile })}>
          Save
        </Button>
      </div>
    </Card>
  )
}

function NumbersTab({ accountId, numbers }: { accountId: string; numbers: PhoneNumberRow[] }) {
  const [buying, setBuying] = useState(false)
  return (
    <div className="flex flex-col gap-4">
      <Card className="flex flex-wrap items-center gap-4 px-5 py-4">
        <span className="grid h-10 w-10 place-items-center rounded-full bg-primary-soft text-primary">
          <Phone className="h-5 w-5" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-[14px] font-semibold text-foreground">Texting without A2P</p>
          <p className="text-[13px] text-muted-foreground">
            Toll-free numbers don’t need A2P 10DLC (or the owner’s one-time passcode). Hell-level files the toll-free verification with Twilio from this sub-account’s profile; Twilio reviews it in a few business days.
          </p>
        </div>
        <Button variant="primary" icon={<Plus className="h-4 w-4" />} onClick={() => setBuying(true)}>
          Buy a number
        </Button>
      </Card>
      {!numbers.length && <p className="px-1 text-[14px] text-muted-foreground">No numbers yet.</p>}
      {numbers.map((n) => (
        <NumberCard key={n.id} accountId={accountId} n={n} multiple={numbers.length > 1} />
      ))}
      {buying && <BuyModal accountId={accountId} onClose={() => setBuying(false)} />}
    </div>
  )
}

function NumberCard({ accountId, n, multiple }: { accountId: string; n: PhoneNumberRow; multiple: boolean }) {
  const qc = useQueryClient()
  const [forward, setForward] = useState(n.forwardTo ?? '')
  const [reviewing, setReviewing] = useState(false)
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['hl', 'account', accountId] })
    qc.invalidateQueries({ queryKey: ['hl', 'accounts'] })
  }
  const patch = useMutation({ mutationFn: (body: Record<string, unknown>) => hlFetch(`/api/hl/accounts/${accountId}/numbers/${n.id}`, { method: 'PATCH', json: body }), onSuccess: refresh })
  const release = useMutation({ mutationFn: () => hlFetch(`/api/hl/accounts/${accountId}/numbers/${n.id}`, { method: 'DELETE' }), onSuccess: refresh })
  const check = useMutation({ mutationFn: () => hlFetch<{ status: string; note: string | null }>(`/api/hl/accounts/${accountId}/numbers/${n.id}/verification?refresh=1`), onSuccess: refresh })
  const tollFree = n.kind === 'toll_free'
  return (
    <Card>
      <div className="flex flex-wrap items-center gap-3 border-b border-border px-5 py-4">
        <p className="text-[18px] font-semibold tabular-nums text-foreground">{prettyPhone(n.number)}</p>
        <Badge color={tollFree ? 'purple' : 'gray'}>{tollFree ? 'Toll-free' : 'Local'}</Badge>
        {n.isDefault && multiple && <Badge color="blue">Texts go out from this one</Badge>}
        {textingBadge(n)}
        <span className="ml-auto flex gap-2">
          {!n.isDefault && (
            <Button size="sm" onClick={() => patch.mutate({ isDefault: true })}>
              Make default
            </Button>
          )}
          <Button size="sm" variant="ghost" icon={<RefreshCw className="h-3.5 w-3.5" />} loading={patch.isPending && !!patch.variables?.repoint} onClick={() => patch.mutate({ repoint: true })} title="Point this number's text and call webhooks back at the Hub">
            Re-connect
          </Button>
        </span>
      </div>
      <div className="grid gap-5 px-5 py-4 lg:grid-cols-2">
        <div className="flex flex-col gap-3">
          <p className="text-[14px] font-semibold text-foreground">Calls</p>
          <Field label="Ring this phone" hint="Leave blank if the owner forwards their own line here when they don’t answer: then every call is a missed call and gets the text-back.">
            <div className="flex gap-2">
              <Input value={forward} onChange={(e) => setForward(e.target.value)} placeholder="(555) 123-4567" />
              <Button loading={patch.isPending && 'forwardTo' in (patch.variables ?? {})} onClick={() => patch.mutate({ forwardTo: forward })}>
                Save
              </Button>
            </div>
          </Field>
          <label className="flex items-center justify-between gap-3 rounded-lg border border-border p-3">
            <span className="text-[13.5px] text-foreground/90">
              Press a key to connect
              <span className="block text-[12px] text-muted-foreground">Whoever answers hears “press any key”. Keeps calls that hit voicemail counted as missed, so they still get the text-back.</span>
            </span>
            <Toggle checked={n.whisper} onChange={(v) => patch.mutate({ whisper: v })} label="Press a key to connect" />
          </label>
        </div>
        <div className="flex flex-col gap-3">
          <p className="text-[14px] font-semibold text-foreground">Texting</p>
          {!tollFree ? (
            <p className="text-[13px] text-muted-foreground">Local numbers need A2P 10DLC registration (with the owner’s one-time passcode), which Hell-level doesn’t do. Buy a toll-free number to text without it.</p>
          ) : n.verificationStatus === 'approved' ? (
            <p className="flex items-center gap-2 text-[13px] text-success">
              <ShieldCheck className="h-4 w-4" /> Approved by Twilio. Texts go out from this number.
            </p>
          ) : (
            <>
              <p className="text-[13px] text-muted-foreground">
                {n.verificationSid
                  ? n.verificationStatus === 'rejected'
                    ? `Rejected${n.verificationNote ? `: ${n.verificationNote}` : ''}. Fix the business profile and file again.`
                    : `Filed ${n.verificationAt ? fmtDateTime(n.verificationAt) : ''}. Twilio is reviewing it; Hell-level checks every 30 minutes. Until then, owner alerts come from the Hub’s own number and texts to leads wait.`
                  : 'Not filed yet. Review what will be sent, then file it with one click.'}
              </p>
              <div className="flex flex-wrap gap-2">
                {(!n.verificationSid || n.verificationStatus === 'rejected') && (
                  <Button variant="primary" size="sm" onClick={() => setReviewing(true)}>
                    {n.verificationStatus === 'rejected' ? 'Review and file again' : 'Review and file verification'}
                  </Button>
                )}
                {n.verificationSid && (
                  <Button size="sm" loading={check.isPending} icon={<RefreshCw className="h-3.5 w-3.5" />} onClick={() => check.mutate()}>
                    Check status
                  </Button>
                )}
              </div>
            </>
          )}
        </div>
      </div>
      <ErrorNote error={patch.error || release.error || check.error} />
      <div className="flex justify-end border-t border-border px-5 py-3">
        <button
          type="button"
          onClick={() => {
            if (window.confirm(`Release ${prettyPhone(n.number)} back to Twilio? It stops working right away and you can’t get it back.`)) release.mutate()
          }}
          className="flex items-center gap-1.5 text-[13px] font-medium text-destructive hover:underline"
        >
          <Trash2 className="h-3.5 w-3.5" /> Release number
        </button>
      </div>
      {reviewing && <VerificationModal accountId={accountId} numberId={n.id} onClose={() => setReviewing(false)} onFiled={refresh} />}
    </Card>
  )
}

function VerificationModal({ accountId, numberId, onClose, onFiled }: { accountId: string; numberId: string; onClose: () => void; onFiled: () => void }) {
  const draft = useQuery<{ request: Record<string, unknown> }>({
    queryKey: ['hl', 'verification', numberId],
    queryFn: () => hlFetch(`/api/hl/accounts/${accountId}/numbers/${numberId}/verification`),
    retry: false,
  })
  const file = useMutation({
    mutationFn: () => hlFetch<{ status: string }>(`/api/hl/accounts/${accountId}/numbers/${numberId}/verification`, { method: 'POST' }),
    onSuccess: () => {
      onFiled()
      onClose()
    },
  })
  const r = draft.data?.request ?? {}
  const rows: [string, unknown][] = [
    ['Business', r.businessName],
    ['Doing business as', r.doingBusinessAs],
    ['Type', r.businessType === 'SOLE_PROPRIETOR' ? 'Sole proprietor (no EIN on file)' : 'Private company (EIN)'],
    ['EIN', r.businessRegistrationNumber],
    ['Website', r.businessWebsite],
    ['Address', [r.businessStreetAddress, r.businessCity, r.businessStateProvinceRegion, r.businessPostalCode].filter(Boolean).join(', ')],
    ['Contact', [r.businessContactFirstName, r.businessContactLastName, r.businessContactEmail, r.businessContactPhone].filter(Boolean).join(' · ')],
    ['Use case', r.useCaseSummary],
    ['Sample message', r.productionMessageSample],
    ['Opt-in', `Website form with consent checkbox: ${(Array.isArray(r.optInImageUrls) ? r.optInImageUrls : []).join(', ')}`],
    ['Privacy policy', r.privacyPolicyUrl],
    ['Texting terms', r.termsAndConditionsUrl],
    ['Monthly volume', r.messageVolume],
  ]
  return (
    <Modal
      open
      onClose={onClose}
      title="Toll-free verification"
      description="This is what goes to Twilio. Fix anything wrong in the business profile first; nothing is needed from the client."
      width="max-w-2xl"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={file.isPending} disabled={!draft.data} onClick={() => file.mutate()}>
            File with Twilio
          </Button>
        </>
      }
    >
      {draft.isLoading ? (
        <Spinner />
      ) : draft.error ? (
        <ErrorNote error={draft.error} />
      ) : (
        <dl className="grid gap-x-4 gap-y-2.5 text-[13px] sm:grid-cols-[150px_1fr]">
          {rows
            .filter(([, v]) => v)
            .map(([k, v]) => (
              <div key={k} className="contents">
                <dt className="font-medium text-muted-foreground">{k}</dt>
                <dd className="whitespace-pre-wrap break-words text-foreground">{String(v)}</dd>
              </div>
            ))}
        </dl>
      )}
      <div className="mt-4">
        <ErrorNote error={file.error} />
      </div>
    </Modal>
  )
}

function BuyModal({ accountId, onClose }: { accountId: string; onClose: () => void }) {
  const qc = useQueryClient()
  const [kind, setKind] = useState<'toll_free' | 'local'>('toll_free')
  const [areaCode, setAreaCode] = useState('')
  const [contains, setContains] = useState('')
  const [pick, setPick] = useState<string | null>(null)
  const search = useMutation({
    mutationFn: () =>
      hlFetch<{ available: { number: string; friendly: string; locality: string | null; region: string | null }[] }>(
        `/api/hl/accounts/${accountId}/numbers?search=1&kind=${kind}&areaCode=${encodeURIComponent(areaCode)}&contains=${encodeURIComponent(contains)}`,
      ),
  })
  const buy = useMutation({
    mutationFn: () => hlFetch(`/api/hl/accounts/${accountId}/numbers`, { method: 'POST', json: { number: pick, kind } }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['hl', 'account', accountId] })
      qc.invalidateQueries({ queryKey: ['hl', 'accounts'] })
      onClose()
    },
  })
  return (
    <Modal
      open
      onClose={onClose}
      title="Buy a number"
      description="Bought on the Hub’s Twilio account: a monthly fee per number plus per-text and per-minute charges."
      width="max-w-xl"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={buy.isPending} disabled={!pick} onClick={() => buy.mutate()}>
            {pick ? `Buy ${prettyPhone(pick)}` : 'Pick a number'}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <div className="grid grid-cols-2 gap-2">
          {(['toll_free', 'local'] as const).map((k) => (
            <button
              key={k}
              type="button"
              onClick={() => {
                setKind(k)
                setPick(null)
                search.reset()
              }}
              className={`rounded-lg border p-3 text-left transition ${kind === k ? 'border-primary bg-primary-soft ring-2 ring-primary/20' : 'border-border hover:bg-muted/50'}`}
            >
              <p className="text-[14px] font-semibold text-foreground">{k === 'toll_free' ? 'Toll-free (recommended)' : 'Local'}</p>
              <p className="text-[12px] text-muted-foreground">{k === 'toll_free' ? 'Texts after a verification Hell-level files. No A2P.' : 'Local area code, but texting needs A2P 10DLC.'}</p>
            </button>
          ))}
        </div>
        <div className="flex gap-2">
          {kind === 'local' && <Input value={areaCode} onChange={(e) => setAreaCode(e.target.value)} placeholder="Area code" className="w-32" />}
          <Input value={contains} onChange={(e) => setContains(e.target.value)} placeholder="Contains digits (optional)" />
          <Button loading={search.isPending} onClick={() => search.mutate()}>
            Search
          </Button>
        </div>
        <ErrorNote error={search.error || buy.error} />
        {search.data && (
          <div className="max-h-72 overflow-y-auto rounded-lg border border-border">
            {search.data.available.map((n) => (
              <label key={n.number} className={`flex cursor-pointer items-center gap-3 border-b border-border px-3 py-2.5 last:border-0 ${pick === n.number ? 'bg-primary-soft' : 'hover:bg-muted/50'}`}>
                <input type="radio" name="num" checked={pick === n.number} onChange={() => setPick(n.number)} />
                <span className="font-semibold tabular-nums text-foreground">{prettyPhone(n.number)}</span>
                <span className="text-[12px] text-muted-foreground">{[n.locality, n.region].filter(Boolean).join(', ')}</span>
              </label>
            ))}
            {!search.data.available.length && <p className="px-3 py-6 text-center text-[13px] text-muted-foreground">Nothing found. Try other digits.</p>}
          </div>
        )}
      </div>
    </Modal>
  )
}

type TwilioInfo = {
  ok: boolean
  error: string | null
  accountName: string | null
  accountStatus: string | null
  profiles: { sid: string; name: string; status: string }[]
  hubNumber: string | null
  settings: { customerProfileSid?: string; notificationEmail?: string }
}

function TwilioTab() {
  const q = useQuery<TwilioInfo>({ queryKey: ['hl', 'twilio'], queryFn: () => hlFetch('/api/hl/settings/twilio') })
  if (!q.data) return <div className="flex justify-center py-10">{q.error ? <ErrorNote error={q.error} /> : <Spinner />}</div>
  return <TwilioForm d={q.data} />
}

function TwilioForm({ d }: { d: TwilioInfo }) {
  const qc = useQueryClient()
  const [profileSid, setProfileSid] = useState(d.settings.customerProfileSid ?? '')
  const [email, setEmail] = useState(d.settings.notificationEmail ?? '')
  const save = useMutation({
    mutationFn: () => hlFetch('/api/hl/settings/twilio', { method: 'PUT', json: { customerProfileSid: profileSid, notificationEmail: email } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['hl', 'twilio'] }),
  })
  const approved = d.profiles.filter((p) => p.status === 'twilio-approved')
  return (
    <Card className="flex flex-col gap-5 p-6">
      <div>
        <p className="text-[15px] font-semibold text-foreground">Twilio account</p>
        <p className="mt-1 text-[14px] text-muted-foreground">{d.ok ? `${d.accountName ?? 'Connected'} (${d.accountStatus ?? 'active'}). Shared by every sub-account.` : `Not reachable: ${d.error}`}</p>
        {d.hubNumber && <p className="mt-1 text-[13px] text-muted-foreground">Hub number for owner alerts until a sub-account’s own number is approved: {prettyPhone(d.hubNumber)}</p>}
      </div>
      <div className="border-t border-border pt-5">
        <p className="text-[15px] font-semibold text-foreground">Genisys business profile (Trust Hub)</p>
        <p className="mt-1 text-[13px] text-muted-foreground">
          Twilio only accepts toll-free verifications from an account with an approved business profile. One-time setup in the Twilio Console: Trust Hub → Customer Profiles → create the Primary Business Profile for Genisys (pick “ISV / Reseller”, since you send for clients) and wait for “Twilio Approved”.
        </p>
        <div className="mt-3 flex flex-col gap-2">
          {d.profiles.map((p) => (
            <div key={p.sid} className="flex items-center justify-between rounded-lg border border-border px-3 py-2 text-[13px]">
              <span>
                <span className="font-medium text-foreground">{p.name}</span> <span className="text-muted-foreground/70">{p.sid}</span>
              </span>
              <Badge color={p.status === 'twilio-approved' ? 'green' : p.status === 'twilio-rejected' ? 'red' : 'amber'}>{p.status}</Badge>
            </div>
          ))}
          {!d.profiles.length && <p className="text-[13px] text-warning">No business profiles on the Twilio account yet.</p>}
        </div>
      </div>
      <div className="grid gap-4 border-t border-border pt-5 sm:grid-cols-2">
        <Field label="Profile to file under" hint="Blank = the first approved one">
          <Select value={profileSid} onChange={(e) => setProfileSid(e.target.value)}>
            <option value="">{approved.length ? 'First approved profile' : 'None approved yet'}</option>
            {d.profiles.map((p) => (
              <option key={p.sid} value={p.sid}>
                {p.name} ({p.status})
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Verification updates go to" hint="Twilio emails approvals and rejections here">
          <Input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="alex@leadgenisys.com" />
        </Field>
      </div>
      <ErrorNote error={save.error} />
      <div className="flex justify-end">
        <Button variant="primary" loading={save.isPending} onClick={() => save.mutate()}>
          Save
        </Button>
      </div>
    </Card>
  )
}
