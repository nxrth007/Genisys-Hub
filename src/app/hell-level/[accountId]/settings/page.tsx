'use client'

import { Suspense, useState } from 'react'
import { useParams, useRouter, useSearchParams } from 'next/navigation'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowDown, ArrowUp, Phone, Plus, RefreshCw, ShieldCheck, Trash2 } from 'lucide-react'
import { prettyPhone } from '@/lib/hl/merge'
import { PROFILE_FIELDS, type HlProfile, type HlStage } from '@/lib/hl/types'
import { textingBadge, useAccount, type PhoneNumberRow } from '@/components/hell-level/bits'
import { Badge, Button, Card, ErrorNote, Field, Input, Modal, PageHeader, Select, Spinner, Tabs, Toggle, fmtDateTime, hlFetch } from '@/components/hell-level/ui'

type Tab = 'profile' | 'numbers' | 'pipelines' | 'twilio'

const ZONES = ['America/New_York', 'America/Chicago', 'America/Denver', 'America/Phoenix', 'America/Los_Angeles', 'America/Anchorage', 'Pacific/Honolulu']

export default function SettingsPage() {
  return (
    <Suspense fallback={<div className="flex justify-center py-24"><Spinner /></div>}>
      <Settings />
    </Suspense>
  )
}

function Settings() {
  const { accountId } = useParams<{ accountId: string }>()
  const sp = useSearchParams()
  const router = useRouter()
  const initial = (sp.get('tab') as Tab) || 'profile'
  const [tab, setTab] = useState<Tab>(['profile', 'numbers', 'pipelines', 'twilio'].includes(initial) ? initial : 'profile')
  const account = useAccount(accountId)
  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-5 px-6 py-7">
      <PageHeader title="Settings" description="This sub-account’s business profile, phone numbers and pipelines." />
      <Tabs
        tabs={[
          { key: 'profile', label: 'Business Profile' },
          { key: 'numbers', label: 'Phone Numbers' },
          { key: 'pipelines', label: 'Pipelines' },
          { key: 'twilio', label: 'Twilio (agency)' },
        ]}
        value={tab}
        onChange={(t) => {
          setTab(t)
          router.replace(`/hell-level/${accountId}/settings?tab=${t}`)
        }}
      />
      {account.isLoading ? (
        <div className="flex justify-center py-16">
          <Spinner />
        </div>
      ) : !account.data ? (
        <ErrorNote error={account.error} />
      ) : tab === 'profile' ? (
        <ProfileTab accountId={accountId} />
      ) : tab === 'numbers' ? (
        <NumbersTab accountId={accountId} numbers={account.data.numbers} />
      ) : tab === 'pipelines' ? (
        <PipelinesTab accountId={accountId} />
      ) : (
        <TwilioTab />
      )}
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
      <div className="border-t border-[#EAECF0] pt-5">
        <p className="text-[15px] font-semibold text-[#101828]">Business profile</p>
        <p className="mb-4 text-[13px] text-[#667085]">These fill the {'{{account.*}}'} fields in every automation (GHL’s custom values), and the texting verification.</p>
        <div className="grid gap-4 sm:grid-cols-2">
          {PROFILE_FIELDS.map((f) => (
            <Field key={f.key} label={f.label} hint={f.hint ?? `{{${f.merge}}}`}>
              <Input value={profile[f.key] ?? ''} onChange={(e) => setProfile({ ...profile, [f.key]: e.target.value })} />
            </Field>
          ))}
        </div>
      </div>
      <ErrorNote error={save.error} />
      <div className="flex flex-wrap justify-between gap-2 border-t border-[#EAECF0] pt-5">
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
        <span className="grid h-10 w-10 place-items-center rounded-full bg-[#EFF4FF] text-[#155EEF]">
          <Phone className="h-5 w-5" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-[14px] font-semibold text-[#101828]">Texting without A2P</p>
          <p className="text-[13px] text-[#475467]">
            Toll-free numbers don’t need A2P 10DLC (or the owner’s one-time passcode). Hell-level files the toll-free verification with Twilio from this sub-account’s profile; Twilio reviews it in a few business days.
          </p>
        </div>
        <Button variant="primary" icon={<Plus className="h-4 w-4" />} onClick={() => setBuying(true)}>
          Buy a number
        </Button>
      </Card>
      {!numbers.length && <p className="px-1 text-[14px] text-[#667085]">No numbers yet.</p>}
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
      <div className="flex flex-wrap items-center gap-3 border-b border-[#EAECF0] px-5 py-4">
        <p className="text-[18px] font-semibold tabular-nums text-[#101828]">{prettyPhone(n.number)}</p>
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
          <p className="text-[14px] font-semibold text-[#101828]">Calls</p>
          <Field label="Ring this phone" hint="Leave blank if the owner forwards their own line here when they don’t answer: then every call is a missed call and gets the text-back.">
            <div className="flex gap-2">
              <Input value={forward} onChange={(e) => setForward(e.target.value)} placeholder="(555) 123-4567" />
              <Button loading={patch.isPending && 'forwardTo' in (patch.variables ?? {})} onClick={() => patch.mutate({ forwardTo: forward })}>
                Save
              </Button>
            </div>
          </Field>
          <label className="flex items-center justify-between gap-3 rounded-lg border border-[#EAECF0] p-3">
            <span className="text-[13.5px] text-[#344054]">
              Press a key to connect
              <span className="block text-[12px] text-[#667085]">Whoever answers hears “press any key”. Keeps calls that hit voicemail counted as missed, so they still get the text-back.</span>
            </span>
            <Toggle checked={n.whisper} onChange={(v) => patch.mutate({ whisper: v })} label="Press a key to connect" />
          </label>
        </div>
        <div className="flex flex-col gap-3">
          <p className="text-[14px] font-semibold text-[#101828]">Texting</p>
          {!tollFree ? (
            <p className="text-[13px] text-[#475467]">Local numbers need A2P 10DLC registration (with the owner’s one-time passcode), which Hell-level doesn’t do. Buy a toll-free number to text without it.</p>
          ) : n.verificationStatus === 'approved' ? (
            <p className="flex items-center gap-2 text-[13px] text-[#067647]">
              <ShieldCheck className="h-4 w-4" /> Approved by Twilio. Texts go out from this number.
            </p>
          ) : (
            <>
              <p className="text-[13px] text-[#475467]">
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
      <div className="flex justify-end border-t border-[#EAECF0] px-5 py-3">
        <button
          type="button"
          onClick={() => {
            if (window.confirm(`Release ${prettyPhone(n.number)} back to Twilio? It stops working right away and you can’t get it back.`)) release.mutate()
          }}
          className="flex items-center gap-1.5 text-[13px] font-medium text-[#D92D20] hover:underline"
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
                <dt className="font-medium text-[#475467]">{k}</dt>
                <dd className="whitespace-pre-wrap break-words text-[#101828]">{String(v)}</dd>
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
              className={`rounded-lg border p-3 text-left transition ${kind === k ? 'border-[#155EEF] bg-[#F5F8FF] ring-2 ring-[#155EEF]/15' : 'border-[#EAECF0] hover:bg-[#F9FAFB]'}`}
            >
              <p className="text-[14px] font-semibold text-[#101828]">{k === 'toll_free' ? 'Toll-free (recommended)' : 'Local'}</p>
              <p className="text-[12px] text-[#667085]">{k === 'toll_free' ? 'Texts after a verification Hell-level files. No A2P.' : 'Local area code, but texting needs A2P 10DLC.'}</p>
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
          <div className="max-h-72 overflow-y-auto rounded-lg border border-[#EAECF0]">
            {search.data.available.map((n) => (
              <label key={n.number} className={`flex cursor-pointer items-center gap-3 border-b border-[#EAECF0] px-3 py-2.5 last:border-0 ${pick === n.number ? 'bg-[#EFF4FF]' : 'hover:bg-[#F9FAFB]'}`}>
                <input type="radio" name="num" checked={pick === n.number} onChange={() => setPick(n.number)} />
                <span className="font-semibold tabular-nums text-[#101828]">{prettyPhone(n.number)}</span>
                <span className="text-[12px] text-[#667085]">{[n.locality, n.region].filter(Boolean).join(', ')}</span>
              </label>
            ))}
            {!search.data.available.length && <p className="px-3 py-6 text-center text-[13px] text-[#667085]">Nothing found. Try other digits.</p>}
          </div>
        )}
      </div>
    </Modal>
  )
}

