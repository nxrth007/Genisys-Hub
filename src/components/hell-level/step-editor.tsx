'use client'

import { useRef, useState } from 'react'
import { Clock, Filter, GitBranch, Mail, MessageCircle, Smartphone, Tag, Zap } from 'lucide-react'
import { renderTemplate, unknownTokens } from '@/lib/hl/merge'
import { MERGE_FIELDS, STEPS, TRIGGERS, type HlProfile, type HlStage, type HlStep, type HlStepType, type HlTrigger } from '@/lib/hl/types'
import { Button, Field, Input, Select, Textarea } from './ui'

/** How each action looks on the canvas (GHL colours its action tiles by kind). */
export const STEP_LOOK: Record<HlStepType, { icon: React.ComponentType<{ className?: string }>; bg: string; fg: string }> = {
  send_sms: { icon: MessageCircle, bg: '#ECFDF3', fg: '#079455' },
  internal_sms: { icon: Smartphone, bg: '#EFF8FF', fg: '#1570EF' },
  internal_email: { icon: Mail, bg: '#F4F3FF', fg: '#6938EF' },
  wait: { icon: Clock, bg: '#FFFAEB', fg: '#DC6803' },
  add_tag: { icon: Tag, bg: '#F0FDF9', fg: '#0E9384' },
  remove_tag: { icon: Tag, bg: '#F0FDF9', fg: '#0E9384' },
  create_opportunity: { icon: Filter, bg: '#EEF4FF', fg: '#3538CD' },
  move_opportunity: { icon: Filter, bg: '#EEF4FF', fg: '#3538CD' },
  if_tag: { icon: GitBranch, bg: '#FDF2FA', fg: '#C11574' },
}

export const TRIGGER_LOOK = { icon: Zap, bg: '#FFFAEB', fg: '#DC6803' }

export const SAMPLE = (profile: HlProfile) => ({
  contact: { firstName: 'Jennifer', lastName: 'Smith', phone: '+15125550123', email: 'jennifer@example.com' },
  account: profile,
  form: { service: 'Roof repair', message: 'Small leak over the kitchen' },
  call: { from: '+15125550123' },
})

/** One-line summary under an action's name on the canvas. */
export function stepSummary(s: HlStep, stages: HlStage[]): string {
  const c = s.config ?? {}
  switch (s.type) {
    case 'send_sms':
    case 'internal_sms':
      return (c.body ?? '').replace(/\s+/g, ' ').slice(0, 70) || 'No message yet'
    case 'internal_email':
      return c.subject || 'No subject'
    case 'wait':
      return `${c.amount ?? 1} ${c.unit ?? 'minutes'}`
    case 'add_tag':
    case 'remove_tag':
      return c.tag || 'No tag'
    case 'if_tag':
      return `Continue only if contact ${c.has === false ? 'doesn’t have' : 'has'} “${c.tag ?? ''}”`
    case 'create_opportunity':
    case 'move_opportunity':
      return stages.find((x) => x.id === c.stageId)?.name ?? (s.type === 'create_opportunity' ? 'First stage' : 'Pick a stage')
  }
}

function MessageField({ label, value, onChange, profile, rows = 6, hint }: { label: string; value: string; onChange: (v: string) => void; profile: HlProfile; rows?: number; hint?: string }) {
  const ref = useRef<HTMLTextAreaElement>(null)
  const insert = (token: string) => {
    const el = ref.current
    if (!el) return onChange(value + token)
    const start = el.selectionStart ?? value.length
    const end = el.selectionEnd ?? value.length
    const next = value.slice(0, start) + token + value.slice(end)
    onChange(next)
    requestAnimationFrame(() => {
      el.focus()
      el.setSelectionRange(start + token.length, start + token.length)
    })
  }
  const preview = renderTemplate(value, SAMPLE(profile))
  const unknown = unknownTokens(value)
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-end justify-between gap-2">
        <span className="text-[13px] font-medium text-[#344054]">{label}</span>
        <select
          value=""
          onChange={(e) => e.target.value && insert(e.target.value)}
          className="h-7 rounded-md border border-[#D0D5DD] bg-white px-2 text-[12px] text-[#344054]"
        >
          <option value="">{'{ }'} Insert field…</option>
          {MERGE_FIELDS.map((m) => (
            <option key={m.token} value={m.token}>
              {m.label}
            </option>
          ))}
        </select>
      </div>
      <Textarea ref={ref} rows={rows} value={value} onChange={(e) => onChange(e.target.value)} />
      {hint && <span className="text-[12px] text-[#667085]">{hint}</span>}
      {unknown.length > 0 && <span className="text-[12px] text-[#B54708]">Won’t fill: {unknown.join(', ')}</span>}
      <div className="rounded-lg bg-[#F9FAFB] p-3">
        <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-[#98A2B3]">Preview (sample lead)</p>
        <p className="whitespace-pre-wrap text-[13px] text-[#344054]">{preview || '—'}</p>
      </div>
    </div>
  )
}

