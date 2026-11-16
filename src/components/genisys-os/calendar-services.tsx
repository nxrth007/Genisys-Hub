'use client'

import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowDown, ArrowUp, Copy, ExternalLink, Pencil, Plus, Trash2 } from 'lucide-react'
import type { HlResource, ResourceKind } from '@/lib/hl/resources'
import type { HlServiceMenu } from '@/lib/hl/service-menus'
import { confirmAction } from './confirm'
import { Badge, Button, Card, Empty, ErrorNote, Field, Input, Modal, Spinner, Table, Textarea, Toggle, copyText, hlFetch } from './ui'

/**
 * Settings → Calendars → Service menu, Rooms and Equipment, as GHL has them.
 * A service menu is a public page of service calendars; rooms and equipment
 * are what those calendars' bookings take up (src/lib/hl/resources.ts).
 */

export type CalendarPick = { id: string; name: string; kind: string | null; isActive: boolean }

const byKind = (cals: CalendarPick[]) => [...cals.filter((c) => c.kind === 'service_booking'), ...cals.filter((c) => c.kind !== 'service_booking')]
const names = (ids: string[], cals: CalendarPick[]) =>
  ids
    .map((id) => cals.find((c) => c.id === id)?.name.trim())
    .filter(Boolean)
    .join(', ')

/** Calendars to tick, service calendars first (GHL lists only those; any calendar works here). */
function CalendarChecks({ value, onChange, calendars }: { value: string[]; onChange: (v: string[]) => void; calendars: CalendarPick[] }) {
  const list = byKind(calendars)
  if (!list.length) return <p className="text-[12.5px] text-muted-foreground">No calendars yet.</p>
  return (
    <div className="flex max-h-56 flex-col gap-1 overflow-y-auto rounded-md border border-border p-2">
      {list.map((c) => (
        <label key={c.id} className="flex items-center gap-2 text-[13px] text-foreground">
          <input type="checkbox" checked={value.includes(c.id)} onChange={(e) => onChange(e.target.checked ? [...value, c.id] : value.filter((x) => x !== c.id))} />
          {c.name.trim()}
          {c.kind === 'service_booking' && <span className="text-[11px] text-muted-foreground">service</span>}
          {!c.isActive && <span className="text-[11px] text-muted-foreground">off</span>}
        </label>
      ))}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Service menus
// ---------------------------------------------------------------------------

export function ServiceMenusTab({ accountId, calendars }: { accountId: string; calendars: CalendarPick[] }) {
  const qc = useQueryClient()
  const q = useQuery<{ menus: HlServiceMenu[]; base: string }>({ queryKey: ['hl', 'service-menus', accountId], queryFn: () => hlFetch(`/api/hl/accounts/${accountId}/service-menus`) })
  const [editing, setEditing] = useState<HlServiceMenu | 'new' | null>(null)
  const [copied, setCopied] = useState<string | null>(null)
  const remove = useMutation({
    mutationFn: (id: string) => hlFetch(`/api/hl/accounts/${accountId}/service-menus/${id}`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['hl', 'service-menus', accountId] }),
  })
  const menus = q.data?.menus ?? []
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-3">
        <p className="text-[12.5px] text-muted-foreground">A page of services to book: people pick one (and who, if you let them), then a time. Each service is a calendar, booked on its own form.</p>
        <Button variant="primary" icon={<Plus className="h-3.5 w-3.5" />} onClick={() => setEditing('new')}>
          Create service menu
        </Button>
      </div>
      <ErrorNote error={q.error || remove.error} />
      {q.isLoading ? (
        <Spinner />
      ) : !menus.length ? (
        <Empty title="No service menus yet">Create one and pick the calendars it offers.</Empty>
      ) : (
        <Card className="p-0">
          <Table head={['Service menu', 'Services', 'Status', '', '']}>
            {menus.map((m) => {
              const url = `${q.data?.base ?? '/hl/m/'}${m.id}`
              return (
                <tr key={m.id} className="border-b border-border-soft last:border-0">
                  <td className="px-4 py-2.5 font-medium text-foreground">{m.name}</td>
                  <td className="max-w-80 truncate px-4 py-2.5 text-muted-foreground">{names(m.calendarIds, calendars) || 'None'}</td>
                  <td className="px-4 py-2.5">
                    <Badge color={m.isActive ? 'green' : 'gray'}>{m.isActive ? 'Live' : 'Off'}</Badge>
                  </td>
                  <td className="px-4 py-2.5">
                    <span className="flex items-center gap-3">
                      <a href={url} target="_blank" rel="noreferrer" className="text-primary hover:underline" title="Open its page">
                        <ExternalLink className="h-4 w-4" />
                      </a>
                      <button
                        type="button"
                        title="Copy its link"
                        className="text-muted-foreground hover:text-foreground"
                        onClick={() => {
                          copyText(url)
                          setCopied(m.id)
                        }}
                      >
                        <Copy className="h-4 w-4" />
                      </button>
                      {copied === m.id && <span className="text-[12px] text-success">Copied</span>}
                    </span>
                  </td>
                  <td className="px-4 py-2.5 text-right">
                    <span className="flex items-center justify-end gap-3">
                      <button type="button" title="Edit" className="text-muted-foreground hover:text-foreground" onClick={() => setEditing(m)}>
                        <Pencil className="h-4 w-4" />
                      </button>
                      <button type="button" title="Delete" className="text-muted-foreground hover:text-destructive" onClick={() => void confirmAction(`Delete the service menu “${m.name}”? Its page stops working; its calendars stay.`, 'Delete', { danger: true }).then((ok) => ok && remove.mutate(m.id))}>
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </span>
                  </td>
                </tr>
              )
            })}
          </Table>
        </Card>
      )}
      {editing && <MenuModal accountId={accountId} menu={editing === 'new' ? null : editing} calendars={calendars} onClose={() => setEditing(null)} />}
    </div>
  )
}

