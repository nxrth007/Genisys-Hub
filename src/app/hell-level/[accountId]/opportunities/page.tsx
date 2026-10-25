'use client'

import { Suspense, useMemo, useState } from 'react'
import Link from 'next/link'
import { useParams } from 'next/navigation'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { DndContext, PointerSensor, useDraggable, useDroppable, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core'
import { MessagesSquare, Phone, Plus } from 'lucide-react'
import { cn } from '@/lib/utils'
import { prettyPhone } from '@/lib/hl/merge'
import type { HlStage } from '@/lib/hl/types'
import { contactLabel } from '@/components/hell-level/bits'
import { Badge, Button, ErrorNote, Field, Input, Modal, PageHeader, Select, Spinner, hlFetch, timeAgo } from '@/components/hell-level/ui'
import { NotYet, useSectionTab } from '@/components/hell-level/section'
import { PipelinesManager } from '@/components/hell-level/pipelines-manager'
import { confirmAction } from '@/components/hell-level/confirm'
import { useHlViewer } from '@/components/hell-level/viewer'

type Opp = {
  id: string
  name: string
  value: number
  status: string
  stageId: string
  position: number
  source: string | null
  createdAt: string
  contact: { id: string; firstName: string | null; lastName: string | null; phone: string | null; email: string | null; tags: string[] }
}
type Pipeline = { id: string; name: string; stages: HlStage[]; opportunities: Opp[] }

export default function OpportunitiesPage() {
  return (
    <Suspense fallback={<div className="flex justify-center py-24"><Spinner /></div>}>
      <OpportunitiesSection />
    </Suspense>
  )
}

function OpportunitiesSection() {
  const { accountId } = useParams<{ accountId: string }>()
  const tab = useSectionTab('opportunities')
  if (tab === 'pipelines')
    return (
      <div className="mx-auto flex max-w-5xl flex-col gap-5 px-6 py-6">
        <PageHeader title="Pipelines" description="Each pipeline’s stages, in board order." />
        <PipelinesManager accountId={accountId} />
      </div>
    )
  if (tab === 'bulk-actions') return <NotYet title="Bulk Actions" what="GoHighLevel logs bulk opportunity jobs (bulk moves, imports, exports) here. Hell-level moves opportunities one at a time on the board." />
  return <Board />
}

function Board() {
  const { accountId } = useParams<{ accountId: string }>()
  const qc = useQueryClient()
  const q = useQuery<{ pipelines: Pipeline[] }>({ queryKey: ['hl', 'pipelines', accountId], queryFn: () => hlFetch(`/api/hl/accounts/${accountId}/pipelines`) })
  // The pipeline picked last time on this browser (GHL remembers it too).
  const storageKey = `hl.pipeline.${accountId}`
  const [pipelineId, setPipelineId] = useState<string>(() => {
    try {
      return typeof window === 'undefined' ? '' : (window.localStorage.getItem(storageKey) ?? '')
    } catch {
      return ''
    }
  })
  const pickPipeline = (id: string) => {
    setPipelineId(id)
    try {
      window.localStorage.setItem(storageKey, id)
    } catch {
      // private window: just not remembered
    }
  }
  const [status, setStatus] = useState<'open' | 'all' | 'won' | 'lost'>('open')
  const [editing, setEditing] = useState<Opp | null>(null)
  const [adding, setAdding] = useState<string | null>(null)
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }))

  // Otherwise the busiest one, not whichever was made first.
  const busiest = useMemo(() => [...(q.data?.pipelines ?? [])].sort((a, b) => b.opportunities.length - a.opportunities.length)[0], [q.data])
  const pipeline = q.data?.pipelines.find((p) => p.id === pipelineId) ?? busiest
  const shown = useMemo(() => (pipeline?.opportunities ?? []).filter((o) => status === 'all' || o.status === status), [pipeline, status])

  const move = useMutation({
    mutationFn: (v: { id: string; stageId: string }) => hlFetch(`/api/hl/accounts/${accountId}/opportunities/${v.id}`, { method: 'PATCH', json: { stageId: v.stageId, position: Date.now() / 1000 } }),
    onMutate: async (v) => {
      await qc.cancelQueries({ queryKey: ['hl', 'pipelines', accountId] })
      const prev = qc.getQueryData<{ pipelines: Pipeline[] }>(['hl', 'pipelines', accountId])
      qc.setQueryData<{ pipelines: Pipeline[] }>(['hl', 'pipelines', accountId], (d) =>
        d ? { pipelines: d.pipelines.map((p) => ({ ...p, opportunities: p.opportunities.map((o) => (o.id === v.id ? { ...o, stageId: v.stageId, position: Date.now() / 1000 } : o)) })) } : d,
      )
      return { prev }
    },
    onError: (_e, _v, ctx) => ctx?.prev && qc.setQueryData(['hl', 'pipelines', accountId], ctx.prev),
    onSettled: () => qc.invalidateQueries({ queryKey: ['hl', 'pipelines', accountId] }),
  })

  function onDragEnd(e: DragEndEvent) {
    const stageId = e.over?.id ? String(e.over.id) : null
    const opp = shown.find((o) => o.id === e.active.id)
    if (stageId && opp && opp.stageId !== stageId) move.mutate({ id: opp.id, stageId })
  }

  const money = (n: number) => n.toLocaleString('en-US', { style: 'currency', currency: 'USD' })

  return (
    <div className="flex h-full min-h-0 flex-col gap-4 px-6 py-7">
      <PageHeader title="Opportunities" description="Drag a lead to the next stage as the job moves. Moving one to “Job Complete” sends the review request (when it’s switched on)." />
      {/* GHL's toolbar: the pipeline and how many are in it on the left, the rest on the right. */}
      <div className="flex flex-wrap items-center gap-3">
        {(q.data?.pipelines.length ?? 0) > 1 && (
          <Select value={pipeline?.id ?? ''} onChange={(e) => pickPipeline(e.target.value)} className="w-56">
            {q.data!.pipelines.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </Select>
        )}
        {pipeline && (
          <span className="rounded-full bg-primary-soft px-3 py-1 text-[12.5px] font-medium tabular-nums text-primary">
            {shown.length.toLocaleString('en-US')} {shown.length === 1 ? 'opportunity' : 'opportunities'}
          </span>
        )}
        <div className="ml-auto flex items-center gap-2">
          <Select value={status} onChange={(e) => setStatus(e.target.value as typeof status)} className="w-36">
            <option value="open">Open</option>
            <option value="won">Won</option>
            <option value="lost">Lost</option>
            <option value="all">All</option>
          </Select>
          <Button variant="primary" icon={<Plus className="h-4 w-4" />} disabled={!pipeline} onClick={() => setAdding(pipeline?.stages[0]?.id ?? null)}>
            Add opportunity
          </Button>
        </div>
      </div>
      {q.isLoading ? (
        <div className="flex justify-center py-20">
          <Spinner />
        </div>
      ) : !pipeline ? (
        <ErrorNote error={q.error ?? 'No pipeline yet.'} />
      ) : (
        <DndContext sensors={sensors} onDragEnd={onDragEnd}>
          <div className="flex min-h-0 flex-1 gap-4 overflow-x-auto pb-2">
            {pipeline.stages.map((s) => {
              // Newest first, as GHL sorts its board by default.
              const cards = shown.filter((o) => o.stageId === s.id).sort((a, b) => b.createdAt.localeCompare(a.createdAt))
              const total = cards.reduce((sum, o) => sum + o.value, 0)
              return (
                <Column key={s.id} id={s.id}>
                  <div className="flex items-center justify-between px-1 pb-2">
                    <div>
                      <p className="text-[14px] font-semibold text-foreground">{s.name}</p>
                      <p className="text-[12px] tabular-nums text-muted-foreground">
                        {cards.length} {cards.length === 1 ? 'opportunity' : 'opportunities'}
                        <span className="ml-2 text-foreground/80">{money(total)}</span>
                      </p>
                    </div>
                    <button type="button" onClick={() => setAdding(s.id)} className="grid h-7 w-7 place-items-center rounded-md text-muted-foreground/70 hover:bg-muted hover:text-foreground" title="Add here">
                      <Plus className="h-4 w-4" />
                    </button>
                  </div>
                  <div className="flex flex-col gap-2">
                    {cards.map((o) => (
                      <OppCard key={o.id} o={o} accountId={accountId} onOpen={() => setEditing(o)} />
                    ))}
                    {!cards.length && <p className="rounded-lg border border-dashed border-border px-3 py-6 text-center text-[12px] text-muted-foreground/70">Drop here</p>}
                  </div>
                </Column>
              )
            })}
          </div>
        </DndContext>
      )}
      <ErrorNote error={move.error} />
      {editing && pipeline && <EditOpp accountId={accountId} opp={editing} stages={pipeline.stages} onClose={() => setEditing(null)} />}
      {adding !== null && pipeline && <AddOpp accountId={accountId} pipeline={pipeline} stageId={adding} onClose={() => setAdding(null)} />}
    </div>
  )
}

