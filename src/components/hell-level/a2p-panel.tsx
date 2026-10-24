'use client'

import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, CheckCircle2, Circle, Loader2, Plus, RefreshCw, ShieldCheck, Trash2, XCircle } from 'lucide-react'
import { prettyPhone } from '@/lib/hl/merge'
import { cn } from '@/lib/utils'
import {
  A2P_FEES,
  BUSINESS_TYPES,
  INDUSTRIES,
  JOB_POSITIONS,
  LIMITS,
  US_STATES,
  detailProblems,
  feeLine,
  industryLabel,
  stageText,
  type A2pCheck,
  type A2pDetails,
  type A2pPath,
  type A2pView,
} from '@/lib/hl/a2p-shared'
import { Button, ErrorNote, Field, Input, Modal, Select, Spinner, Textarea, Toggle, fmtDateTime, hlFetch } from './ui'

/**
 * A local number's Texting panel: A2P 10DLC registration, filed by
 * Hell-level with Twilio (src/lib/hl/a2p.ts). One registration covers every
 * local number on the sub-account.
 */

type Draft = { a2p: A2pView | null; details: A2pDetails; legal: { privacy: string; terms: string }; formUrls: string[]; smsBox: string | null; marketingBox: string | null }

const ORDER = ['profile', 'brand', 'otp', 'campaign', 'approved'] as const

function useRefresh(accountId: string) {
  const qc = useQueryClient()
  return () => {
    qc.invalidateQueries({ queryKey: ['hl', 'a2p', accountId] })
    qc.invalidateQueries({ queryKey: ['hl', 'account', accountId] })
    qc.invalidateQueries({ queryKey: ['hl', 'accounts'] })
  }
}

function Steps({ v }: { v: A2pView }) {
  const steps = [
    { key: 'profile', label: 'Business profile' },
    { key: 'brand', label: 'Brand' },
    ...(v.path === 'sole_prop' ? [{ key: 'otp', label: 'Owner’s YES' }] : []),
    { key: 'campaign', label: 'Campaign' },
    { key: 'approved', label: 'Live' },
  ]
  const at = ORDER.indexOf(v.stage as (typeof ORDER)[number])
  return (
    <ol className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px]">
      {steps.map((s, i) => {
        const idx = ORDER.indexOf(s.key as (typeof ORDER)[number])
        const done = idx < at || v.stage === 'approved'
        const now = idx === at && v.stage !== 'approved'
        return (
          <li key={s.key} className="flex items-center gap-1.5">
            {done ? <CheckCircle2 className="h-3.5 w-3.5 text-success" /> : now ? <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" /> : <Circle className="h-3.5 w-3.5 text-muted-foreground/60" />}
            <span className={cn(done || now ? 'text-foreground' : 'text-muted-foreground')}>{s.label}</span>
            {i < steps.length - 1 && <span className="text-muted-foreground/40">→</span>}
          </li>
        )
      })}
    </ol>
  )
}