function MenuModal({ accountId, menu, calendars, onClose }: { accountId: string; menu: HlServiceMenu | null; calendars: CalendarPick[]; onClose: () => void }) {
  const qc = useQueryClient()
  const [name, setName] = useState(menu?.name ?? '')
  const [description, setDescription] = useState(menu?.description ?? '')
  const [ids, setIds] = useState<string[]>(menu?.calendarIds ?? [])
  const [staffSelection, setStaffSelection] = useState(menu?.staffSelection ?? false)
  const [isActive, setIsActive] = useState(menu?.isActive ?? true)
  const save = useMutation({
    mutationFn: () =>
      hlFetch(menu ? `/api/hl/accounts/${accountId}/service-menus/${menu.id}` : `/api/hl/accounts/${accountId}/service-menus`, {
        method: menu ? 'PATCH' : 'POST',
        json: { name, description, calendarIds: ids, staffSelection, isActive },
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['hl', 'service-menus', accountId] })
      onClose()
    },
  })
  const move = (i: number, d: number) => {
    const next = [...ids]
    ;[next[i], next[i + d]] = [next[i + d], next[i]]
    setIds(next)
  }
  return (
    <Modal
      open
      onClose={onClose}
      title={menu ? 'Edit service menu' : 'New service menu'}
      width="max-w-xl"
      footer={
        <div className="flex w-full items-center gap-2">
          <ErrorNote error={save.error} />
          <span className="ml-auto" />
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={save.isPending} disabled={!name.trim()} onClick={() => save.mutate()}>
            {menu ? 'Save changes' : 'Create'}
          </Button>
        </div>
      }
    >
      <div className="flex flex-col gap-4">
        <Field label="Service menu name">
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Main menu" />
        </Field>
        <Field label="Description" hint="Shown at the top of its page">
          <Textarea rows={3} value={description} onChange={(e) => setDescription(e.target.value)} />
        </Field>
        <Field label="Services" hint="The calendars it offers">
          <CalendarChecks value={ids} onChange={setIds} calendars={calendars} />
        </Field>
        {ids.length > 1 && (
          <div className="flex flex-col gap-1">
            <p className="text-[12.5px] text-muted-foreground">In this order (grouped by their calendar group on the page)</p>
            {ids.map((id, i) => (
              <div key={id} className="flex items-center gap-2 rounded-md border border-border-soft px-2.5 py-1.5 text-[13px] text-foreground">
                <span className="flex-1 truncate">{calendars.find((c) => c.id === id)?.name.trim() ?? 'A calendar'}</span>
                <button type="button" title="Up" disabled={i === 0} className="text-muted-foreground hover:text-foreground disabled:opacity-30" onClick={() => move(i, -1)}>
                  <ArrowUp className="h-3.5 w-3.5" />
                </button>
                <button type="button" title="Down" disabled={i === ids.length - 1} className="text-muted-foreground hover:text-foreground disabled:opacity-30" onClick={() => move(i, 1)}>
                  <ArrowDown className="h-3.5 w-3.5" />
                </button>
              </div>
            ))}
          </div>
        )}
        <div className="flex flex-wrap gap-x-6 gap-y-2">
          <Toggle checked={staffSelection} onChange={setStaffSelection} label="People pick who (staff selection)" />
          <Toggle checked={isActive} onChange={setIsActive} label="Live" />
        </div>
      </div>
    </Modal>
  )
}

// ---------------------------------------------------------------------------
// Rooms and equipment
// ---------------------------------------------------------------------------