function Column({ id, children }: { id: string; children: React.ReactNode }) {
  const { setNodeRef, isOver } = useDroppable({ id })
  return (
    <div ref={setNodeRef} className={cn('flex w-[290px] shrink-0 flex-col overflow-y-auto rounded-xl bg-muted p-3 transition', isOver && 'bg-primary-soft ring-2 ring-primary/50')}>
      {children}
    </div>
  )
}

function OppCard({ o, accountId, onOpen }: { o: Opp; accountId: string; onOpen: () => void }) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({ id: o.id })
  return (
    <div
      ref={setNodeRef}
      {...attributes}
      {...listeners}
      onClick={onOpen}
      style={transform ? { transform: `translate3d(${transform.x}px, ${transform.y}px, 0)` } : undefined}
      className={cn('cursor-grab rounded-lg border border-border bg-card p-3 active:cursor-grabbing', isDragging && 'z-10 opacity-90 shadow-lg ring-2 ring-primary/50')}
    >
      <div className="flex items-start justify-between gap-2">
        <p className="text-[14px] font-semibold text-foreground">{o.name}</p>
        {o.status !== 'open' && <Badge color={o.status === 'won' ? 'green' : 'gray'}>{o.status}</Badge>}
      </div>
      {o.value > 0 && <p className="mt-0.5 text-[13px] font-medium text-success">${o.value.toLocaleString('en-US')}</p>}
      <div className="mt-2 flex items-center justify-between text-[12px] text-muted-foreground">
        <span className="flex items-center gap-1 truncate">
          <Phone className="h-3 w-3" /> {o.contact.phone ? prettyPhone(o.contact.phone) : contactLabel(o.contact)}
        </span>
        <span>{timeAgo(o.createdAt)}</span>
      </div>
      <Link
        href={`/hell-level/${accountId}/conversations?contact=${o.contact.id}`}
        onClick={(e) => e.stopPropagation()}
        onPointerDown={(e) => e.stopPropagation()}
        className="mt-2 inline-flex items-center gap-1 text-[12px] font-semibold text-primary hover:underline"
      >
        <MessagesSquare className="h-3 w-3" /> Conversation
      </Link>
    </div>
  )
}

