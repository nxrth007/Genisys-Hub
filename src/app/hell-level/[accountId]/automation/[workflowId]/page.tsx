'use client'

import Link from 'next/link'
import { useEffect, useMemo, useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowLeft, Play, Plus, Search, Trash2, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { STEPS, triggerLabel, type HlStage, type HlStep, type HlStepType, type HlTrigger } from '@/lib/hl/types'
import { contactLabel, useAccount, type ContactRow } from '@/components/hell-level/bits'
import { STEP_LOOK, StepEditor, TRIGGER_LOOK, TriggerEditor, stepSummary } from '@/components/hell-level/step-editor'
import { PanZoomCanvas } from '@/components/hell-level/canvas'
import { Badge, Button, ErrorNote, Field, Input, Modal, Spinner, Toggle, fmtDateTime, hlFetch } from '@/components/hell-level/ui'

type Workflow = { id: string; name: string; folder: string | null; status: string; trigger: HlTrigger; steps: HlStep[]; allowReentry: boolean; updatedAt: string }
type Run = {
  id: string
  status: string
  step: number
  nextRunAt: string | null
  createdAt: string
  log: { at: string; step: number; type: string; ok: boolean; detail: string }[]
  contact: { id: string; firstName: string | null; lastName: string | null; phone: string | null; email: string | null }
}

type Drawer = { kind: 'trigger' } | { kind: 'step'; index: number } | { kind: 'add'; index: number } | null

const newId = () => `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`

const DEFAULTS: Record<HlStepType, HlStep['config']> = {
  send_sms: { body: 'Hey {{contact.first_name}}! ' },
  internal_sms: { body: 'New lead: {{contact.full_name}} {{contact.phone}}' },
  internal_email: { subject: 'New lead: {{contact.full_name}}', body: 'Hey {{account.owner_first_name}},\n\n' },
  wait: { amount: 5, unit: 'minutes' },
  add_tag: { tag: '' },
  remove_tag: { tag: '' },
  create_opportunity: {},
  move_opportunity: {},
  if_tag: { tag: '', has: true },
  wait_appointment: { amount: 1, unit: 'days', when: 'before' },
}

export default function WorkflowBuilderPage() {
  const { accountId, workflowId } = useParams<{ accountId: string; workflowId: string }>()
  const router = useRouter()
  const qc = useQueryClient()
  const account = useAccount(accountId)
  const q = useQuery<{ workflow: Workflow; runs: Run[] }>({
    queryKey: ['hl', 'workflow', accountId, workflowId],
    queryFn: () => hlFetch(`/api/hl/accounts/${accountId}/workflows/${workflowId}`),
  })
  const forms = useQuery<{ forms: { id: string; name: string; kind: string }[] }>({ queryKey: ['hl', 'forms', accountId], queryFn: () => hlFetch(`/api/hl/accounts/${accountId}/forms`) })
  const pipelines = useQuery<{ pipelines: { id: string; name: string; stages: HlStage[] }[] }>({ queryKey: ['hl', 'pipelines', accountId], queryFn: () => hlFetch(`/api/hl/accounts/${accountId}/pipelines`) })
  const calendars = useQuery<{ calendars: { id: string; name: string }[] }>({ queryKey: ['hl', 'calendars', accountId], queryFn: () => hlFetch(`/api/hl/accounts/${accountId}/calendars`) })

  // Unsaved changes sit on top of the saved workflow; Save sends them and clears them.
  const [edits, setEdits] = useState<Workflow | null>(null)
  const draft = edits ?? q.data?.workflow ?? null
  const dirty = edits !== null
  const [drawer, setDrawer] = useState<Drawer>(null)
  const [tab, setTab] = useState<'builder' | 'logs' | 'settings'>('builder')
  const [testing, setTesting] = useState(false)

  useEffect(() => {
    if (!dirty) return
    const warn = (e: BeforeUnloadEvent) => e.preventDefault()
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [dirty])

  const update = (patch: Partial<Workflow>) => {
    const base = edits ?? q.data?.workflow
    if (base) setEdits({ ...base, ...patch })
  }

  const save = useMutation({
    mutationFn: (extra: Record<string, unknown> = {}) =>
      hlFetch<{ workflow: Workflow }>(`/api/hl/accounts/${accountId}/workflows/${workflowId}`, {
        method: 'PATCH',
        json: { name: draft?.name, folder: draft?.folder ?? '', trigger: draft?.trigger, steps: draft?.steps, allowReentry: draft?.allowReentry, ...extra },
      }),
    onSuccess: (r) => {
      qc.setQueryData<{ workflow: Workflow; runs: Run[] }>(['hl', 'workflow', accountId, workflowId], (d) => (d ? { ...d, workflow: r.workflow } : d))
      setEdits(null)
      qc.invalidateQueries({ queryKey: ['hl', 'workflow', accountId, workflowId] })
      qc.invalidateQueries({ queryKey: ['hl', 'workflows', accountId] })
      qc.invalidateQueries({ queryKey: ['hl', 'account', accountId] })
    },
  })
  const remove = useMutation({
    mutationFn: () => hlFetch(`/api/hl/accounts/${accountId}/workflows/${workflowId}`, { method: 'DELETE' }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['hl', 'workflows', accountId] })
      router.push(`/hell-level/${accountId}/automation`)
    },
  })

  const allStages = useMemo(() => (pipelines.data?.pipelines ?? []).flatMap((p) => p.stages), [pipelines.data])
  const profile = account.data?.account.profile ?? {}

  if (q.isLoading || !draft) {
    return (
      <div className="flex justify-center py-24">
        {q.error ? <ErrorNote error={q.error} /> : <Spinner />}
      </div>
    )
  }

  const published = draft.status === 'published'
  const setSteps = (steps: HlStep[]) => update({ steps })

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-wrap items-center gap-3 border-b border-border bg-card px-5 py-2.5">
        <Link href={`/hell-level/${accountId}/automation`} className="grid h-9 w-9 place-items-center rounded-lg text-muted-foreground hover:bg-muted" title="Back to workflows">
          <ArrowLeft className="h-5 w-5" />
        </Link>
        <input
          value={draft.name}
          onChange={(e) => update({ name: e.target.value })}
          className="min-w-[220px] rounded-md border border-transparent px-2 py-1 text-[16px] font-semibold text-foreground outline-none hover:border-border focus:border-primary/50"
        />
        <div className="ml-2 flex gap-1 rounded-lg bg-muted p-1">
          {(['builder', 'logs', 'settings'] as const).map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setTab(t)}
              className={cn('rounded-md px-3 py-1.5 text-[13px] font-semibold transition', tab === t ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground')}
            >
              {t === 'builder' ? 'Builder' : t === 'logs' ? 'Execution Logs' : 'Settings'}
            </button>
          ))}
        </div>
        <div className="ml-auto flex items-center gap-3">
          <Button size="sm" icon={<Play className="h-3.5 w-3.5" />} onClick={() => setTesting(true)} disabled={dirty} title={dirty ? 'Save first' : undefined}>
            Test workflow
          </Button>
          <span className="flex items-center gap-2 text-[13px] font-semibold text-foreground/90">
            {published ? 'Publish' : 'Draft'}
            <Toggle checked={published} onChange={(v) => save.mutate({ status: v ? 'published' : 'draft' })} disabled={save.isPending} label="Published" />
          </span>
          <Button size="sm" variant="primary" loading={save.isPending} disabled={!dirty} onClick={() => save.mutate({})}>
            Save
          </Button>
        </div>
      </div>
      {save.error && (
        <div className="border-b border-destructive/30 bg-destructive/10 px-5 py-2 text-[13px] text-destructive">{(save.error as Error).message}</div>
      )}

      {tab === 'builder' && (
        <div className="flex min-h-0 flex-1">
          <div className="min-w-0 flex-1">
            <PanZoomCanvas>
            <div className="flex w-[380px] flex-col items-center pb-24">
              <button
                type="button"
                onClick={() => setDrawer({ kind: 'trigger' })}
                className={cn(
                  'w-full rounded-xl border-2 border-dashed bg-card px-4 py-3.5 text-left shadow-sm transition hover:border-warning',
                  drawer?.kind === 'trigger' ? 'border-warning' : 'border-warning/40',
                )}
              >
                <span className="flex items-center gap-3">
                  <Tile look={TRIGGER_LOOK} />
                  <span className="min-w-0">
                    <span className="block text-[11px] font-semibold uppercase tracking-wide text-warning">Trigger</span>
                    <span className="block truncate text-[14px] font-semibold text-foreground">{triggerLabel(draft.trigger.type)}</span>
                    <span className="block truncate text-[12px] text-muted-foreground">{triggerDetail(draft.trigger, forms.data?.forms ?? [], allStages, calendars.data?.calendars ?? [])}</span>
                  </span>
                </span>
              </button>
              <Connector onAdd={() => setDrawer({ kind: 'add', index: 0 })} />
              {draft.steps.map((s, i) => {
                const look = STEP_LOOK[s.type]
                return (
                  <div key={s.id} className="flex w-full flex-col items-center">
                    <div
                      role="button"
                      tabIndex={0}
                      onClick={() => setDrawer({ kind: 'step', index: i })}
                      onKeyDown={(e) => e.key === 'Enter' && setDrawer({ kind: 'step', index: i })}
                      className={cn(
                        'group relative w-full cursor-pointer rounded-xl border bg-card px-4 py-3.5 shadow-sm transition hover:border-primary/50',
                        drawer?.kind === 'step' && drawer.index === i ? 'border-primary ring-2 ring-primary/20' : 'border-border',
                      )}
                    >
                      <span className="flex items-center gap-3">
                        <Tile look={look} />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-[14px] font-semibold text-foreground">{s.name || STEPS.find((x) => x.type === s.type)?.label}</span>
                          <span className="block truncate text-[12px] text-muted-foreground">{stepSummary(s, allStages)}</span>
                        </span>
                      </span>
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation()
                          setSteps(draft.steps.filter((_, j) => j !== i))
                          setDrawer(null)
                        }}
                        className="absolute -right-2.5 -top-2.5 hidden h-6 w-6 place-items-center rounded-full border border-border bg-card text-muted-foreground/70 shadow-sm hover:text-destructive group-hover:grid"
                        title="Delete action"
                      >
                        <Trash2 className="h-3 w-3" />
                      </button>
                    </div>
                    <Connector onAdd={() => setDrawer({ kind: 'add', index: i + 1 })} />
                  </div>
                )
              })}
              <span className="rounded-full bg-muted px-4 py-1 text-[12px] font-bold tracking-wide text-foreground/90">END</span>
            </div>
            </PanZoomCanvas>
          </div>

          {drawer && (
            <aside className="flex w-[460px] shrink-0 flex-col border-l border-border bg-card">
              <div className="flex items-center justify-between border-b border-border px-5 py-4">
                <p className="text-[16px] font-semibold text-foreground">
                  {drawer.kind === 'trigger' ? 'Workflow Trigger' : drawer.kind === 'add' ? 'Actions' : 'Edit Action'}
                </p>
                <button type="button" onClick={() => setDrawer(null)} className="grid h-8 w-8 place-items-center rounded-lg text-muted-foreground/70 hover:bg-muted">
                  <X className="h-5 w-5" />
                </button>
              </div>
              <div className="min-h-0 flex-1 overflow-y-auto p-5">
                {drawer.kind === 'trigger' && (
                  <TriggerEditor
                    key="trigger"
                    trigger={draft.trigger}
                    forms={forms.data?.forms ?? []}
                    stages={allStages}
                    calendars={calendars.data?.calendars ?? []}
                    onSave={(t) => {
                      update({ trigger: t })
                      setDrawer(null)
                    }}
                  />
                )}
                {drawer.kind === 'add' && (
                  <ActionPicker
                    onPick={(type) => {
                      const step: HlStep = { id: newId(), type, config: { ...DEFAULTS[type] } }
                      const steps = [...draft.steps]
                      steps.splice(drawer.index, 0, step)
                      setSteps(steps)
                      setDrawer({ kind: 'step', index: drawer.index })
                    }}
                  />
                )}
                {drawer.kind === 'step' && draft.steps[drawer.index] && (
                  <StepEditor
                    key={draft.steps[drawer.index].id}
                    step={draft.steps[drawer.index]}
                    stages={allStages}
                    pipelines={pipelines.data?.pipelines ?? []}
                    profile={profile}
                    onSave={(s) => {
                      setSteps(draft.steps.map((x, j) => (j === drawer.index ? s : x)))
                      setDrawer(null)
                    }}
                    onDelete={() => {
                      setSteps(draft.steps.filter((_, j) => j !== drawer.index))
                      setDrawer(null)
                    }}
                  />
                )}
              </div>
            </aside>
          )}
        </div>
      )}

      {tab === 'logs' && <Logs runs={q.data?.runs ?? []} steps={draft.steps} />}

      {tab === 'settings' && (
        <div className="mx-auto flex w-full max-w-2xl flex-col gap-5 px-6 py-8">
          <Field label="Folder">
            <Input value={draft.folder ?? ''} onChange={(e) => update({ folder: e.target.value })} placeholder="Incoming Lead Workflows" />
          </Field>
          <label className="flex items-center justify-between gap-4 rounded-xl border border-border bg-card p-4">
            <span>
              <span className="block text-[14px] font-semibold text-foreground">Allow re-entry</span>
              <span className="block text-[13px] text-muted-foreground">A contact can go through this workflow again each time the trigger happens (the same trigger within a minute is ignored).</span>
            </span>
            <Toggle checked={draft.allowReentry} onChange={(v) => update({ allowReentry: v })} label="Allow re-entry" />
          </label>
          <div className="flex justify-between border-t border-border pt-5">
            <Button variant="danger" loading={remove.isPending} onClick={() => window.confirm(`Delete “${draft.name}”? Contacts waiting in it stop where they are.`) && remove.mutate()}>
              Delete workflow
            </Button>
            <Button variant="primary" disabled={!dirty} loading={save.isPending} onClick={() => save.mutate({})}>
              Save
            </Button>
          </div>
          <ErrorNote error={remove.error} />
        </div>
      )}

      {testing && <TestModal accountId={accountId} workflowId={workflowId} onClose={() => setTesting(false)} onDone={() => qc.invalidateQueries({ queryKey: ['hl', 'workflow', accountId, workflowId] })} />}
    </div>
  )
}

