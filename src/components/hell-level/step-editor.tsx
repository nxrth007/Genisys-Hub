'use client'

import { useRef, useState } from 'react'
import { Ban, CalendarClock, Clock, CornerUpLeft, Droplets, FileText, Filter, GitBranch, GitFork, ListPlus, ListX, Mail, MailOpen, MessageCircle, MessageSquareReply, PenLine, Puzzle, Smartphone, Tag, UserPen, Zap } from 'lucide-react'
import { renderTemplate, unknownTokens } from '@/lib/hl/merge'
import { APPOINTMENT_STATUSES, MERGE_FIELDS, STEPS, TRIGGERS, type HlCondition, type HlProfile, type HlStage, type HlStep, type HlStepType, type HlTrigger } from '@/lib/hl/types'
import { Badge, Button, Field, Input, Select, Textarea, Toggle } from './ui'

/** How each action looks on the canvas (GHL colours its action tiles by kind; here in the Hub's chip tones). */
export const STEP_LOOK: Record<HlStepType, { icon: React.ComponentType<{ className?: string }>; bg: string; fg: string }> = {
  send_sms: { icon: MessageCircle, bg: 'var(--chip-mint)', fg: 'var(--chip-mint-fg)' },
  internal_sms: { icon: Smartphone, bg: 'var(--chip-blue)', fg: 'var(--chip-blue-fg)' },
  internal_email: { icon: Mail, bg: 'var(--chip-violet)', fg: 'var(--chip-violet-fg)' },
  wait: { icon: Clock, bg: 'var(--chip-amber)', fg: 'var(--chip-amber-fg)' },
  add_tag: { icon: Tag, bg: 'var(--chip-mint)', fg: 'var(--chip-mint-fg)' },
  remove_tag: { icon: Tag, bg: 'var(--chip-mint)', fg: 'var(--chip-mint-fg)' },
  create_opportunity: { icon: Filter, bg: 'var(--chip-blue)', fg: 'var(--chip-blue-fg)' },
  move_opportunity: { icon: Filter, bg: 'var(--chip-blue)', fg: 'var(--chip-blue-fg)' },
  if_tag: { icon: GitBranch, bg: 'var(--chip-pink)', fg: 'var(--chip-pink-fg)' },
  wait_appointment: { icon: CalendarClock, bg: 'var(--chip-amber)', fg: 'var(--chip-amber-fg)' },
  send_email: { icon: MailOpen, bg: 'var(--chip-violet)', fg: 'var(--chip-violet-fg)' },
  wait_reply: { icon: MessageSquareReply, bg: 'var(--chip-amber)', fg: 'var(--chip-amber-fg)' },
  drip: { icon: Droplets, bg: 'var(--chip-amber)', fg: 'var(--chip-amber-fg)' },
  if_else: { icon: GitBranch, bg: 'var(--chip-pink)', fg: 'var(--chip-pink-fg)' },
  goto: { icon: CornerUpLeft, bg: 'var(--chip-pink)', fg: 'var(--chip-pink-fg)' },
  split: { icon: GitFork, bg: 'var(--chip-pink)', fg: 'var(--chip-pink-fg)' },
  dnd: { icon: Ban, bg: 'var(--chip-mint)', fg: 'var(--chip-mint-fg)' },
  update_field: { icon: PenLine, bg: 'var(--chip-mint)', fg: 'var(--chip-mint-fg)' },
  update_contact: { icon: UserPen, bg: 'var(--chip-mint)', fg: 'var(--chip-mint-fg)' },
  add_note: { icon: FileText, bg: 'var(--chip-mint)', fg: 'var(--chip-mint-fg)' },
  add_to_workflow: { icon: ListPlus, bg: 'var(--chip-blue)', fg: 'var(--chip-blue-fg)' },
  remove_from_workflow: { icon: ListX, bg: 'var(--chip-blue)', fg: 'var(--chip-blue-fg)' },
  ghl: { icon: Puzzle, bg: 'var(--chip-amber)', fg: 'var(--chip-amber-fg)' },
}

export const TRIGGER_LOOK = { icon: Zap, bg: 'var(--chip-amber)', fg: 'var(--chip-amber-fg)' }