/** The Texting column of a local number's card. */
export function A2pTexting({ accountId, number }: { accountId: string; number: string }) {
  const refresh = useRefresh(accountId)
  const [open, setOpen] = useState(false)
  const q = useQuery<{ a2p: A2pView | null }>({ queryKey: ['hl', 'a2p', accountId], queryFn: () => hlFetch(`/api/hl/accounts/${accountId}/a2p`) })
  const check = useMutation({ mutationFn: () => hlFetch(`/api/hl/accounts/${accountId}/a2p?refresh=1`), onSuccess: refresh })
  const resend = useMutation({ mutationFn: () => hlFetch(`/api/hl/accounts/${accountId}/a2p`, { method: 'POST', json: { action: 'resend' } }) })
  if (q.isLoading) return <Spinner />
  const v = q.data?.a2p ?? null
  const modal = open && <A2pModal accountId={accountId} onClose={() => setOpen(false)} onFiled={refresh} />

  if (!v || v.stage === 'draft') {
    return (
      <>
        <p className="text-[13px] text-muted-foreground">
          Local numbers text after an A2P 10DLC registration. Hell-level files it with Twilio from this sub-account’s details: {feeLine('low_volume').text}. No code is needed from the owner when the business has an EIN.
        </p>
        <div>
          <Button variant="primary" size="sm" onClick={() => setOpen(true)}>
            Register for A2P
          </Button>
        </div>
        <ErrorNote error={q.error} />
        {modal}
      </>
    )
  }
  if (v.stage === 'approved') {
    const covered = v.numbers.includes(number)
    return (
      <>
        <p className={cn('flex items-center gap-2 text-[13px]', covered ? 'text-success' : 'text-muted-foreground')}>
          <ShieldCheck className="h-4 w-4" />
          {covered ? 'A2P approved by the carriers. Texts go out from this number.' : `A sole proprietor’s campaign covers one number: ${v.numbers.map(prettyPhone).join(', ')} texts; this one doesn’t.`}
        </p>
        {modal}
      </>
    )
  }
  if (v.stage === 'failed') {
    return (
      <>
        <p className="flex items-start gap-2 text-[13px] text-destructive">
          <XCircle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{v.note || 'The registration was rejected.'}</span>
        </p>
        <div className="flex flex-wrap gap-2">
          <Button variant="primary" size="sm" onClick={() => setOpen(true)}>
            Fix and file again
          </Button>
        </div>
        {modal}
      </>
    )
  }
  return (
    <>
      <Steps v={v} />
      <p className="text-[13px] text-muted-foreground">
        {stageText(v)}
        {v.filedAt && ` Filed ${fmtDateTime(v.filedAt)}.`}
      </p>
      {v.stage === 'otp' && v.otpPhone && <p className="text-[13px] text-warning">Tell the owner to look for the text on {prettyPhone(v.otpPhone)} and reply YES.</p>}
      {v.note && <p className="text-[12px] text-muted-foreground">{v.note}</p>}
      <div className="flex flex-wrap gap-2">
        <Button size="sm" loading={check.isPending} icon={<RefreshCw className="h-3.5 w-3.5" />} onClick={() => check.mutate()}>
          Check status
        </Button>
        {v.stage === 'otp' && (
          <Button size="sm" loading={resend.isPending} onClick={() => resend.mutate()}>
            {resend.isSuccess ? 'Text sent again' : 'Text the owner again'}
          </Button>
        )}
      </div>
      <ErrorNote error={check.error || resend.error} />
      {modal}
    </>
  )
}

function A2pModal({ accountId, onClose, onFiled }: { accountId: string; onClose: () => void; onFiled: () => void }) {
  const draft = useQuery<Draft>({ queryKey: ['hl', 'a2p-draft', accountId], queryFn: () => hlFetch(`/api/hl/accounts/${accountId}/a2p?draft=1`), retry: false, staleTime: 0, gcTime: 0 })
  if (!draft.data) {
    return (
      <Modal open onClose={onClose} title="Register for A2P" width="max-w-3xl">
        {draft.error ? <ErrorNote error={draft.error} /> : <Spinner />}
      </Modal>
    )
  }
  return <A2pForm accountId={accountId} draft={draft.data} onClose={onClose} onFiled={onFiled} />
}

const CHECK_ICON = {
  ok: <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-success" />,
  warning: <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" />,
  error: <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />,
}

function Section({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-3 border-t border-border pt-4 first:border-0 first:pt-0">
      <div>
        <p className="text-[14px] font-semibold text-foreground">{title}</p>
        {hint && <p className="text-[12.5px] text-muted-foreground">{hint}</p>}
      </div>
      {children}
    </section>
  )
}

function Count({ n, max }: { n: number; max: number }) {
  return <span className={cn('font-mono text-[11px] tabular-nums', n > max ? 'text-destructive' : 'text-muted-foreground')}>{`${n}/${max}`}</span>
}