function triggerDetail(t: HlTrigger, forms: { id: string; name: string }[], stages: HlStage[], calendars: { id: string; name: string }[]): string {
  if (t.type === 'appointment_booked' || t.type === 'appointment_status') {
    const cal = t.calendarId ? (calendars.find((c) => c.id === t.calendarId)?.name ?? 'A calendar') : 'Any calendar'
    return t.type === 'appointment_status' && t.status ? `${cal} · ${t.status}` : cal
  }
  if (t.type === 'form_submitted' || t.type === 'chat_submitted') return t.formId ? (forms.find((f) => f.id === t.formId)?.name ?? 'A form') : 'Any form'
  if (t.type === 'inbound_sms') return t.keyword ? `Reply contains “${t.keyword}”` : 'Any reply'
  if (t.type === 'tag_added') return t.tag ? `Tag “${t.tag}”` : 'Any tag'
  if (t.type === 'opportunity_stage') return t.stageId ? `Into ${stages.find((s) => s.id === t.stageId)?.name ?? 'a stage'}` : 'Any stage'
  return 'Click to change'
}

function Tile({ look }: { look: { icon: React.ComponentType<{ className?: string }>; bg: string; fg: string } }) {
  const Icon = look.icon
  return (
    <span className="grid h-10 w-10 shrink-0 place-items-center rounded-lg" style={{ background: look.bg, color: look.fg }}>
      <Icon className="h-5 w-5" />
    </span>
  )
}

