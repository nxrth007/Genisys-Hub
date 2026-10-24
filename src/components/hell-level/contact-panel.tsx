'use client'

import Link from 'next/link'
import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Mail, Phone, Plus, Tag, Trash2, Workflow, X } from 'lucide-react'
import { prettyPhone } from '@/lib/hl/merge'
import type { HlStage } from '@/lib/hl/types'
import { contactLabel, SOURCE_LABEL, type ContactRow } from './bits'
import { Avatar, Badge, Button, ErrorNote, Input, Select, Toggle, fmtDateTime, hlFetch, timeAgo } from './ui'
import { confirmAction } from './confirm'

export type ContactDetail = {
  contact: ContactRow
  messages: {
    id: string
    direction: string
    channel: string
    body: string
    status: string
    from: string | null
    to: string | null
    error: string | null
    meta: Record<string, unknown>
    by: string | null
    createdAt: string
  }[]
  opportunities: { id: string; name: string; status: string; value: number; stageId: string; pipeline: { name: string; stages: HlStage[] } }[]
  runs: { id: string; status: string; createdAt: string; nextRunAt: string | null; workflow: { name: string } }[]
}

/** The right-hand contact card in Conversations: details, consent, tags, pipeline and automations. */
export function ContactPanel({ accountId, detail, onDeleted }: { accountId: string; detail: ContactDetail; onDeleted: () => void }) {
  const qc = useQueryClient()
  const c = detail.contact
  const [edit, setEdit] = useState(false)
  const [form, setForm] = useState({ firstName: c.firstName ?? '', lastName: c.lastName ?? '', phone: c.phone ?? '', email: c.email ?? '' })
  const [tag, setTag] = useState('')
  const [wf, setWf] = useState('')

  const workflows = useQuery<{ workflows: { id: string; name: string; status: string }[] }>({
    queryKey: ['hl', 'workflows', accountId],
    queryFn: () => hlFetch(`/api/hl/accounts/${accountId}/workflows`),
  })

  const patch = useMutation({
    mutationFn: (body: Record<string, unknown>) => hlFetch(`/api/hl/accounts/${accountId}/contacts/${c.id}`, { method: 'PATCH', json: body }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['hl', 'contact', accountId, c.id] })
      qc.invalidateQueries({ queryKey: ['hl', 'conversations', accountId] })
      setEdit(false)
    },
  })
  const del = useMutation({
    mutationFn: () => hlFetch(`/api/hl/accounts/${accountId}/contacts/${c.id}`, { method: 'DELETE' }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['hl', 'conversations', accountId] })
      qc.invalidateQueries({ queryKey: ['hl', 'contacts', accountId] })
      onDeleted()
    },
  })

  const name = contactLabel(c)
  return (
    <div className="flex flex-col gap-5 p-5">
      <div className="flex flex-col items-center gap-2 text-center">
        <Avatar name={name} size={56} />
        <p className="text-[16px] font-semibold text-foreground">{name}</p>
        <p className="text-[12px] text-muted-foreground">
          {SOURCE_LABEL[c.source ?? ''] ?? 'Contact'} · added {timeAgo(c.createdAt)}
        </p>
      </div>

      {edit ? (
        <div className="flex flex-col gap-2">
          <div className="grid grid-cols-2 gap-2">
            <Input value={form.firstName} onChange={(e) => setForm({ ...form, firstName: e.target.value })} placeholder="First name" />
            <Input value={form.lastName} onChange={(e) => setForm({ ...form, lastName: e.target.value })} placeholder="Last name" />
          </div>
          <Input value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} placeholder="Phone" />
          <Input value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} placeholder="Email" />
          <div className="flex justify-end gap-2">
            <Button size="sm" onClick={() => setEdit(false)}>
              Cancel
            </Button>
            <Button size="sm" variant="primary" loading={patch.isPending} onClick={() => patch.mutate(form)}>
              Save
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-2 text-[14px]">
          <p className="flex items-center gap-2 text-foreground/90">
            <Phone className="h-4 w-4 text-muted-foreground/70" /> {c.phone ? prettyPhone(c.phone) : <span className="text-muted-foreground/70">No phone</span>}
          </p>
          <p className="flex items-center gap-2 break-all text-foreground/90">
            <Mail className="h-4 w-4 shrink-0 text-muted-foreground/70" /> {c.email || <span className="text-muted-foreground/70">No email</span>}
          </p>
          <button type="button" onClick={() => setEdit(true)} className="self-start text-[13px] font-semibold text-primary hover:underline">
            Edit details
          </button>
        </div>
      )}

      <div className="flex flex-col gap-3 rounded-lg border border-border p-3">
        <label className="flex items-center justify-between gap-3 text-[13.5px] text-foreground/90">
          <span>
            Agreed to texts
            <span className="block text-[12px] text-muted-foreground">Automations only text contacts who did</span>
          </span>
          <Toggle checked={c.smsConsent} onChange={(v) => patch.mutate({ smsConsent: v })} label="Agreed to texts" />
        </label>
        <label className="flex items-center justify-between gap-3 text-[13.5px] text-foreground/90">
          <span>
            Do not disturb
            <span className="block text-[12px] text-muted-foreground">{c.dnd ? 'Texted STOP, or set by hand' : 'Nothing is sent while on'}</span>
          </span>
          <Toggle checked={c.dnd} onChange={(v) => patch.mutate({ dnd: v })} label="Do not disturb" />
        </label>
      </div>

      <div>
        <p className="mb-2 flex items-center gap-1.5 text-[13px] font-semibold text-foreground/90">
          <Tag className="h-3.5 w-3.5" /> Tags
        </p>
        <div className="flex flex-wrap gap-1.5">
          {c.tags.map((t) => (
            <span key={t} className="inline-flex items-center gap-1 rounded-full bg-primary-soft px-2 py-0.5 text-[12px] font-medium text-primary">
              {t}
              <button type="button" onClick={() => patch.mutate({ tags: c.tags.filter((x) => x !== t) })} className="text-primary/60 hover:text-primary" aria-label={`Remove ${t}`}>
                <X className="h-3 w-3" />
              </button>
            </span>
          ))}
          {!c.tags.length && <span className="text-[12px] text-muted-foreground/70">No tags</span>}
        </div>
        <form
          className="mt-2 flex gap-2"
          onSubmit={(e) => {
            e.preventDefault()
            if (!tag.trim()) return
            patch.mutate({ tags: [...c.tags, tag.trim().toLowerCase()] })
            setTag('')
          }}
        >
          <Input value={tag} onChange={(e) => setTag(e.target.value)} placeholder="Add a tag" className="h-8 text-[13px]" />
          <Button size="sm" type="submit" icon={<Plus className="h-3.5 w-3.5" />}>
            Add
          </Button>
        </form>
      </div>

      <div>
        <p className="mb-2 text-[13px] font-semibold text-foreground/90">Opportunities</p>
        {detail.opportunities.length ? (
          <div className="flex flex-col gap-2">
            {detail.opportunities.map((o) => (
              <Link key={o.id} href={`/hell-level/${accountId}/opportunities`} className="rounded-lg border border-border p-2.5 text-[13px] hover:bg-muted/50">
                <p className="font-medium text-foreground">{o.name}</p>
                <p className="text-[12px] text-muted-foreground">
                  {o.pipeline.name} → {o.pipeline.stages.find((s) => s.id === o.stageId)?.name ?? '—'}
                  {o.value ? ` · $${o.value.toLocaleString('en-US')}` : ''}
                </p>
                {o.status !== 'open' && <Badge color={o.status === 'won' ? 'green' : 'gray'} className="mt-1">{o.status}</Badge>}
              </Link>
            ))}
          </div>
        ) : (
          <p className="text-[12px] text-muted-foreground/70">None</p>
        )}
      </div>

      <div>
        <p className="mb-2 flex items-center gap-1.5 text-[13px] font-semibold text-foreground/90">
          <Workflow className="h-3.5 w-3.5" /> Automations
        </p>
        {detail.runs.length ? (
          <ul className="flex flex-col gap-1.5">
            {detail.runs.slice(0, 6).map((r) => (
              <li key={r.id} className="flex items-center justify-between gap-2 text-[12.5px]">
                <span className="truncate text-foreground/90">{r.workflow.name}</span>
                <span className="flex items-center gap-1.5">
                  <Badge color={r.status === 'done' ? 'green' : r.status === 'waiting' ? 'blue' : r.status === 'failed' ? 'red' : 'gray'}>{r.status === 'waiting' && r.nextRunAt ? `waiting · ${fmtDateTime(r.nextRunAt)}` : r.status}</Badge>
                  {(r.status === 'waiting' || r.status === 'running') && (
                    <button type="button" onClick={() => patch.mutate({ cancelRun: r.id })} className="text-muted-foreground/70 hover:text-destructive" title="Remove from this workflow">
                      <X className="h-3.5 w-3.5" />
                    </button>
                  )}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-[12px] text-muted-foreground/70">Not in any workflow</p>
        )}
        <div className="mt-2 flex gap-2">
          <Select value={wf} onChange={(e) => setWf(e.target.value)} className="h-8 text-[13px]">
            <option value="">Add to workflow…</option>
            {(workflows.data?.workflows ?? []).map((w) => (
              <option key={w.id} value={w.id}>
                {w.name}
                {w.status !== 'published' ? ' (draft)' : ''}
              </option>
            ))}
          </Select>
          <Button size="sm" disabled={!wf} loading={patch.isPending && !!wf} onClick={() => wf && patch.mutate({ addToWorkflow: wf }, { onSuccess: () => setWf('') })}>
            Add
          </Button>
        </div>
      </div>

      <ErrorNote error={patch.error || del.error} />

      <button
        type="button"
        onClick={() => {
          void confirmAction(`Delete ${name} and their whole conversation? This can’t be undone.`, 'Delete contact').then((ok) => ok && del.mutate())
        }}
        className="flex items-center gap-1.5 self-start text-[13px] font-medium text-destructive hover:underline"
      >
        <Trash2 className="h-3.5 w-3.5" /> Delete contact
      </button>
    </div>
  )
}