function A2pForm({ accountId, draft, onClose, onFiled }: { accountId: string; draft: Draft; onClose: () => void; onFiled: () => void }) {
  const [d, setD] = useState<A2pDetails>(draft.details)
  const [run, setRun] = useState(0)
  const set = (patch: Partial<A2pDetails>) => setD({ ...d, ...patch })
  const sole = d.path === 'sole_prop'
  const checks = useQuery<{ checks: A2pCheck[] }>({
    queryKey: ['hl', 'a2p-check', accountId, run],
    queryFn: () => hlFetch(`/api/hl/accounts/${accountId}/a2p`, { method: 'POST', json: { action: 'check', details: d } }),
    retry: false,
    staleTime: Infinity,
    gcTime: 0,
  })
  const file = useMutation({
    mutationFn: () => hlFetch<{ a2p: A2pView }>(`/api/hl/accounts/${accountId}/a2p`, { method: 'POST', json: { action: 'file', details: d } }),
    onSuccess: () => {
      onFiled()
      onClose()
    },
  })
  // Missing fields are judged live (problems); the pre-check's own errors are about the live pages and the form.
  const problems = detailProblems(d)
  const blocking = (checks.data?.checks ?? []).filter((c) => c.level === 'error' && !c.key.startsWith('detail-'))
  const fee = feeLine(d.path)
  const refiling = draft.a2p?.stage === 'failed'

  return (
    <Modal
      open
      onClose={onClose}
      title={refiling ? 'Fix and file the A2P registration again' : 'Register for A2P'}
      description="What goes to Twilio for this business. It covers every local number on the sub-account. Hell-level checks the website, policies and form first, the way reviewers do."
      width="max-w-3xl"
      footer={
        <div className="flex w-full flex-wrap items-center justify-between gap-3">
          <p className="text-[12.5px] text-muted-foreground">
            {refiling ? 'Resubmitting a rejected brand or campaign is free up to three times.' : `Twilio charges ${fee.text}.`}
          </p>
          <div className="flex gap-2">
            <Button onClick={onClose}>Cancel</Button>
            <Button variant="primary" loading={file.isPending} disabled={problems.length > 0 || blocking.length > 0 || checks.isFetching} onClick={() => file.mutate()}>
              {refiling ? 'File again' : `File A2P registration · ${fee.now}`}
            </Button>
          </div>
        </div>
      }
    >
      <div className="flex flex-col gap-5">
        <Section title="Registration">
          <div className="grid gap-2 sm:grid-cols-3">
            {(Object.keys(A2P_FEES) as A2pPath[]).map((p) => (
              <button
                key={p}
                type="button"
                onClick={() => set({ path: p })}
                className={cn('rounded-lg border p-3 text-left transition', d.path === p ? 'border-primary bg-primary-soft ring-2 ring-primary/20' : 'border-border hover:bg-muted/50')}
              >
                <p className="text-[13.5px] font-semibold text-foreground">{A2P_FEES[p].label}</p>
                <p className="mt-0.5 text-[12px] text-muted-foreground">{A2P_FEES[p].hint}</p>
                <p className="mt-1.5 font-mono text-[11.5px] text-foreground/80">
                  {feeLine(p).now} once · {feeLine(p).monthly}/mo
                </p>
              </button>
            ))}
          </div>
        </Section>

        <Section title="Business" hint={sole ? undefined : 'The registry checks these against IRS records.'}>
          <div className="grid gap-3 sm:grid-cols-2">
            {sole ? (
              <Field label="Brand name" hint="The business name, or the owner’s name if there’s none" className="sm:col-span-2">
                <Input value={d.brandName} onChange={(e) => set({ brandName: e.target.value })} />
              </Field>
            ) : (
              <>
                <Field label="Legal business name" hint="Exactly as on the IRS EIN letter (CP 575), with LLC or Inc." className="sm:col-span-2">
                  <Input value={d.legalName} onChange={(e) => set({ legalName: e.target.value })} />
                </Field>
                <Field label="Business type">
                  <Select value={d.businessType} onChange={(e) => set({ businessType: e.target.value })}>
                    {BUSINESS_TYPES.map((t) => (
                      <option key={t} value={t}>
                        {t === 'Limited Liability Corporation' ? 'LLC' : t}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label="EIN">
                  <Input value={d.ein} onChange={(e) => set({ ein: e.target.value })} placeholder="12-3456789" />
                </Field>
                <Field label="Industry">
                  <Select value={d.industry} onChange={(e) => set({ industry: e.target.value })}>
                    {INDUSTRIES.map((i) => (
                      <option key={i} value={i}>
                        {industryLabel(i)}
                      </option>
                    ))}
                  </Select>
                </Field>
              </>
            )}
            <Field label="Website" hint="The home page, as it loads (no redirect)" className={sole ? 'sm:col-span-2' : undefined}>
              <Input value={d.website} onChange={(e) => set({ website: e.target.value })} placeholder="https://example.com" />
            </Field>
            <Field label="Street address" className="sm:col-span-2">
              <Input value={d.street} onChange={(e) => set({ street: e.target.value })} />
            </Field>
            <Field label="City">
              <Input value={d.city} onChange={(e) => set({ city: e.target.value })} />
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="State">
                <Select value={d.state} onChange={(e) => set({ state: e.target.value })}>
                  <option value="">—</option>
                  {US_STATES.map((s) => (
                    <option key={s} value={s}>
                      {s}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="ZIP">
                <Input value={d.zip} onChange={(e) => set({ zip: e.target.value })} />
              </Field>
            </div>
          </div>
        </Section>

        <Section title={sole ? 'Owner' : 'Authorized representative'} hint={sole ? undefined : 'Someone at the business who can speak for it, usually the owner.'}>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="First name">
              <Input value={d.firstName} onChange={(e) => set({ firstName: e.target.value })} />
            </Field>
            <Field label="Last name">
              <Input value={d.lastName} onChange={(e) => set({ lastName: e.target.value })} />
            </Field>
            {!sole && (
              <>
                <Field label="Job title">
                  <Input value={d.title} onChange={(e) => set({ title: e.target.value })} placeholder="Owner" />
                </Field>
                <Field label="Position">
                  <Select value={d.position} onChange={(e) => set({ position: e.target.value })}>
                    {JOB_POSITIONS.map((p) => (
                      <option key={p} value={p}>
                        {p}
                      </option>
                    ))}
                  </Select>
                </Field>
              </>
            )}
            <Field label="Email" hint={sole ? undefined : 'An address on the business’s own domain goes through more smoothly'}>
              <Input value={d.email} onChange={(e) => set({ email: e.target.value })} />
            </Field>
            <Field label={sole ? 'Owner’s cell' : 'Phone'} hint={sole ? 'The registry texts it from (915) 278-2000 and they reply YES within 24 hours. Not a Twilio or Google Voice number.' : undefined}>
              <Input value={d.phone} onChange={(e) => set({ phone: e.target.value })} placeholder="(555) 123-4567" />
            </Field>
          </div>
        </Section>

        <Section title="Campaign" hint="Written from this sub-account’s forms and policy pages. Reviewers compare it with the live site, so keep it true.">
          <Field label={<span className="flex w-full justify-between">What the texts are for <Count n={d.description.length} max={LIMITS.description[1]} /></span>}>
            <Textarea rows={5} value={d.description} onChange={(e) => set({ description: e.target.value })} />
          </Field>
          <Field label={<span className="flex w-full justify-between">How people opt in <Count n={d.messageFlow.length} max={LIMITS.messageFlow[1]} /></span>} hint="Quotes the form’s checkbox word for word">
            <Textarea rows={6} value={d.messageFlow} onChange={(e) => set({ messageFlow: e.target.value })} />
          </Field>
          <div className="flex flex-col gap-2">
            <p className="text-[12.5px] font-medium text-muted-foreground">Sample messages (2 to 5)</p>
            {d.samples.map((s, i) => (
              <div key={i} className="flex items-start gap-2">
                <Textarea rows={2} value={s} onChange={(e) => set({ samples: d.samples.map((x, j) => (j === i ? e.target.value : x)) })} />
                <button
                  type="button"
                  title="Remove"
                  disabled={d.samples.length <= LIMITS.samples[0]}
                  onClick={() => set({ samples: d.samples.filter((_, j) => j !== i) })}
                  className="mt-2 text-muted-foreground hover:text-destructive disabled:opacity-30"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </div>
            ))}
            {d.samples.length < LIMITS.samples[1] && (
              <div>
                <Button size="sm" variant="ghost" icon={<Plus className="h-3.5 w-3.5" />} onClick={() => set({ samples: [...d.samples, ''] })}>
                  Add a sample
                </Button>
              </div>
            )}
          </div>
          <label className="flex items-center justify-between gap-3 rounded-lg border border-border p-3">
            <span className="text-[13.5px] text-foreground/90">
              Some texts are promotions
              <span className="block text-[12px] text-muted-foreground">Only to people who ticked the form’s separate marketing box{draft.marketingBox ? '' : ' (this sub-account’s form doesn’t have one yet)'}.</span>
            </span>
            <Toggle checked={d.marketing} onChange={(v) => set({ marketing: v })} label="Some texts are promotions" />
          </label>
          <div className="grid gap-1 rounded-lg border border-border-soft bg-muted/30 px-3 py-2.5 text-[12.5px]">
            <p className="text-muted-foreground">
              Privacy policy: <a className="text-foreground underline" href={draft.legal.privacy} target="_blank" rel="noreferrer">{draft.legal.privacy}</a>
            </p>
            <p className="text-muted-foreground">
              Terms: <a className="text-foreground underline" href={draft.legal.terms} target="_blank" rel="noreferrer">{draft.legal.terms}</a>
            </p>
            <p className="text-muted-foreground/80">Change these in Settings → Business Profile.</p>
          </div>
        </Section>

        <Section title="Pre-check" hint="What reviewers reject for, tested on the live pages before anything is paid.">
          {checks.isFetching ? (
            <div className="flex items-center gap-2 text-[13px] text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" /> Checking the website, policies and form…
            </div>
          ) : (
            <ul className="flex flex-col gap-2">
              {/* Missing fields are listed above the button, live. */}
              {(checks.data?.checks ?? [])
                .filter((c) => !c.key.startsWith('detail-'))
                .map((c) => (
                  <li key={c.key} className="flex items-start gap-2 text-[13px]">
                    {CHECK_ICON[c.level]}
                    <span>
                      <span className="font-medium text-foreground">{c.label}.</span> <span className="text-muted-foreground">{c.detail}</span>
                      {c.fix && (
                        <button type="button" className="ml-1.5 font-medium text-primary hover:underline" onClick={() => set(c.fix!.patch)}>
                          {c.fix.label}
                        </button>
                      )}
                    </span>
                  </li>
                ))}
            </ul>
          )}
          <ErrorNote error={checks.error} />
          <div>
            <Button size="sm" icon={<RefreshCw className="h-3.5 w-3.5" />} disabled={checks.isFetching} onClick={() => setRun(run + 1)}>
              Check again
            </Button>
          </div>
        </Section>
        {problems.length > 0 && (
          <ul className="flex flex-col gap-1 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2.5 text-[12.5px] text-destructive">
            {problems.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        )}
        <ErrorNote error={file.error} />
      </div>
    </Modal>
  )
}