function Connector({ onAdd }: { onAdd: () => void }) {
  return (
    <div className="flex flex-col items-center">
      <span className="h-5 w-px bg-border" />
      <button type="button" onClick={onAdd} className="grid h-7 w-7 place-items-center rounded-full border border-border bg-card text-muted-foreground shadow-sm transition hover:border-primary hover:bg-primary hover:text-primary-foreground" title="Add action">
        <Plus className="h-4 w-4" />
      </button>
      <span className="h-5 w-px bg-border" />
    </div>
  )
}

function ActionPicker({ onPick }: { onPick: (t: HlStepType) => void }) {
  const [q, setQ] = useState('')
  const groups = ['Communication', 'Timing', 'Contact', 'Pipeline', 'Logic'] as const
  const shown = STEPS.filter((s) => s.label.toLowerCase().includes(q.trim().toLowerCase()))
  return (
    <div className="flex flex-col gap-4">
      <label className="flex h-10 items-center gap-2 rounded-lg border border-border px-3 text-muted-foreground/70 focus-within:border-primary/50">
        <Search className="h-4 w-4" />
        <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search actions" className="w-full bg-transparent text-[14px] text-foreground outline-none" />
      </label>
      {groups.map((g) => {
        const items = shown.filter((s) => s.group === g)
        if (!items.length) return null
        return (
          <div key={g}>
            <p className="mb-2 text-[12px] font-semibold uppercase tracking-wide text-muted-foreground/70">{g}</p>
            <div className="flex flex-col gap-1.5">
              {items.map((s) => (
                <button key={s.type} type="button" onClick={() => onPick(s.type)} className="flex items-center gap-3 rounded-lg border border-border px-3 py-2.5 text-left transition hover:border-primary/50 hover:bg-primary-soft">
                  <Tile look={STEP_LOOK[s.type]} />
                  <span className="text-[14px] font-medium text-foreground">{s.label}</span>
                </button>
              ))}
            </div>
          </div>
        )
      })}
    </div>
  )
}