export function StepEditor({
  step,
  stages,
  pipelines,
  profile,
  onSave,
  onDelete,
}: {
  step: HlStep
  stages: HlStage[]
  pipelines: { id: string; name: string; stages: HlStage[] }[]
  profile: HlProfile
  onSave: (s: HlStep) => void
  onDelete: () => void
}) {
  const [s, setS] = useState<HlStep>(step)
  const set = (patch: Partial<HlStep['config']>) => setS({ ...s, config: { ...s.config, ...patch } })
  const pipeline = pipelines.find((p) => p.id === s.config.pipelineId) ?? pipelines[0]
  const label = STEPS.find((x) => x.type === s.type)?.label ?? s.type
  return (
    <div className="flex flex-col gap-4">
      <Field label="Action name">
        <Input value={s.name ?? ''} placeholder={label} onChange={(e) => setS({ ...s, name: e.target.value })} />
      </Field>

      {s.type === 'send_sms' && (
        <MessageField
          label="Message to the contact"
          value={s.config.body ?? ''}
          onChange={(body) => set({ body })}
          profile={profile}
          hint="Sent from the sub-account’s number. Only goes to contacts who agreed to texts or called/texted first. A contact’s first text gets “Reply STOP to opt out.” added."
        />
      )}
      {s.type === 'internal_sms' && (
        <>
          <MessageField label="Text to the owner" value={s.config.body ?? ''} onChange={(body) => set({ body })} profile={profile} rows={5} />
          <Field label="Send to" hint={`Blank = the notification phone in the business profile (${profile.notifyPhone || 'not set'}).`}>
            <Input value={s.config.to ?? ''} onChange={(e) => set({ to: e.target.value })} placeholder="(555) 123-4567, (555) 987-6543" />
          </Field>
        </>
      )}
      {s.type === 'internal_email' && (
        <>
          <Field label="Subject">
            <Input value={s.config.subject ?? ''} onChange={(e) => set({ subject: e.target.value })} />
          </Field>
          <MessageField label="Email to the owner" value={s.config.body ?? ''} onChange={(body) => set({ body })} profile={profile} rows={9} />
          <Field label="Send to" hint={`Blank = the notification email in the business profile (${profile.notifyEmail || 'not set'}).`}>
            <Input value={s.config.to ?? ''} onChange={(e) => set({ to: e.target.value })} placeholder="owner@example.com" />
          </Field>
        </>
      )}
      {s.type === 'wait' && (
        <div className="grid grid-cols-2 gap-3">
          <Field label="Wait for">
            <Input type="number" min={1} max={365} value={s.config.amount ?? 1} onChange={(e) => set({ amount: Number(e.target.value) })} />
          </Field>
          <Field label="Unit">
            <Select value={s.config.unit ?? 'minutes'} onChange={(e) => set({ unit: e.target.value as 'minutes' | 'hours' | 'days' })}>
              <option value="minutes">Minutes</option>
              <option value="hours">Hours</option>
              <option value="days">Days</option>
            </Select>
          </Field>
          <p className="col-span-2 text-[12px] text-[#667085]">Texts after a wait don’t go out between 9 PM and 8 AM in the sub-account’s timezone; they wait for 9 AM.</p>
        </div>
      )}
      {(s.type === 'add_tag' || s.type === 'remove_tag' || s.type === 'if_tag') && (
        <Field label="Tag">
          <Input value={s.config.tag ?? ''} onChange={(e) => set({ tag: e.target.value })} placeholder="quote form" />
        </Field>
      )}
      {s.type === 'if_tag' && (
        <Field label="Continue only if the contact…">
          <Select value={s.config.has === false ? 'no' : 'yes'} onChange={(e) => set({ has: e.target.value === 'yes' })}>
            <option value="yes">has this tag</option>
            <option value="no">doesn’t have this tag</option>
          </Select>
        </Field>
      )}
      {(s.type === 'create_opportunity' || s.type === 'move_opportunity') && (
        <>
          {pipelines.length > 1 && (
            <Field label="Pipeline">
              <Select value={pipeline?.id ?? ''} onChange={(e) => set({ pipelineId: e.target.value, stageId: undefined })}>
                {pipelines.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </Select>
            </Field>
          )}
          <Field label="Stage" hint={s.type === 'create_opportunity' ? 'Skipped when the contact already has an open opportunity in this pipeline.' : undefined}>
            <Select value={s.config.stageId ?? ''} onChange={(e) => set({ stageId: e.target.value || undefined })}>
              {s.type === 'create_opportunity' && <option value="">First stage</option>}
              {s.type === 'move_opportunity' && <option value="">Pick a stage…</option>}
              {(pipeline?.stages ?? stages).map((st) => (
                <option key={st.id} value={st.id}>
                  {st.name}
                </option>
              ))}
            </Select>
          </Field>
        </>
      )}

      <div className="flex justify-between gap-2 border-t border-[#EAECF0] pt-4">
        <Button variant="ghost" className="text-[#D92D20]" onClick={onDelete}>
          Delete action
        </Button>
        <Button variant="primary" onClick={() => onSave(s)}>
          Save action
        </Button>
      </div>
    </div>
  )
}

export function TriggerEditor({
  trigger,
  forms,
  stages,
  onSave,
}: {
  trigger: HlTrigger
  forms: { id: string; name: string; kind: string }[]
  stages: HlStage[]
  onSave: (t: HlTrigger) => void
}) {
  const [t, setT] = useState<HlTrigger>(trigger)
  const kindForms = forms.filter((f) => (t.type === 'chat_submitted' ? f.kind === 'chat' : f.kind === 'form'))
  return (
    <div className="flex flex-col gap-4">
      <Field label="When this happens">
        <Select value={t.type} onChange={(e) => setT({ type: e.target.value as HlTrigger['type'] })}>
          {TRIGGERS.map((x) => (
            <option key={x.type} value={x.type}>
              {x.label}
            </option>
          ))}
        </Select>
      </Field>
      <p className="-mt-2 text-[12.5px] text-[#667085]">{TRIGGERS.find((x) => x.type === t.type)?.hint}</p>
      {(t.type === 'form_submitted' || t.type === 'chat_submitted') && (
        <Field label={t.type === 'chat_submitted' ? 'Chat widget' : 'Form'}>
          <Select value={t.formId ?? ''} onChange={(e) => setT({ ...t, formId: e.target.value || undefined })}>
            <option value="">Any {t.type === 'chat_submitted' ? 'chat widget' : 'form'}</option>
            {kindForms.map((f) => (
              <option key={f.id} value={f.id}>
                {f.name}
              </option>
            ))}
          </Select>
        </Field>
      )}
      {t.type === 'inbound_sms' && (
        <Field label="Only replies containing" hint="Blank = any reply">
          <Input value={t.keyword ?? ''} onChange={(e) => setT({ ...t, keyword: e.target.value })} placeholder="e.g. yes" />
        </Field>
      )}
      {t.type === 'tag_added' && (
        <Field label="Tag">
          <Input value={t.tag ?? ''} onChange={(e) => setT({ ...t, tag: e.target.value })} placeholder="job complete" />
        </Field>
      )}
      {t.type === 'opportunity_stage' && (
        <Field label="Moved into stage">
          <Select value={t.stageId ?? ''} onChange={(e) => setT({ ...t, stageId: e.target.value || undefined })}>
            <option value="">Any stage</option>
            {stages.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </Select>
        </Field>
      )}
      <div className="flex justify-end border-t border-[#EAECF0] pt-4">
        <Button variant="primary" onClick={() => onSave(t)}>
          Save trigger
        </Button>
      </div>
    </div>
  )
}