function EditOpp({ accountId, opp, stages, onClose }: { accountId: string; opp: Opp; stages: HlStage[]; onClose: () => void }) {
  const qc = useQueryClient()
  const { admin } = useHlViewer()
  const [form, setForm] = useState({ name: opp.name, value: String(opp.value || ''), stageId: opp.stageId, status: opp.status })
  const save = useMutation({
    mutationFn: () => hlFetch(`/api/hl/accounts/${accountId}/opportunities/${opp.id}`, { method: 'PATCH', json: { ...form, value: Number(form.value) || 0 } }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['hl', 'pipelines', accountId] })
      onClose()
    },
  })
  const del = useMutation({
    mutationFn: () => hlFetch(`/api/hl/accounts/${accountId}/opportunities/${opp.id}`, { method: 'DELETE' }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['hl', 'pipelines', accountId] })
      onClose()
    },
  })
  return (
    <Modal
      open
      onClose={onClose}
      title="Edit opportunity"
      description={contactLabel(opp.contact)}
      footer={
        <>
          {/* Genisys only (a sub-account's own login marks it lost instead). */}
          {admin && (
            <Button variant="ghost" className="mr-auto text-destructive" loading={del.isPending} onClick={() => void confirmAction('Delete this opportunity? The contact stays.', 'Delete opportunity').then((ok) => ok && del.mutate())}>
              Delete
            </Button>
          )}
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={save.isPending} onClick={() => save.mutate()}>
            Save
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <Field label="Name">
          <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Value ($)">
            <Input inputMode="numeric" value={form.value} onChange={(e) => setForm({ ...form, value: e.target.value.replace(/[^\d]/g, '') })} />
          </Field>
          <Field label="Status">
            <Select value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value })}>
              <option value="open">Open</option>
              <option value="won">Won</option>
              <option value="lost">Lost</option>
              <option value="abandoned">Abandoned</option>
            </Select>
          </Field>
        </div>
        <Field label="Stage">
          <Select value={form.stageId} onChange={(e) => setForm({ ...form, stageId: e.target.value })}>
            {stages.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </Select>
        </Field>
        <ErrorNote error={save.error || del.error} />
      </div>
    </Modal>
  )
}