function Logs({ runs, steps }: { runs: Run[]; steps: HlStep[] }) {
  const [open, setOpen] = useState<string | null>(null)
  if (!runs.length) return <p className="px-6 py-16 text-center text-[14px] text-muted-foreground">Nobody has gone through this workflow yet.</p>
  return (
    <div className="mx-auto w-full max-w-5xl px-6 py-6">
      <div className="overflow-hidden rounded-xl border border-border bg-card">
        {runs.map((r) => (
          <div key={r.id} className="border-b border-border last:border-0">
            <button type="button" onClick={() => setOpen(open === r.id ? null : r.id)} className="flex w-full items-center gap-4 px-5 py-3 text-left hover:bg-muted/50">
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[14px] font-medium text-foreground">{contactLabel(r.contact)}</span>
                <span className="block text-[12px] text-muted-foreground">{fmtDateTime(r.createdAt)}</span>
              </span>
              <span className="text-[12px] text-muted-foreground">
                {Math.min(r.step, steps.length)}/{steps.length} steps
              </span>
              <Badge color={r.status === 'done' ? 'green' : r.status === 'waiting' ? 'blue' : r.status === 'failed' ? 'red' : 'gray'}>
                {r.status === 'waiting' && r.nextRunAt ? `waiting until ${fmtDateTime(r.nextRunAt)}` : r.status}
              </Badge>
              {r.log.some((l) => !l.ok) && <Badge color="red">has errors</Badge>}
            </button>
            {open === r.id && (
              <ol className="flex flex-col gap-1.5 bg-surface-muted px-5 py-3">
                {r.log.map((l, i) => (
                  <li key={i} className="flex gap-3 text-[13px]">
                    <span className={cn('mt-1.5 h-2 w-2 shrink-0 rounded-full', l.ok ? 'bg-success' : 'bg-destructive')} />
                    <span className="w-36 shrink-0 text-muted-foreground">{fmtDateTime(l.at)}</span>
                    <span className="w-44 shrink-0 font-medium text-foreground/90">{steps[l.step]?.name || STEPS.find((s) => s.type === l.type)?.label || l.type}</span>
                    <span className={l.ok ? 'text-muted-foreground' : 'text-destructive'}>{l.detail}</span>
                  </li>
                ))}
                {!r.log.length && <li className="text-[13px] text-muted-foreground">No steps ran yet.</li>}
              </ol>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}

function TestModal({ accountId, workflowId, onClose, onDone }: { accountId: string; workflowId: string; onClose: () => void; onDone: () => void }) {
  const [q, setQ] = useState('')
  const contacts = useQuery<{ contacts: ContactRow[] }>({
    queryKey: ['hl', 'contacts', accountId, q, '', 0],
    queryFn: () => hlFetch(`/api/hl/accounts/${accountId}/contacts?q=${encodeURIComponent(q)}`),
  })
  const run = useMutation({
    mutationFn: (contactId: string) => hlFetch<{ run: { status: string; log: Run['log'] } }>(`/api/hl/accounts/${accountId}/workflows/${workflowId}`, { method: 'PATCH', json: { testContactId: contactId } }),
    onSuccess: onDone,
  })
  return (
    <Modal open onClose={onClose} title="Test workflow" description="Runs it for real for one contact, right now (drafts included). Texts and emails really go out, so pick yourself or a test contact." width="max-w-xl">
      {run.data ? (
        <div className="flex flex-col gap-2">
          <p className="text-[14px] font-semibold text-foreground">Result: {run.data.run.status}</p>
          <ol className="flex flex-col gap-1.5">
            {run.data.run.log.map((l, i) => (
              <li key={i} className="flex gap-2 text-[13px]">
                <span className={cn('mt-1.5 h-2 w-2 shrink-0 rounded-full', l.ok ? 'bg-success' : 'bg-destructive')} />
                <span className={l.ok ? 'text-foreground/90' : 'text-destructive'}>{l.detail}</span>
              </li>
            ))}
          </ol>
          <div className="flex justify-end pt-2">
            <Button onClick={onClose}>Close</Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          <Input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search contacts" />
          <div className="max-h-72 overflow-y-auto rounded-lg border border-border">
            {(contacts.data?.contacts ?? []).map((c) => (
              <button key={c.id} type="button" disabled={run.isPending} onClick={() => run.mutate(c.id)} className="flex w-full items-center justify-between gap-3 border-b border-border px-3 py-2.5 text-left text-[14px] last:border-0 hover:bg-muted/50">
                <span className="font-medium text-foreground">{contactLabel(c)}</span>
                <span className="text-[12px] text-muted-foreground">{c.phone ?? c.email}</span>
              </button>
            ))}
            {contacts.data && !contacts.data.contacts.length && <p className="px-3 py-6 text-center text-[13px] text-muted-foreground">No contacts. Add yourself under Contacts first.</p>}
          </div>
          {run.isPending && <Spinner />}
          <ErrorNote error={run.error} />
        </div>
      )}
    </Modal>
  )
}