export function ResourcesTab({ accountId, kind, calendars }: { accountId: string; kind: ResourceKind; calendars: CalendarPick[] }) {
  const qc = useQueryClient()
  const room = kind === 'room'
  const q = useQuery<{ resources: HlResource[] }>({ queryKey: ['hl', 'resources', accountId, kind], queryFn: () => hlFetch(`/api/hl/accounts/${accountId}/resources?kind=${kind}`) })
  const [editing, setEditing] = useState<HlResource | 'new' | null>(null)
  const remove = useMutation({
    mutationFn: (id: string) => hlFetch(`/api/hl/accounts/${accountId}/resources/${id}`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['hl', 'resources', accountId, kind] }),
  })
  const list = q.data?.resources ?? []
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-3">
        <p className="text-[12.5px] text-muted-foreground">
          {room
            ? 'A room holds so many bookings at once. A booking on a calendar that uses rooms takes one with space, so a time shows as open only while one has.'
            : 'Each booking on a calendar that uses it takes one. A time shows as open only while there’s one free (out-of-service ones don’t count).'}
        </p>
        <Button variant="primary" icon={<Plus className="h-3.5 w-3.5" />} onClick={() => setEditing('new')}>
          {room ? 'Create room' : 'Create equipment'}
        </Button>
      </div>
      <ErrorNote error={q.error || remove.error} />
      {q.isLoading ? (
        <Spinner />
      ) : !list.length ? (
        <Empty title={room ? 'No rooms yet' : 'No equipment yet'}>{room ? 'Add a room and the services that use it.' : 'Add equipment and the services that use it.'}</Empty>
      ) : (
        <Card className="p-0">
          <Table head={['Name', room ? 'Total capacity' : 'Total quantity', 'Services', 'Status', '']}>
            {list.map((r) => (
              <tr key={r.id} className="border-b border-border-soft last:border-0">
                <td className="px-4 py-2.5 font-medium text-foreground">{r.name}</td>
                <td className="px-4 py-2.5 font-mono text-muted-foreground">
                  {r.quantity}
                  {r.outOfService > 0 && <span className="ml-1 text-[12px]">({r.outOfService} out of service)</span>}
                </td>
                <td className="max-w-80 truncate px-4 py-2.5 text-muted-foreground">{names(r.calendarIds, calendars) || 'None'}</td>
                <td className="px-4 py-2.5">
                  <Badge color={r.isActive ? 'green' : 'gray'}>{r.isActive ? 'Active' : 'Off'}</Badge>
                </td>
                <td className="px-4 py-2.5 text-right">
                  <span className="flex items-center justify-end gap-3">
                    <button type="button" title="Edit" className="text-muted-foreground hover:text-foreground" onClick={() => setEditing(r)}>
                      <Pencil className="h-4 w-4" />
                    </button>
                    <button type="button" title="Delete" className="text-muted-foreground hover:text-destructive" onClick={() => void confirmAction(`Delete “${r.name}”? Its services stop needing it.`, 'Delete', { danger: true }).then((ok) => ok && remove.mutate(r.id))}>
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </span>
                </td>
              </tr>
            ))}
          </Table>
        </Card>
      )}
      {editing && <ResourceModal accountId={accountId} kind={kind} resource={editing === 'new' ? null : editing} calendars={calendars} onClose={() => setEditing(null)} />}
    </div>
  )
}

function ResourceModal({ accountId, kind, resource, calendars, onClose }: { accountId: string; kind: ResourceKind; resource: HlResource | null; calendars: CalendarPick[]; onClose: () => void }) {
  const qc = useQueryClient()
  const room = kind === 'room'
  const [name, setName] = useState(resource?.name ?? '')
  const [description, setDescription] = useState(resource?.description ?? '')
  const [quantity, setQuantity] = useState(String(resource?.quantity ?? 1))
  const [outOfService, setOutOfService] = useState(String(resource?.outOfService ?? 0))
  const [ids, setIds] = useState<string[]>(resource?.calendarIds ?? [])
  const [isActive, setIsActive] = useState(resource?.isActive ?? true)
  const save = useMutation({
    mutationFn: () =>
      hlFetch(resource ? `/api/hl/accounts/${accountId}/resources/${resource.id}` : `/api/hl/accounts/${accountId}/resources`, {
        method: resource ? 'PATCH' : 'POST',
        json: { kind, name, description, quantity: Number(quantity), ...(room ? {} : { outOfService: Number(outOfService) }), calendarIds: ids, isActive },
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['hl', 'resources', accountId, kind] })
      onClose()
    },
  })
  return (
    <Modal
      open
      onClose={onClose}
      title={`${resource ? 'Edit' : 'Add'} ${room ? 'room' : 'equipment'}`}
      width="max-w-lg"
      footer={
        <div className="flex w-full items-center gap-2">
          <ErrorNote error={save.error} />
          <span className="ml-auto" />
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={save.isPending} disabled={!name.trim()} onClick={() => save.mutate()}>
            {resource ? 'Save changes' : 'Create'}
          </Button>
        </div>
      }
    >
      <div className="flex flex-col gap-4">
        <Field label="Name">
          <Input value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="Description">
          <Textarea rows={2} value={description} onChange={(e) => setDescription(e.target.value)} />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label={room ? 'Total capacity' : 'Total quantity'} hint={room ? 'Bookings at once' : undefined}>
            <Input type="number" min={1} value={quantity} onChange={(e) => setQuantity(e.target.value)} />
          </Field>
          {!room && (
            <Field label="Out of service">
              <Input type="number" min={0} value={outOfService} onChange={(e) => setOutOfService(e.target.value)} />
            </Field>
          )}
        </div>
        <Field label="Services that use it">
          <CalendarChecks value={ids} onChange={setIds} calendars={calendars} />
        </Field>
        <Toggle checked={isActive} onChange={setIsActive} label="Active" />
      </div>
    </Modal>
  )
}