function AddOpp({ accountId, pipeline, stageId, onClose }: { accountId: string; pipeline: Pipeline; stageId: string; onClose: () => void }) {
  const qc = useQueryClient()
  const [form, setForm] = useState({ firstName: '', lastName: '', phone: '', email: '', name: '', value: '', stageId })
  const save = useMutation({
    mutationFn: () =>
      hlFetch(`/api/hl/accounts/${accountId}/opportunities`, {
        method: 'POST',
        json: { pipelineId: pipeline.id, stageId: form.stageId, name: form.name || undefined, value: Number(form.value) || 0, contact: { firstName: form.firstName, lastName: form.lastName, phone: form.phone, email: form.email } },
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['hl', 'pipelines', accountId] })
      onClose()
    },
  })
  return (
    <Modal
      open
      onClose={onClose}
      title="Add opportunity"
      description="An existing contact with this phone or email is reused."
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={save.isPending} onClick={() => save.mutate()}>
            Add
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <div className="grid grid-cols-2 gap-3">
          <Field label="First name">
            <Input value={form.firstName} onChange={(e) => setForm({ ...form, firstName: e.target.value })} />
          </Field>
          <Field label="Last name">
            <Input value={form.lastName} onChange={(e) => setForm({ ...form, lastName: e.target.value })} />
          </Field>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Phone">
            <Input value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
          </Field>
          <Field label="Email">
            <Input value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
          </Field>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Opportunity name" hint="Blank = the contact’s name">
            <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          </Field>
          <Field label="Value ($)" hint="Optional">
            <Input inputMode="numeric" value={form.value} onChange={(e) => setForm({ ...form, value: e.target.value.replace(/[^\d]/g, '') })} />
          </Field>
        </div>
        <Field label="Stage">
          <Select value={form.stageId} onChange={(e) => setForm({ ...form, stageId: e.target.value })}>
            {pipeline.stages.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </Select>
        </Field>
        <ErrorNote error={save.error} />
      </div>
    </Modal>
  )
}