function PipelinesTab({ accountId }: { accountId: string }) {
  const qc = useQueryClient()
  const q = useQuery<{ pipelines: { id: string; name: string; stages: HlStage[]; opportunities: unknown[] }[] }>({
    queryKey: ['hl', 'pipelines', accountId],
    queryFn: () => hlFetch(`/api/hl/accounts/${accountId}/pipelines`),
  })
  const add = useMutation({
    mutationFn: () => hlFetch(`/api/hl/accounts/${accountId}/pipelines`, { method: 'POST', json: { name: 'New pipeline', stages: [{ name: 'New' }, { name: 'In progress' }, { name: 'Done' }] } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['hl', 'pipelines', accountId] }),
  })
  if (!q.data) return <div className="flex justify-center py-10">{q.error ? <ErrorNote error={q.error} /> : <Spinner />}</div>
  return (
    <div className="flex flex-col gap-4">
      {q.data.pipelines.map((p) => (
        <PipelineEditor key={p.id} accountId={accountId} pipeline={p} canDelete={q.data!.pipelines.length > 1} />
      ))}
      <Button icon={<Plus className="h-4 w-4" />} loading={add.isPending} onClick={() => add.mutate()} className="self-start">
        Add pipeline
      </Button>
      <ErrorNote error={add.error} />
    </div>
  )
}