export const SAMPLE = (profile: HlProfile) => ({
  contact: { firstName: 'Jennifer', lastName: 'Smith', phone: '+15125550123', email: 'jennifer@example.com' },
  account: profile,
  form: { service: 'Roof repair', message: 'Small leak over the kitchen' },
  call: { from: '+15125550123' },
  appointment: {
    title: 'Jennifer Smith',
    startTime: '2026-11-03T19:00:00.000Z',
    timezone: 'America/New_York',
    calendarName: 'Free Estimate',
    location: '123 Main St',
    rescheduleUrl: 'https://genisys-hub.onrender.com/hl/a/sample',
    cancelUrl: 'https://genisys-hub.onrender.com/hl/a/sample?cancel=1',
  },
})

const STATUS_LABEL: Record<string, string> = { confirmed: 'Confirmed', cancelled: 'Cancelled', showed: 'Showed', noshow: 'No-show', rescheduled: 'Rescheduled' }

const plain = (t: string | undefined) => (t ?? '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim()
const tagsText = (c: HlStep['config']) => [...(c.tags ?? []), ...(c.tag ? [c.tag] : [])].join(', ')

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
/** "Mon–Fri 09:00–17:00" for a wait's window. */
export function windowText(w: { days: number[]; start: string; end: string }): string {
  const d = [...w.days].sort()
  const run = d.length > 2 && d.every((x, i) => i === 0 || x === d[i - 1] + 1)
  return `${run ? `${DAY_NAMES[d[0]]}–${DAY_NAMES[d[d.length - 1]]}` : d.map((x) => DAY_NAMES[x]).join(', ')} ${w.start}–${w.end}`
}

/** A GHL if/else condition in words (`triggerName` turns a trigger id into its name). */
export function conditionText(c: HlCondition, triggerName?: (id: string) => string | undefined): string {
  const v = Array.isArray(c.value) ? c.value.join(', ') : String(c.value ?? '')
  if (c.type === 'contact_reply' && c.subType === 'message.body') return `Reply ${c.operator === 'notContain' ? 'doesn’t contain' : c.operator === 'contain' ? 'contains' : c.operator} “${v}”`
  if (c.type === 'contact_reply' && c.subType === 'contact_replied') return v === 'false' ? 'Contact hasn’t replied' : 'Contact replied'
  if (c.type === 'contact_detail' && c.subType === 'tags') return `${c.operator === 'index-of-false' ? 'Doesn’t have' : 'Has'} tag “${v}”`
  if (c.type === 'contact_reply' && c.subType === 'matches_intent') return `Reply means “${v}” (AI intent)`
  if (c.type === 'trigger') return `Workflow trigger ${c.operator === '!=' ? 'isn’t' : 'is'} “${triggerName?.(v) ?? 'a particular trigger'}”`
  return `${c.type}${c.subType ? ` · ${c.subType}` : ''} ${c.operator} ${v}`.trim()
}

/** One-line summary under an action's name on the canvas. */
export function stepSummary(s: HlStep, stages: HlStage[]): string {
  const c = s.config ?? {}
  switch (s.type) {
    case 'send_sms':
    case 'internal_sms':
      return (c.body ?? '').replace(/\s+/g, ' ').slice(0, 70) || 'No message yet'
    case 'internal_email':
    case 'send_email':
      return c.subject || plain(c.body).slice(0, 70) || 'No subject'
    case 'wait': {
      const span = c.amount === 0 ? 'No delay' : `${c.amount ?? 1} ${c.unit ?? 'minutes'}`
      return c.window ? `${span}, then ${windowText(c.window)}` : span
    }
    case 'wait_reply':
      return c.amount === 0 ? 'Until they reply (no time limit)' : `Until they reply, or ${c.amount ?? 1} ${c.unit ?? 'minutes'}`
    case 'add_tag':
    case 'remove_tag':
      return tagsText(c) || 'No tag'
    case 'if_else':
      return `${(s.branches ?? []).length + 1} branches`
    case 'goto':
      return 'Jumps to another step'
    case 'split':
      return (c.paths ?? []).map((p) => `${p.name} ${p.percent}%`).join(' · ') || 'No paths'
    case 'dnd':
      return c.dnd === false ? 'Texting back on' : 'Texting off (DND)'
    case 'update_field':
    case 'update_contact':
      return (c.fields ?? []).map((f) => f.label || f.key).join(', ') || 'Nothing to update'
    case 'add_note':
      return plain(c.body).slice(0, 70) || 'Empty note'
    case 'add_to_workflow':
    case 'remove_from_workflow':
      return c.workflowIds?.length ? `${c.workflowIds.length} workflow${c.workflowIds.length === 1 ? '' : 's'}` : s.type === 'remove_from_workflow' ? 'This workflow' : 'Pick a workflow'
    case 'drip':
      return 'Batches contacts; one goes straight on here'
    case 'ghl':
      return `GoHighLevel: ${s.ghl?.type ?? 'action'} · not in Hell-level yet`
    case 'if_tag':
      return `Continue only if contact ${c.has === false ? 'doesn’t have' : 'has'} “${c.tag ?? ''}”`
    case 'create_opportunity':
    case 'move_opportunity':
      return stages.find((x) => x.id === c.stageId)?.name ?? (s.type === 'create_opportunity' ? 'First stage' : 'Pick a stage')
    case 'wait_appointment':
      return c.amount ? `${c.amount} ${c.unit ?? 'minutes'} ${c.when === 'after' ? 'after' : 'before'} the appointment` : 'Until the appointment starts'
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
        <span className="text-[13px] font-medium text-foreground/90">{label}</span>
        <select
          value=""
          onChange={(e) => e.target.value && insert(e.target.value)}
          className="h-7 rounded-md border border-border bg-card px-2 text-[12px] text-foreground/90"
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
      {hint && <span className="text-[12px] text-muted-foreground">{hint}</span>}
      {unknown.length > 0 && <span className="text-[12px] text-warning">Won’t fill: {unknown.join(', ')}</span>}
      <div className="rounded-lg bg-surface-muted p-3">
        <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground/70">Preview (sample lead)</p>
        <p className="whitespace-pre-wrap text-[13px] text-foreground/90">{preview || '—'}</p>
      </div>
    </div>
  )
}

export function StepEditor({
  step,
  stages,
  pipelines,
  profile,
  workflows = [],
  steps = [],
  triggerName,
  onSave,
  onDelete,
}: {
  step: HlStep
  stages: HlStage[]
  pipelines: { id: string; name: string; stages: HlStage[] }[]
  profile: HlProfile
  /** A trigger id → its name (If/Else "Workflow trigger is …"). */
  triggerName?: (id: string) => string | undefined
  /** The sub-account's other workflows (Add to / Remove from workflow). */
  workflows?: { id: string; name: string }[]
  /** The workflow's steps (where a Go to jumps). */
  steps?: HlStep[]
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
            <Input type="number" min={0} max={365} step="any" value={s.config.amount ?? 1} onChange={(e) => set({ amount: Number(e.target.value) })} />
          </Field>
          <Field label="Unit">
            <Select value={s.config.unit ?? 'minutes'} onChange={(e) => set({ unit: e.target.value as 'minutes' | 'hours' | 'days' })}>
              <option value="minutes">Minutes</option>
              <option value="hours">Hours</option>
              <option value="days">Days</option>
            </Select>
          </Field>
          <div className="col-span-2 flex flex-col gap-2 rounded-lg border border-border p-3">
            <label className="flex items-center justify-between gap-3 text-[13px] text-foreground/90">
              <span>
                Only carry on during set hours
                <span className="block text-[12px] text-muted-foreground">After the wait, holds until the next time inside these hours (GHL’s “wait for business hours”).</span>
              </span>
              <Toggle checked={!!s.config.window} onChange={(v) => set({ window: v ? { days: [1, 2, 3, 4, 5], start: '09:00', end: '17:00' } : undefined })} label="Set hours" />
            </label>
            {s.config.window && (
              <>
                <div className="flex flex-wrap gap-1.5">
                  {DAY_NAMES.map((name, d) => {
                    const on = s.config.window!.days.includes(d)
                    return (
                      <button
                        key={name}
                        type="button"
                        onClick={() => set({ window: { ...s.config.window!, days: on ? s.config.window!.days.filter((x) => x !== d) : [...s.config.window!.days, d].sort() } })}
                        className={`rounded-md border px-2.5 py-1 text-[12px] font-semibold ${on ? 'border-primary bg-primary-soft text-foreground' : 'border-border text-muted-foreground'}`}
                      >
                        {name}
                      </button>
                    )
                  })}
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <Field label="From">
                    <Input type="time" value={s.config.window.start} onChange={(e) => set({ window: { ...s.config.window!, start: e.target.value } })} />
                  </Field>
                  <Field label="Until">
                    <Input type="time" value={s.config.window.end} onChange={(e) => set({ window: { ...s.config.window!, end: e.target.value } })} />
                  </Field>
                </div>
              </>
            )}
          </div>
          <p className="col-span-2 text-[12px] text-muted-foreground">Texts after a wait don’t go out between 9 PM and 8 AM in the sub-account’s timezone; they wait for 9 AM.</p>
        </div>
      )}
      {s.type === 'wait_appointment' && (
        <div className="grid grid-cols-3 gap-3">
          <Field label="Wait until">
            <Input type="number" min={0} max={365} value={s.config.amount ?? 0} onChange={(e) => set({ amount: Number(e.target.value) })} />
          </Field>
          <Field label="Unit">
            <Select value={s.config.unit ?? 'hours'} onChange={(e) => set({ unit: e.target.value as 'minutes' | 'hours' | 'days' })}>
              <option value="minutes">Minutes</option>
              <option value="hours">Hours</option>
              <option value="days">Days</option>
            </Select>
          </Field>
          <Field label="The appointment">
            <Select value={s.config.when ?? 'before'} onChange={(e) => set({ when: e.target.value === 'after' ? 'after' : 'before' })}>
              <option value="before">before it starts</option>
              <option value="after">after it starts</option>
            </Select>
          </Field>
          <p className="col-span-3 text-[12px] text-muted-foreground">
            For workflows started by an appointment. A rescheduled appointment moves the wait with it; a cancelled one ends the run here. If the time has already passed, the workflow carries on straight away.
          </p>
        </div>
      )}
      {(s.type === 'if_tag' || ((s.type === 'add_tag' || s.type === 'remove_tag') && !(s.config.tags?.length ?? 0))) && (
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

      {s.type === 'send_email' && (
        <>
          <Field label="Subject">
            <Input value={s.config.subject ?? ''} onChange={(e) => set({ subject: e.target.value })} />
          </Field>
          <Field label="From name">
            <Input value={s.config.fromName ?? ''} onChange={(e) => set({ fromName: e.target.value })} placeholder="{{user.name}}" />
          </Field>
          <MessageField label="Email to the contact" value={s.config.body ?? ''} onChange={(body) => set({ body })} profile={profile} rows={10} hint="Emails to contacts go out once a sending domain is set up (Settings → Email Services); until then the workflow carries on without sending." />
        </>
      )}
      {s.type === 'wait_reply' && (
        <div className="grid grid-cols-2 gap-3">
          <Field label="Wait up to" hint="0 = no time limit">
            <Input type="number" min={0} max={365} step="any" value={s.config.amount ?? 1} onChange={(e) => set({ amount: Number(e.target.value) })} />
          </Field>
          <Field label="Unit">
            <Select value={s.config.unit ?? 'hours'} onChange={(e) => set({ unit: e.target.value as 'minutes' | 'hours' | 'days' })}>
              <option value="minutes">Minutes</option>
              <option value="hours">Hours</option>
              <option value="days">Days</option>
            </Select>
          </Field>
          <p className="col-span-2 text-[12px] text-muted-foreground">Carries on as soon as the contact texts back, or when the time runs out.</p>
        </div>
      )}
      {s.type === 'dnd' && (
        <Field label="Texting">
          <Select value={s.config.dnd === false ? 'on' : 'off'} onChange={(e) => set({ dnd: e.target.value === 'off' })}>
            <option value="off">Switch texting off (DND)</option>
            <option value="on">Switch texting back on</option>
          </Select>
        </Field>
      )}
      {(s.type === 'update_field' || s.type === 'update_contact') && (
        <div className="flex flex-col gap-2">
          <p className="text-[13px] font-medium text-foreground/90">Set</p>
          {(s.config.fields ?? []).map((f, i) => (
            <div key={i} className="grid grid-cols-[1fr_1fr_auto] items-center gap-2">
              <Input value={f.label ?? f.key} onChange={(e) => set({ fields: (s.config.fields ?? []).map((x, j) => (j === i ? { ...x, label: e.target.value, key: x.key || e.target.value } : x)) })} placeholder="Field" />
              <Input value={f.value} onChange={(e) => set({ fields: (s.config.fields ?? []).map((x, j) => (j === i ? { ...x, value: e.target.value } : x)) })} placeholder="Value or {{today}}" />
              <button type="button" className="text-[12px] text-muted-foreground hover:text-destructive" onClick={() => set({ fields: (s.config.fields ?? []).filter((_, j) => j !== i) })}>
                Remove
              </button>
            </div>
          ))}
          <div>
            <Button size="sm" variant="ghost" onClick={() => set({ fields: [...(s.config.fields ?? []), { key: '', value: '' }] })}>
              Add a field
            </Button>
          </div>
        </div>
      )}
      {s.type === 'add_note' && <MessageField label="Note" value={s.config.body ?? ''} onChange={(body) => set({ body })} profile={profile} rows={6} />}
      {(s.type === 'add_tag' || s.type === 'remove_tag') && (s.config.tags?.length ?? 0) > 0 && (
        <Field label="Tags" hint="Separate with commas">
          <Input value={(s.config.tags ?? []).join(', ')} onChange={(e) => set({ tags: e.target.value.split(',').map((t) => t.trim()).filter(Boolean) })} />
        </Field>
      )}
      {s.type === 'if_else' && (
        <div className="flex flex-col gap-3">
          {(s.branches ?? []).map((b) => (
            <div key={b.id} className="rounded-lg border border-border p-3">
              <p className="text-[13.5px] font-semibold text-foreground">{b.name}</p>
              {b.segments.map((seg, i) => (
                <div key={i} className="mt-1.5">
                  {i > 0 && <p className="my-1 text-[11px] font-semibold uppercase text-muted-foreground">{b.operator === 'or' ? 'or' : 'and'}</p>}
                  <ul className="flex flex-col gap-0.5 text-[12.5px] text-muted-foreground">
                    {seg.conditions.map((c, j) => (
                      <li key={j}>
                        {j > 0 && <span className="mr-1 font-semibold uppercase">{seg.operator === 'or' ? 'or' : 'and'}</span>}
                        {conditionText(c, triggerName)}
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          ))}
          <p className="rounded-lg border border-dashed border-border p-3 text-[13px] text-muted-foreground">Otherwise: “{s.elseName || 'None'}”</p>
          <p className="text-[12px] text-muted-foreground">Branches are tried top to bottom; the first that holds is followed.</p>
        </div>
      )}
      {(s.type === 'add_to_workflow' || s.type === 'remove_from_workflow') && (
        <div className="flex flex-col gap-1.5">
          <p className="text-[13px] font-medium text-foreground/90">{s.type === 'add_to_workflow' ? 'Add the contact to' : 'Take the contact out of'}</p>
          {s.type === 'remove_from_workflow' && <p className="text-[12px] text-muted-foreground">None ticked = this workflow (the contact stops here).</p>}
          <div className="max-h-64 overflow-y-auto rounded-lg border border-border">
            {workflows.map((w) => {
              const on = (s.config.workflowIds ?? []).includes(w.id)
              return (
                <label key={w.id} className="flex cursor-pointer items-center gap-2.5 border-b border-border px-3 py-2 text-[13px] last:border-0 hover:bg-muted/50">
                  <input type="checkbox" checked={on} onChange={() => set({ workflowIds: on ? (s.config.workflowIds ?? []).filter((x) => x !== w.id) : [...(s.config.workflowIds ?? []), w.id] })} />
                  <span className="text-foreground/90">{w.name}</span>
                </label>
              )
            })}
            {!workflows.length && <p className="px-3 py-4 text-center text-[12.5px] text-muted-foreground">No other workflows yet.</p>}
          </div>
        </div>
      )}
      {s.type === 'goto' && (
        <Field label="Go to" hint="The contact carries on from that step.">
          <Select value={s.config.target ?? ''} onChange={(e) => set({ target: e.target.value || undefined })}>
            <option value="">Pick a step…</option>
            {steps
              .filter((x) => x.id !== s.id && x.type !== 'goto')
              .map((x) => (
                <option key={x.id} value={x.id}>
                  {x.name || STEPS.find((t) => t.type === x.type)?.label || x.type}
                </option>
              ))}
          </Select>
        </Field>
      )}
      {s.type === 'split' && (
        <div className="flex flex-col gap-2">
          <p className="text-[13px] font-medium text-foreground/90">Contacts are shared out at random</p>
          {(s.config.paths ?? []).map((p, i) => (
            <div key={p.id} className="grid grid-cols-[1fr_110px] items-center gap-2">
              <Input value={p.name} onChange={(e) => set({ paths: (s.config.paths ?? []).map((x, j) => (j === i ? { ...x, name: e.target.value } : x)) })} />
              <Input type="number" min={0} max={100} value={p.percent} onChange={(e) => set({ paths: (s.config.paths ?? []).map((x, j) => (j === i ? { ...x, percent: Number(e.target.value) } : x)) })} />
            </div>
          ))}
          {(s.config.paths ?? []).reduce((n, p) => n + (Number(p.percent) || 0), 0) !== 100 && <p className="text-[12px] text-warning">The percentages should add up to 100.</p>}
        </div>
      )}
      {(s.type === 'ghl' || s.type === 'drip') && (
        <div className="flex flex-col gap-2">
          {s.type === 'ghl' && <Badge color="amber">Not in Hell-level yet</Badge>}
          <p className="text-[13px] text-muted-foreground">
            {s.type === 'ghl'
              ? `GoHighLevel’s “${s.ghl?.type ?? 'action'}”, kept exactly as it was. A contact who reaches it stops here until Hell-level can run it.`
              : 'GHL’s drip lets contacts through in batches. Hell-level runs one contact at a time, so they go straight on.'}
          </p>
          {s.ghl?.attributes !== undefined && (
            <pre className="max-h-72 overflow-auto rounded-lg bg-surface-muted p-3 text-[11.5px] text-foreground/80">{JSON.stringify(s.ghl.attributes, null, 2)}</pre>
          )}
        </div>
      )}

      <div className="flex justify-between gap-2 border-t border-border pt-4">
        <Button variant="ghost" className="text-destructive" onClick={onDelete}>
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
  calendars,
  pipelines = [],
  onSave,
  onDelete,
}: {
  trigger: HlTrigger
  forms: { id: string; name: string; kind: string }[]
  stages: HlStage[]
  calendars: { id: string; name: string }[]
  pipelines?: { id: string; name: string; stages: HlStage[] }[]
  onSave: (t: HlTrigger) => void
  onDelete?: () => void
}) {
  const [t, setT] = useState<HlTrigger>(trigger)
  const kindForms = forms.filter((f) => (t.type === 'chat_submitted' ? f.kind === 'chat' : f.kind === 'form'))
  return (
    <div className="flex flex-col gap-4">
      {t.type === 'ghl' ? (
        <div className="flex flex-col gap-2">
          <Badge color="amber">GoHighLevel trigger · never fires here</Badge>
          <p className="text-[13px] text-muted-foreground">GoHighLevel’s “{t.ghl?.type ?? 'trigger'}” has no Hell-level equivalent yet, so it’s kept as it was and doesn’t start the workflow.</p>
          {(t.ghl?.conditions?.length ?? 0) > 0 && <pre className="max-h-60 overflow-auto rounded-lg bg-surface-muted p-3 text-[11.5px] text-foreground/80">{JSON.stringify(t.ghl?.conditions, null, 2)}</pre>}
        </div>
      ) : (
      <>
      <Field label="Trigger name">
        <Input value={t.name ?? ''} onChange={(e) => setT({ ...t, name: e.target.value })} placeholder={TRIGGERS.find((x) => x.type === t.type)?.label} />
      </Field>
      <Field label="When this happens">
        <Select value={t.type} onChange={(e) => setT({ type: e.target.value as HlTrigger['type'], id: t.id, name: t.name, active: t.active })}>
          {TRIGGERS.filter((x) => x.pick !== false).map((x) => (
            <option key={x.type} value={x.type}>
              {x.label}
            </option>
          ))}
        </Select>
      </Field>
      <p className="-mt-2 text-[12.5px] text-muted-foreground">{TRIGGERS.find((x) => x.type === t.type)?.hint}</p>
      {(t.type === 'form_submitted' || t.type === 'chat_submitted') && (
        <div className="flex flex-col gap-1.5">
          <p className="text-[13px] font-medium text-foreground/90">{t.type === 'chat_submitted' ? 'Chat widgets' : 'Forms'}</p>
          <p className="text-[12px] text-muted-foreground">None ticked = any {t.type === 'chat_submitted' ? 'chat widget' : 'form'}.</p>
          <div className="max-h-56 overflow-y-auto rounded-lg border border-border">
            {kindForms.map((f) => {
              const picked = t.formIds ?? (t.formId ? [t.formId] : [])
              const on = picked.includes(f.id)
              return (
                <label key={f.id} className="flex cursor-pointer items-center gap-2.5 border-b border-border px-3 py-2 text-[13px] last:border-0 hover:bg-muted/50">
                  <input type="checkbox" checked={on} onChange={() => setT({ ...t, formId: undefined, formIds: on ? picked.filter((x) => x !== f.id) : [...picked, f.id] })} />
                  <span className="text-foreground/90">{f.name}</span>
                </label>
              )
            })}
            {!kindForms.length && <p className="px-3 py-4 text-center text-[12.5px] text-muted-foreground">No {t.type === 'chat_submitted' ? 'chat widgets' : 'forms'} in this sub-account yet.</p>}
          </div>
        </div>
      )}
      {t.type === 'inbound_sms' && (
        <div className="grid grid-cols-[1fr_150px] gap-3">
          <Field label={t.match === 'exact' ? 'Only replies that are exactly' : 'Only replies containing'} hint="Blank = any reply">
            <Input value={t.keyword ?? ''} onChange={(e) => setT({ ...t, keyword: e.target.value })} placeholder="e.g. yes" />
          </Field>
          <Field label="Match">
            <Select value={t.match ?? 'contains'} onChange={(e) => setT({ ...t, match: e.target.value === 'exact' ? 'exact' : 'contains' })}>
              <option value="contains">contains</option>
              <option value="exact">exact phrase</option>
            </Select>
          </Field>
        </div>
      )}
      {t.type === 'tag_added' && (
        <Field label="Tag">
          <Input value={t.tag ?? ''} onChange={(e) => setT({ ...t, tag: e.target.value })} placeholder="job complete" />
        </Field>
      )}
      {(t.type === 'appointment_booked' || t.type === 'appointment_status') && (
        <Field label="Calendar">
          <Select value={t.calendarId ?? ''} onChange={(e) => setT({ ...t, calendarId: e.target.value || undefined })}>
            <option value="">Any calendar</option>
            {calendars.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </Select>
        </Field>
      )}
      {t.type === 'appointment_status' && (
        <Field label="Status">
          <Select value={t.status ?? ''} onChange={(e) => setT({ ...t, status: e.target.value || undefined })}>
            <option value="">Any change</option>
            {APPOINTMENT_STATUSES.map((s) => (
              <option key={s} value={s}>
                {STATUS_LABEL[s] ?? s}
              </option>
            ))}
          </Select>
        </Field>
      )}
      {(t.type === 'opportunity_stage' || t.type === 'opportunity_created') && pipelines.length > 1 && (
        <Field label="Pipeline">
          <Select value={t.pipelineId ?? ''} onChange={(e) => setT({ ...t, pipelineId: e.target.value || undefined, stageId: undefined })}>
            <option value="">Any pipeline</option>
            {pipelines.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </Select>
        </Field>
      )}
      {(t.type === 'opportunity_stage' || t.type === 'opportunity_created') && (
        <Field label={t.type === 'opportunity_created' ? 'In stage' : 'Moved into stage'}>
          <Select value={t.stageId ?? ''} onChange={(e) => setT({ ...t, stageId: e.target.value || undefined })}>
            <option value="">Any stage</option>
            {(pipelines.find((p) => p.id === t.pipelineId)?.stages ?? stages).map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </Select>
        </Field>
      )}
      <label className="flex items-center justify-between gap-3 rounded-lg border border-border p-3">
        <span className="text-[13.5px] text-foreground/90">
          Trigger on
          <span className="block text-[12px] text-muted-foreground">Switched off, it stays here but doesn’t start the workflow (GHL’s per-trigger switch).</span>
        </span>
        <Toggle checked={t.active !== false} onChange={(v) => setT({ ...t, active: v ? undefined : false })} label="Trigger on" />
      </label>
      </>
      )}
      <div className="flex justify-between gap-2 border-t border-border pt-4">
        {onDelete ? (
          <Button variant="ghost" className="text-destructive" onClick={onDelete}>
            Delete trigger
          </Button>
        ) : (
          <span />
        )}
        <Button variant="primary" onClick={() => onSave(t)}>
          Save trigger
        </Button>
      </div>
    </div>
  )
}