function PipelineEditor({ accountId, pipeline, canDelete }: { accountId: string; pipeline: { id: string; name: string; stages: HlStage[]; opportunities: unknown[] }; canDelete: boolean }) {
  const qc = useQueryClient()
  const [name, setName] = useState(pipeline.name)
  const [stages, setStages] = useState<{ id?: string; name: string }[]>(pipeline.stages)
  const save = useMutation({
    mutationFn: () => hlFetch(`/api/hl/accounts/${accountId}/pipelines/${pipeline.id}`, { method: 'PATCH', json: { name, stages } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['hl', 'pipelines', accountId] }),
  })
  const del = useMutation({
    mutationFn: () => hlFetch(`/api/hl/accounts/${accountId}/pipelines/${pipeline.id}`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['hl', 'pipelines', accountId] }),
  })
  const move = (i: number, d: -1 | 1) =>
    setStages((s) => {
      const next = [...s]
      const j = i + d
      if (j < 0 || j >= next.length) return s
      ;[next[i], next[j]] = [next[j], next[i]]
      return next
    })
  return (
    <Card className="flex flex-col gap-4 p-5">
      <div className="flex items-center gap-3">
        <Input value={name} onChange={(e) => setName(e.target.value)} className="max-w-sm font-semibold" />
        <span className="text-[13px] text-[#667085]">{pipeline.opportunities.length} opportunities</span>
      </div>
      <div className="flex flex-col gap-2">
        {stages.map((s, i) => (
          <div key={s.id ?? `new-${i}`} className="flex items-center gap-2">
            <span className="w-6 text-right text-[12px] text-[#98A2B3]">{i + 1}</span>
            <Input value={s.name} onChange={(e) => setStages((all) => all.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} className="max-w-md" />
            <button type="button" onClick={() => move(i, -1)} className="grid h-8 w-8 place-items-center rounded-md hover:bg-[#F2F4F7]" title="Move up">
              <ArrowUp className="h-3.5 w-3.5" />
            </button>
            <button type="button" onClick={() => move(i, 1)} className="grid h-8 w-8 place-items-center rounded-md hover:bg-[#F2F4F7]" title="Move down">
              <ArrowDown className="h-3.5 w-3.5" />
            </button>
            <button type="button" onClick={() => setStages((all) => all.filter((_, j) => j !== i))} className="grid h-8 w-8 place-items-center rounded-md text-[#D92D20] hover:bg-[#FEF3F2]" title="Remove stage">
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          </div>
        ))}
        <Button size="sm" icon={<Plus className="h-3.5 w-3.5" />} className="self-start" onClick={() => setStages((s) => [...s, { name: 'New stage' }])}>
          Add stage
        </Button>
      </div>
      <ErrorNote error={save.error || del.error} />
      <div className="flex justify-between border-t border-[#EAECF0] pt-4">
        {canDelete ? (
          <Button variant="ghost" className="text-[#D92D20]" loading={del.isPending} onClick={() => window.confirm(`Delete the “${pipeline.name}” pipeline?`) && del.mutate()}>
            Delete pipeline
          </Button>
        ) : (
          <span />
        )}
        <Button variant="primary" loading={save.isPending} onClick={() => save.mutate()}>
          Save pipeline
        </Button>
      </div>
    </Card>
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
        <p className="text-[15px] font-semibold text-[#101828]">Twilio account</p>
        <p className="mt-1 text-[14px] text-[#475467]">{d.ok ? `${d.accountName ?? 'Connected'} (${d.accountStatus ?? 'active'}). Shared by every sub-account.` : `Not reachable: ${d.error}`}</p>
        {d.hubNumber && <p className="mt-1 text-[13px] text-[#667085]">Hub number for owner alerts until a sub-account’s own number is approved: {prettyPhone(d.hubNumber)}</p>}
      </div>
      <div className="border-t border-[#EAECF0] pt-5">
        <p className="text-[15px] font-semibold text-[#101828]">Genisys business profile (Trust Hub)</p>
        <p className="mt-1 text-[13px] text-[#475467]">
          Twilio only accepts toll-free verifications from an account with an approved business profile. One-time setup in the Twilio Console: Trust Hub → Customer Profiles → create the Primary Business Profile for Genisys (pick “ISV / Reseller”, since you send for clients) and wait for “Twilio Approved”.
        </p>
        <div className="mt-3 flex flex-col gap-2">
          {d.profiles.map((p) => (
            <div key={p.sid} className="flex items-center justify-between rounded-lg border border-[#EAECF0] px-3 py-2 text-[13px]">
              <span>
                <span className="font-medium text-[#101828]">{p.name}</span> <span className="text-[#98A2B3]">{p.sid}</span>
              </span>
              <Badge color={p.status === 'twilio-approved' ? 'green' : p.status === 'twilio-rejected' ? 'red' : 'amber'}>{p.status}</Badge>
            </div>
          ))}
          {!d.profiles.length && <p className="text-[13px] text-[#B54708]">No business profiles on the Twilio account yet.</p>}
        </div>
      </div>
      <div className="grid gap-4 border-t border-[#EAECF0] pt-5 sm:grid-cols-2">
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
