'use client'

import Link from 'next/link'
import { useState } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { CalendarDays, Copy, CopyPlus, ExternalLink, Pencil, Plus, Search, Trash2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import {
  CALENDAR_TYPES,
  WEEKDAYS,
  calendarTypeLabel,
  durationsOf,
  type HlCalendarGroup,
  type HlCalendarSettings,
  type HlDateOverride,
  type HlHours,
  type HlOpenHours,
  type HlSchedule,
} from '@/lib/hl/calendar-shared'
import type { StaffRow } from '@/lib/hl/staff'
import { useAccount } from './bits'
import { confirmAction } from './confirm'
import { Badge, Button, Card, Empty, ErrorNote, Field, Input, Modal, PageHeader, Select, Spinner, Table, Tabs, Textarea, Toggle, copyText, hlFetch } from './ui'

/**
 * Settings → Calendars, as GHL has it: Calendars (groups, the calendar list,
 * a new calendar by type), Preferences, Availability (each team member's
 * schedules) and Connections. Also the Calendars section's "Calendar
 * Settings" tab.
 */

type CalendarRow = { id: string; name: string; description: string | null; kind: string | null; isActive: boolean; ghlId: string | null; settings: HlCalendarSettings; updatedAt: string; upcoming: number }
type Data = { calendars: CalendarRow[]; staff: StaffRow[]; groups: HlCalendarGroup[] }

const SECTIONS = ['calendars', 'preferences', 'availability', 'connections'] as const
type Section = (typeof SECTIONS)[number]

export const ZONES = [
  'America/New_York',
  'America/Chicago',
  'America/Denver',
  'America/Phoenix',
  'America/Los_Angeles',
  'America/Anchorage',
  'Pacific/Honolulu',
  'America/Puerto_Rico',
  'Europe/London',
  'Europe/Dublin',
  'Australia/Sydney',
]

const lengthLabel = (m: number) => (m % 60 === 0 ? `${m / 60} hr` : m > 60 ? `${Math.floor(m / 60)} hr ${m % 60} min` : `${m} min`)
const staffKey = (s: StaffRow) => s.ghlId ?? s.id

function useCalendars(accountId: string) {
  return useQuery<Data>({ queryKey: ['hl', 'calendars', accountId], queryFn: () => hlFetch(`/api/hl/accounts/${accountId}/calendars`) })
}

export function CalendarSettingsPanel({ accountId }: { accountId: string }) {
  const sp = useSearchParams()
  const router = useRouter()
  const pathname = usePathname()
  const section: Section = SECTIONS.find((s) => s === sp.get('section')) ?? 'calendars'
  const go = (s: Section) => {
    const q = new URLSearchParams(sp.toString())
    q.set('section', s)
    router.replace(`${pathname}?${q}`)
  }
  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-5 px-6 py-6">
      <PageHeader title="Calendars" description="Booking calendars and their groups, when each person works, and the outside calendars and meeting apps they use." />
      <Tabs
        value={section}
        onChange={go}
        tabs={[
          { key: 'calendars', label: 'Calendars' },
          { key: 'preferences', label: 'Preferences' },
          { key: 'availability', label: 'Availability' },
          { key: 'connections', label: 'Connections' },
        ]}
      />
      {section === 'calendars' && <CalendarsTab accountId={accountId} />}
      {section === 'preferences' && <PreferencesTab accountId={accountId} />}
      {section === 'availability' && <AvailabilityTab accountId={accountId} />}
      {section === 'connections' && <ConnectionsTab />}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Calendars: groups and the list
// ---------------------------------------------------------------------------

function CalendarsTab({ accountId }: { accountId: string }) {
  const [sub, setSub] = useState<'calendars' | 'services' | 'rooms' | 'equipment'>('calendars')
  return (
    <div className="flex flex-col gap-4">
      <Tabs
        value={sub}
        onChange={setSub}
        tabs={[
          { key: 'calendars', label: 'Calendars' },
          { key: 'services', label: 'Service menu' },
          { key: 'rooms', label: 'Rooms' },
          { key: 'equipment', label: 'Equipment' },
        ]}
      />
      {sub === 'calendars' ? (
        <CalendarList accountId={accountId} />
      ) : (
        <Card className="px-6 py-10 text-center">
          <p className="eyebrow text-muted-foreground">Coming with service booking</p>
          <p className="mx-auto mt-2 max-w-lg text-[13px] text-muted-foreground">
            {sub === 'services'
              ? 'The service menu lists what people can book on a service booking calendar (each with its length and price), grouped into categories.'
              : sub === 'rooms'
                ? 'Rooms a service needs. A room is booked with the appointment, so two services can’t use it at once.'
                : 'Equipment a service needs, with how many of each there are, booked with the appointment.'}
          </p>
        </Card>
      )}
    </div>
  )
}

type GroupPick = 'all' | 'none' | string

function CalendarList({ accountId }: { accountId: string }) {
  const qc = useQueryClient()
  const router = useRouter()
  const q = useCalendars(accountId)
  const [group, setGroup] = useState<GroupPick>('all')
  const [status, setStatus] = useState<'all' | 'active' | 'inactive'>('all')
  const [type, setType] = useState('all')
  const [owner, setOwner] = useState('anyone')
  const [search, setSearch] = useState('')
  const [creating, setCreating] = useState(false)
  const [editingGroup, setEditingGroup] = useState<HlCalendarGroup | 'new' | null>(null)
  const refresh = () => qc.invalidateQueries({ queryKey: ['hl', 'calendars', accountId] })
  const patch = useMutation({
    mutationFn: ({ id, body }: { id: string; body: Record<string, unknown> }) => hlFetch(`/api/hl/accounts/${accountId}/calendars/${id}`, { method: 'PATCH', json: body }),
    onSuccess: refresh,
  })
  const clone = useMutation({
    mutationFn: (c: CalendarRow) => hlFetch<{ calendar: { id: string } }>(`/api/hl/accounts/${accountId}/calendars`, { method: 'POST', json: { cloneOf: c.id } }),
    onSuccess: refresh,
  })
  const remove = useMutation({
    mutationFn: (c: CalendarRow) => hlFetch(`/api/hl/accounts/${accountId}/calendars/${c.id}`, { method: 'DELETE' }),
    onSuccess: refresh,
  })
  const groupAction = useMutation({
    mutationFn: ({ g, body }: { g: HlCalendarGroup; body: Record<string, unknown> | null }) =>
      body ? hlFetch(`/api/hl/accounts/${accountId}/calendar-groups/${g.id}`, { method: 'PATCH', json: body }) : hlFetch(`/api/hl/accounts/${accountId}/calendar-groups/${g.id}`, { method: 'DELETE' }),
    onSuccess: (_d, v) => {
      if (!v.body && group === v.g.key) setGroup('all')
      refresh()
    },
  })
  const origin = typeof window === 'undefined' ? '' : window.location.origin
  const data = q.data
  const groups = data?.groups ?? []
  const groupOf = (c: CalendarRow) => (c.settings.groupId && groups.some((g) => g.key === c.settings.groupId) ? c.settings.groupId : null)
  const needle = search.trim().toLowerCase()
  const rows = (data?.calendars ?? []).filter((c) => {
    const g = groupOf(c)
    if (group === 'none' ? g : group !== 'all' && g !== group) return false
    if (status !== 'all' && c.isActive !== (status === 'active')) return false
    if (type !== 'all' && (c.kind ?? 'round_robin') !== type) return false
    if (owner !== 'anyone' && !(c.settings.teamMembers ?? []).some((m) => m.userId === owner && m.selected !== false)) return false
    return !needle || c.name.toLowerCase().includes(needle) || c.id.includes(needle) || (c.ghlId ?? '').toLowerCase().includes(needle)
  })
  const count = (pick: GroupPick) => (data?.calendars ?? []).filter((c) => (pick === 'all' ? true : pick === 'none' ? !groupOf(c) : groupOf(c) === pick)).length

  if (q.isLoading) return <div className="flex justify-center py-14"><Spinner /></div>
  return (
    <div className="grid gap-4 md:grid-cols-[220px_minmax(0,1fr)]">
      <aside className="flex flex-col gap-1">
        {(['all', 'none'] as const).map((k) => (
          <button key={k} type="button" onClick={() => setGroup(k)} className={cn('flex items-center justify-between rounded-md px-3 py-2 text-left text-[13px] transition', group === k ? 'bg-primary-soft text-foreground' : 'text-muted-foreground hover:bg-muted/50 hover:text-foreground')}>
            {k === 'all' ? 'All calendars' : 'Not grouped'}
            <span className="font-mono text-[11px] tabular-nums">{count(k)}</span>
          </button>
        ))}
        <p className="eyebrow mt-3 px-3 pb-1 text-muted-foreground">Groups</p>
        {groups.map((g) => (
          <div key={g.id} className={cn('group/row flex items-center rounded-md transition', group === g.key ? 'bg-primary-soft' : 'hover:bg-muted/50')}>
            <button type="button" onClick={() => setGroup(g.key)} className={cn('flex min-w-0 flex-1 items-center justify-between px-3 py-2 text-left text-[13px]', group === g.key ? 'text-foreground' : 'text-muted-foreground hover:text-foreground')}>
              <span className={cn('truncate', !g.isActive && 'line-through opacity-60')}>{g.name}</span>
              <span className="ml-2 font-mono text-[11px] tabular-nums">{count(g.key)}</span>
            </button>
            <button type="button" title="Edit group" onClick={() => setEditingGroup(g)} className="mr-1 hidden rounded p-1 text-muted-foreground hover:text-foreground group-hover/row:block">
              <Pencil className="h-3.5 w-3.5" />
            </button>
          </div>
        ))}
        <button type="button" onClick={() => setEditingGroup('new')} className="mt-1 flex items-center gap-1.5 rounded-md px-3 py-2 text-[13px] font-medium text-primary hover:bg-muted/50">
          <Plus className="h-3.5 w-3.5" /> New group
        </button>
      </aside>

      <div className="flex min-w-0 flex-col gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <Select className="w-auto" value={status} onChange={(e) => setStatus(e.target.value as typeof status)}>
            <option value="all">Status: All</option>
            <option value="active">Active</option>
            <option value="inactive">Inactive</option>
          </Select>
          <Select className="w-auto" value={type} onChange={(e) => setType(e.target.value)}>
            <option value="all">Type: All</option>
            {CALENDAR_TYPES.map((t) => (
              <option key={t.key} value={t.key}>
                {t.label}
              </option>
            ))}
          </Select>
          <Select className="w-auto" value={owner} onChange={(e) => setOwner(e.target.value)}>
            <option value="anyone">Owned by: Anyone</option>
            {(data?.staff ?? []).map((s) => (
              <option key={s.id} value={staffKey(s)}>
                {s.name}
              </option>
            ))}
          </Select>
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input className="w-56 pl-8" placeholder="Calendar name or id" value={search} onChange={(e) => setSearch(e.target.value)} />
          </div>
          <Button variant="primary" className="ml-auto" icon={<Plus className="h-4 w-4" />} onClick={() => setCreating(true)}>
            New calendar
          </Button>
        </div>

        <Card>
          {!rows.length ? (
            <Empty icon={<CalendarDays className="h-5 w-5" />} title={data?.calendars.length ? 'No calendars match' : 'No calendars yet'} action={!data?.calendars.length && <Button variant="primary" onClick={() => setCreating(true)}>New calendar</Button>}>
              {data?.calendars.length ? 'Change the filters or the group on the left.' : 'Make one for estimates or calls, set its hours, and put its booking page on the client’s site.'}
            </Empty>
          ) : (
            <Table head={['Calendar name', 'Group', 'Length', 'Type', 'Status', 'Updated', '']}>
              {rows.map((c) => (
                <tr key={c.id} className="border-b border-border-soft last:border-0 hover:bg-muted/40">
                  <td className="px-4 py-2.5">
                    <Link href={`/hell-level/${accountId}/calendars/${c.id}`} className="font-medium text-foreground hover:underline">
                      {c.name}
                    </Link>
                    <button type="button" onClick={() => copyText(c.id)} title="Copy the calendar id" className="flex items-center gap-1 font-mono text-[11px] text-muted-foreground hover:text-foreground">
                      {c.id} <Copy className="h-3 w-3" />
                    </button>
                  </td>
                  <td className="px-4 py-2.5">
                    <Select className="h-8 w-40 text-[12.5px]" value={groupOf(c) ?? ''} onChange={(e) => patch.mutate({ id: c.id, body: { settings: { groupId: e.target.value } } })}>
                      <option value="">Not grouped</option>
                      {groups.map((g) => (
                        <option key={g.id} value={g.key}>
                          {g.name}
                        </option>
                      ))}
                    </Select>
                  </td>
                  <td className="px-4 py-2.5 tabular-nums text-muted-foreground">{durationsOf(c.settings).map(lengthLabel).join(' / ')}</td>
                  <td className="px-4 py-2.5 text-muted-foreground">{calendarTypeLabel(c.kind)}</td>
                  <td className="px-4 py-2.5">
                    <label className="flex items-center gap-2 text-[12.5px]">
                      <Toggle checked={c.isActive} onChange={(v) => patch.mutate({ id: c.id, body: { isActive: v } })} label={c.isActive ? 'Active' : 'Inactive'} />
                      <span className={c.isActive ? 'text-success' : 'text-muted-foreground'}>{c.isActive ? 'Active' : 'Inactive'}</span>
                    </label>
                  </td>
                  <td className="whitespace-nowrap px-4 py-2.5 text-[12.5px] text-muted-foreground">{new Date(c.updatedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}</td>
                  <td className="whitespace-nowrap px-4 py-2.5 text-right">
                    <span className="inline-flex items-center gap-2.5 text-muted-foreground">
                      <Link href={`/hell-level/${accountId}/calendars/${c.id}`} title="Edit" className="hover:text-foreground">
                        <Pencil className="h-4 w-4" />
                      </Link>
                      <button type="button" title="Copy the booking link" className="hover:text-foreground" onClick={() => copyText(`${origin}/hl/b/${c.id}`)}>
                        <Copy className="h-4 w-4" />
                      </button>
                      <a href={`/hl/b/${c.id}`} target="_blank" rel="noreferrer" title="Open the booking page" className="hover:text-foreground">
                        <ExternalLink className="h-4 w-4" />
                      </a>
                      <button type="button" title="Clone" className="hover:text-foreground" onClick={() => clone.mutate(c)}>
                        <CopyPlus className="h-4 w-4" />
                      </button>
                      <button
                        type="button"
                        title="Delete"
                        className="hover:text-destructive"
                        onClick={() =>
                          void confirmAction(`Delete “${c.name}”? Its booking page stops working. Appointments already booked stay on the contacts.`, 'Delete calendar', { danger: true }).then((ok) => ok && remove.mutate(c))
                        }
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </span>
                  </td>
                </tr>
              ))}
            </Table>
          )}
        </Card>
        <ErrorNote error={q.error || patch.error || clone.error || remove.error || groupAction.error} />
      </div>

      {creating && (
        <NewCalendarModal
          accountId={accountId}
          groups={groups}
          group={group !== 'all' && group !== 'none' ? group : ''}
          onClose={() => setCreating(false)}
          onCreated={(id) => {
            refresh()
            router.push(`/hell-level/${accountId}/calendars/${id}`)
          }}
        />
      )}
      {editingGroup && (
        <GroupModal
          accountId={accountId}
          group={editingGroup === 'new' ? null : editingGroup}
          onClose={() => setEditingGroup(null)}
          onSaved={refresh}
          onToggle={(g) => groupAction.mutate({ g, body: { isActive: !g.isActive } })}
          onDelete={(g) => void confirmAction(`Delete the group “${g.name}”? Its calendars stay, without a group.`, 'Delete group', { danger: true }).then((ok) => ok && groupAction.mutate({ g, body: null }))}
        />
      )}
    </div>
  )
}

function NewCalendarModal({ accountId, groups, group, onClose, onCreated }: { accountId: string; groups: HlCalendarGroup[]; group: string; onClose: () => void; onCreated: (id: string) => void }) {
  const [kind, setKind] = useState<string | null>(null)
  const [name, setName] = useState('')
  const [groupId, setGroupId] = useState(group)
  const create = useMutation({
    mutationFn: () => hlFetch<{ calendar: { id: string } }>(`/api/hl/accounts/${accountId}/calendars`, { method: 'POST', json: { name, kind, groupId: groupId || undefined } }),
    onSuccess: (r) => {
      onClose()
      onCreated(r.calendar.id)
    },
  })
  return (
    <Modal
      open
      onClose={onClose}
      title={kind ? `New ${calendarTypeLabel(kind).toLowerCase()} calendar` : 'Choose calendar type'}
      description={kind ? 'Starts Monday to Friday, 9 to 5. Change it all after.' : 'How appointments on it are scheduled.'}
      width="max-w-2xl"
      footer={
        kind && (
          <>
            <Button onClick={() => setKind(null)}>Back</Button>
            <Button variant="primary" loading={create.isPending} disabled={!name.trim()} onClick={() => create.mutate()}>
              Create
            </Button>
          </>
        )
      }
    >
      {!kind ? (
        <div className="grid gap-2">
          {CALENDAR_TYPES.map((t) => (
            <button key={t.key} type="button" onClick={() => setKind(t.key)} className="rounded-lg border border-border px-4 py-3 text-left transition hover:border-primary hover:bg-primary-soft">
              <p className="text-[14px] font-semibold text-foreground">{t.label}</p>
              <p className="text-[12.5px] text-muted-foreground">{t.what}</p>
              <p className="text-[12px] text-muted-foreground/80">E.g.: {t.example}</p>
            </button>
          ))}
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          <Field label="Name">
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder={kind === 'class_booking' ? 'Monthly workshop' : kind === 'event' ? 'Open house' : 'Free estimate'} autoFocus />
          </Field>
          {groups.length > 0 && (
            <Field label="Group">
              <Select value={groupId} onChange={(e) => setGroupId(e.target.value)}>
                <option value="">Not grouped</option>
                {groups.map((g) => (
                  <option key={g.id} value={g.key}>
                    {g.name}
                  </option>
                ))}
              </Select>
            </Field>
          )}
          {kind === 'service_booking' && <p className="rounded-md border border-border bg-surface px-3 py-2 text-[12.5px] text-muted-foreground">Until the service menu is in, a service booking calendar books like a round robin.</p>}
          <ErrorNote error={create.error} />
        </div>
      )}
    </Modal>
  )
}

function GroupModal({
  accountId,
  group,
  onClose,
  onSaved,
  onToggle,
  onDelete,
}: {
  accountId: string
  group: HlCalendarGroup | null
  onClose: () => void
  onSaved: () => void
  onToggle: (g: HlCalendarGroup) => void
  onDelete: (g: HlCalendarGroup) => void
}) {
  const [name, setName] = useState(group?.name ?? '')
  const [description, setDescription] = useState(group?.description ?? '')
  const [slug, setSlug] = useState(group?.slug ?? '')
  const save = useMutation({
    mutationFn: () =>
      group
        ? hlFetch(`/api/hl/accounts/${accountId}/calendar-groups/${group.id}`, { method: 'PATCH', json: { name, description, slug } })
        : hlFetch(`/api/hl/accounts/${accountId}/calendar-groups`, { method: 'POST', json: { name, description, slug: slug || undefined } }),
    onSuccess: () => {
      onSaved()
      onClose()
    },
  })
  const origin = typeof window === 'undefined' ? '' : window.location.origin
  return (
    <Modal
      open
      onClose={onClose}
      title={group ? 'Edit group' : 'New group'}
      description="A group’s booking page lists its active calendars, so people pick one."
      footer={
        <div className="flex w-full flex-wrap items-center gap-2">
          {group && (
            <>
              <Button variant="ghost" className="text-destructive" onClick={() => onDelete(group)}>
                Delete
              </Button>
              <Button variant="ghost" onClick={() => onToggle(group)}>
                {group.isActive ? 'Turn off' : 'Turn on'}
              </Button>
            </>
          )}
          <span className="ml-auto" />
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={save.isPending} disabled={!name.trim()} onClick={() => save.mutate()}>
            Save
          </Button>
        </div>
      }
    >
      <div className="flex flex-col gap-3">
        <Field label="Name">
          <Input value={name} onChange={(e) => setName(e.target.value)} autoFocus />
        </Field>
        <Field label="Description" hint="Shown on the group’s booking page">
          <Textarea rows={2} value={description} onChange={(e) => setDescription(e.target.value)} />
        </Field>
        <Field label="Page address" hint="Letters, numbers and dashes">
          <Input value={slug} onChange={(e) => setSlug(e.target.value)} placeholder="made from the name" />
        </Field>
        {group && (
          <button type="button" onClick={() => copyText(`${origin}/hl/g/${group.id}`)} className="flex w-fit items-center gap-1.5 text-[12.5px] text-primary hover:underline">
            <Copy className="h-3.5 w-3.5" /> Copy the group’s booking link
          </button>
        )}
        <ErrorNote error={save.error} />
      </div>
    </Modal>
  )
}

// ---------------------------------------------------------------------------
// Preferences
// ---------------------------------------------------------------------------

type Prefs = { weekStartsOn: number; timeFormat: '12h' | '24h'; widgetLanguage: string; services: { serviceMenu: boolean; rooms: boolean; equipment: boolean } }
type Me = { meetingLocation?: string; timezone?: string }

function PreferencesTab({ accountId }: { accountId: string }) {
  const q = useQuery<{ prefs: Prefs; me: Me }>({ queryKey: ['hl', 'calendar-prefs', accountId], queryFn: () => hlFetch(`/api/hl/accounts/${accountId}/calendar-preferences`) })
  if (!q.data) return <div className="flex justify-center py-14">{q.error ? <ErrorNote error={q.error} /> : <Spinner />}</div>
  return <PreferencesForm accountId={accountId} initial={q.data} />
}

function PreferencesForm({ accountId, initial }: { accountId: string; initial: { prefs: Prefs; me: Me } }) {
  const qc = useQueryClient()
  const account = useAccount(accountId)
  const [sub, setSub] = useState<'mine' | 'account'>('mine')
  const [p, setP] = useState(initial.prefs)
  const [me, setMe] = useState(initial.me)
  const save = useMutation({
    mutationFn: () => hlFetch(`/api/hl/accounts/${accountId}/calendar-preferences`, { method: 'PUT', json: sub === 'mine' ? { me } : { weekStartsOn: p.weekStartsOn, timeFormat: p.timeFormat, services: p.services } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['hl', 'calendar-prefs', accountId] }),
  })
  const row = (label: string, hint: string, children: React.ReactNode) => (
    <div className="grid gap-3 border-b border-border-soft py-4 last:border-0 md:grid-cols-[240px_minmax(0,1fr)]">
      <div>
        <p className="text-[13.5px] font-medium text-foreground">{label}</p>
        <p className="text-[12.5px] text-muted-foreground">{hint}</p>
      </div>
      <div className="max-w-md">{children}</div>
    </div>
  )
  return (
    <Card className="px-5 py-4">
      <Tabs
        value={sub}
        onChange={(v) => {
          save.reset()
          setSub(v)
        }}
        tabs={[
          { key: 'mine', label: 'My preference' },
          { key: 'account', label: 'Account preference' },
        ]}
      />
      {sub === 'mine' ? (
        <>
          {row(
            'Meeting location',
            'Where your appointments happen when the calendar doesn’t say: an address, a phone number or a meeting link.',
            <Input value={me.meetingLocation ?? ''} onChange={(e) => setMe({ ...me, meetingLocation: e.target.value })} placeholder="e.g. a Zoom link, or the office address" />,
          )}
          {row(
            'View appointments in',
            'The timezone the Hub shows your appointments in. It doesn’t change your availability or how people book.',
            <Select value={me.timezone ?? ''} onChange={(e) => setMe({ ...me, timezone: e.target.value || undefined })}>
              <option value="">Business timezone ({account.data?.account.timezone ?? '…'})</option>
              {ZONES.map((z) => (
                <option key={z} value={z}>
                  {z.replace(/_/g, ' ')}
                </option>
              ))}
            </Select>,
          )}
        </>
      ) : (
        <>
          {row(
            'Week starts on',
            'In the calendar views and on booking pages.',
            <Select value={p.weekStartsOn} onChange={(e) => setP({ ...p, weekStartsOn: Number(e.target.value) })}>
              {WEEKDAYS.map((d, i) => (
                <option key={d} value={i}>
                  {d}
                </option>
              ))}
            </Select>,
          )}
          {row(
            'Time format',
            'How times read on booking pages.',
            <Select value={p.timeFormat} onChange={(e) => setP({ ...p, timeFormat: e.target.value === '24h' ? '24h' : '12h' })}>
              <option value="12h">1:30 PM</option>
              <option value="24h">13:30</option>
            </Select>,
          )}
          {row(
            'Services',
            'Service booking extras: the service menu, rooms and equipment.',
            <div className="flex flex-col gap-2">
              {(
                [
                  ['serviceMenu', 'Service menu'],
                  ['rooms', 'Rooms'],
                  ['equipment', 'Equipment'],
                ] as const
              ).map(([k, label]) => (
                <label key={k} className="flex items-center justify-between gap-3 text-[13px] text-foreground/90">
                  {label}
                  <Toggle checked={p.services[k]} onChange={(v) => setP({ ...p, services: { ...p.services, [k]: v } })} label={label} />
                </label>
              ))}
            </div>,
          )}
        </>
      )}
      <div className="flex items-center justify-end gap-3 pt-3">
        <ErrorNote error={save.error} />
        {save.isSuccess && <span className="text-[12.5px] text-success">Saved.</span>}
        <Button variant="primary" loading={save.isPending} onClick={() => save.mutate()}>
          Save preferences
        </Button>
      </div>
    </Card>
  )
}

// ---------------------------------------------------------------------------
// Availability: each team member's schedules
// ---------------------------------------------------------------------------

const pad = (n: number) => String(n).padStart(2, '0')
const toTime = (h: number, m: number) => `${pad(h % 24)}:${pad(m)}`
const fromTime = (v: string): [number, number] => {
  const [h, m] = v.split(':').map(Number)
  return [Number.isFinite(h) ? h : 0, Number.isFinite(m) ? m : 0]
}
const NINE_TO_FIVE: HlHours = { openHour: 9, openMinute: 0, closeHour: 17, closeMinute: 0 }

/** Weekly hours as a list of ranges per weekday (GHL keeps them as day groups). */
export function weekOf(openHours: HlOpenHours[] | undefined): HlHours[][] {
  return WEEKDAYS.map((_, d) => (openHours ?? []).filter((o) => (o.daysOfTheWeek ?? []).includes(d)).flatMap((o) => o.hours ?? []))
}
export const fromWeek = (week: HlHours[][]): HlOpenHours[] => week.flatMap((h, i) => (h.length ? [{ daysOfTheWeek: [i], hours: h }] : []))

export function HourRanges({ value, onChange }: { value: HlHours[]; onChange: (v: HlHours[]) => void }) {
  return (
    <div className="flex flex-col gap-1.5">
      {value.map((h, i) => (
        <div key={i} className="flex items-center gap-2">
          <Input
            type="time"
            className="w-32"
            value={toTime(h.openHour, h.openMinute)}
            onChange={(e) => {
              const [openHour, openMinute] = fromTime(e.target.value)
              onChange(value.map((x, j) => (j === i ? { ...x, openHour, openMinute } : x)))
            }}
          />
          <span className="text-muted-foreground">–</span>
          <Input
            type="time"
            className="w-32"
            value={toTime(h.closeHour, h.closeMinute)}
            onChange={(e) => {
              const [closeHour, closeMinute] = fromTime(e.target.value)
              onChange(value.map((x, j) => (j === i ? { ...x, closeHour, closeMinute } : x)))
            }}
          />
          <button type="button" className="text-muted-foreground hover:text-destructive" title="Remove" onClick={() => onChange(value.filter((_, j) => j !== i))}>
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        </div>
      ))}
      <button type="button" className="flex w-fit items-center gap-1 text-[12.5px] text-primary hover:underline" onClick={() => onChange([...value, value.length ? { ...NINE_TO_FIVE, openHour: 13, closeHour: 17 } : NINE_TO_FIVE])}>
        <Plus className="h-3 w-3" /> Add hours
      </button>
    </div>
  )
}

/** Weekly hours, a row a day, with "copy to every day". */
export function WeekHours({ value, onChange }: { value: HlOpenHours[] | undefined; onChange: (v: HlOpenHours[]) => void }) {
  const week = weekOf(value)
  const setDay = (d: number, h: HlHours[]) => onChange(fromWeek(week.map((x, i) => (i === d ? h : x))))
  return (
    <div className="flex flex-col divide-y divide-border-soft">
      {WEEKDAYS.map((day, d) => (
        <div key={day} className="flex flex-wrap items-start gap-4 py-2.5">
          <label className="flex w-32 items-center gap-2 pt-1.5 text-[13px] text-foreground/90">
            <input type="checkbox" checked={week[d].length > 0} onChange={(e) => setDay(d, e.target.checked ? [NINE_TO_FIVE] : [])} />
            {day}
          </label>
          {week[d].length ? <HourRanges value={week[d]} onChange={(h) => setDay(d, h)} /> : <p className="pt-1.5 text-[13px] text-muted-foreground">Unavailable</p>}
          {week[d].length > 0 && (
            <button type="button" className="ml-auto pt-1.5 text-[12px] text-muted-foreground hover:text-foreground" title="Use these hours every day it’s open" onClick={() => onChange(fromWeek(week.map((h) => (h.length ? week[d] : h))))}>
              Copy to open days
            </button>
          )}
        </div>
      ))}
    </div>
  )
}

/** Date-specific hours: a date with its own hours, or closed. */
export function DateHours({ value, onChange }: { value: HlDateOverride[] | undefined; onChange: (v: HlDateOverride[]) => void }) {
  const [date, setDate] = useState('')
  const list = (value ?? []).filter((a) => !a.deleted).map((a) => ({ ...a, date: String(a.date).slice(0, 10) }))
  return (
    <div className="flex flex-col gap-2">
      {list
        .sort((a, b) => a.date.localeCompare(b.date))
        .map((o) => (
          <div key={o.date} className="flex flex-wrap items-start gap-4 rounded-md border border-border-soft px-3 py-2">
            <p className="w-40 pt-1.5 text-[13px] font-medium text-foreground">{new Date(`${o.date}T12:00:00`).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' })}</p>
            {o.hours.length ? (
              <HourRanges value={o.hours} onChange={(h) => onChange(list.map((x) => (x.date === o.date ? { ...x, hours: h } : x)))} />
            ) : (
              <p className="pt-1.5 text-[13px] text-muted-foreground">
                Unavailable all day ·{' '}
                <button type="button" className="text-primary hover:underline" onClick={() => onChange(list.map((x) => (x.date === o.date ? { ...x, hours: [NINE_TO_FIVE] } : x)))}>
                  set hours
                </button>
              </p>
            )}
            <button type="button" className="ml-auto pt-1.5 text-muted-foreground hover:text-destructive" title="Remove" onClick={() => onChange(list.filter((x) => x.date !== o.date))}>
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          </div>
        ))}
      <div className="flex items-center gap-2">
        <Input type="date" className="w-44" value={date} onChange={(e) => setDate(e.target.value)} />
        <Button
          size="sm"
          disabled={!date || list.some((x) => x.date === date)}
          onClick={() => {
            onChange([...list, { date, hours: [] }])
            setDate('')
          }}
        >
          Add date
        </Button>
        <span className="text-[12px] text-muted-foreground">Starts as unavailable; set hours to open it.</span>
      </div>
    </div>
  )
}

function AvailabilityTab({ accountId }: { accountId: string }) {
  const cals = useCalendars(accountId)
  const q = useQuery<{ schedules: HlSchedule[] }>({ queryKey: ['hl', 'calendar-schedules', accountId], queryFn: () => hlFetch(`/api/hl/accounts/${accountId}/calendar-schedules`) })
  const staff = cals.data?.staff ?? []
  const [member, setMember] = useState<string>('')
  const [picked, setPicked] = useState<string | null>(null)
  const qc = useQueryClient()
  const account = useAccount(accountId)
  const who = member || (staff[0] ? staffKey(staff[0]) : '')
  const mine = (q.data?.schedules ?? []).filter((s) => s.userId === who)
  const current = mine.find((s) => s.id === picked) ?? mine.find((s) => s.isDefault) ?? mine[0] ?? null
  const create = useMutation({
    mutationFn: () =>
      hlFetch<{ schedule: HlSchedule }>(`/api/hl/accounts/${accountId}/calendar-schedules`, {
        method: 'POST',
        json: { userId: who, name: mine.length ? `Schedule ${mine.length + 1}` : 'Work hours', timezone: account.data?.account.timezone ?? 'America/New_York' },
      }),
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: ['hl', 'calendar-schedules', accountId] })
      setPicked(r.schedule.id)
    },
  })
  if (cals.isLoading || q.isLoading) return <div className="flex justify-center py-14"><Spinner /></div>
  if (!staff.length)
    return (
      <Card className="px-6 py-10 text-center text-[13px] text-muted-foreground">
        Schedules belong to team members. Add the team under <Link href={`/hell-level/${accountId}/settings?tab=staff`} className="text-primary hover:underline">My Staff</Link> first.
      </Card>
    )
  const onTeam = (cals.data?.calendars ?? []).filter((c) => (c.settings.teamMembers ?? []).some((m) => m.userId === who && m.selected !== false))
  return (
    <div className="flex flex-col gap-4">
      <p className="text-[13px] text-muted-foreground">A schedule sets when a team member can be booked, in their own timezone, on the calendars it’s active on. Calendars without one use their own hours.</p>
      <div className="flex flex-wrap items-center gap-2">
        <Select
          className="w-64"
          value={who}
          onChange={(e) => {
            setMember(e.target.value)
            setPicked(null)
          }}
        >
          {staff.map((s) => (
            <option key={s.id} value={staffKey(s)}>
              {s.name}
            </option>
          ))}
        </Select>
        <div className="flex flex-wrap gap-1">
          {mine.map((s) => (
            <button key={s.id} type="button" onClick={() => setPicked(s.id)} className={cn('rounded-full border px-3 py-1 text-[12.5px] transition', current?.id === s.id ? 'border-primary bg-primary-soft text-foreground' : 'border-border text-muted-foreground hover:text-foreground')}>
              {s.name}
              {s.isDefault && <span className="ml-1.5 font-mono text-[10px] uppercase text-muted-foreground">default</span>}
            </button>
          ))}
        </div>
        <Button size="sm" className="ml-auto" icon={<Plus className="h-3.5 w-3.5" />} loading={create.isPending} onClick={() => create.mutate()}>
          Create schedule
        </Button>
      </div>
      <ErrorNote error={create.error || q.error} />
      {current ? (
        <ScheduleEditor key={`${current.id}:${who}`} accountId={accountId} schedule={current} calendars={onTeam} />
      ) : (
        <Card className="px-6 py-10 text-center text-[13px] text-muted-foreground">No schedule yet: the calendars this person is on use their own hours. Create one to set their hours in one place.</Card>
      )}
    </div>
  )
}

function ScheduleEditor({ accountId, schedule, calendars }: { accountId: string; schedule: HlSchedule; calendars: CalendarRow[] }) {
  const qc = useQueryClient()
  const [s, setS] = useState(schedule)
  const refresh = () => qc.invalidateQueries({ queryKey: ['hl', 'calendar-schedules', accountId] })
  const save = useMutation({
    mutationFn: () => hlFetch(`/api/hl/accounts/${accountId}/calendar-schedules/${s.id}`, { method: 'PATCH', json: { name: s.name, timezone: s.timezone, openHours: s.openHours, availabilities: s.availabilities, calendarIds: s.calendarIds } }),
    onSuccess: refresh,
  })
  const remove = useMutation({ mutationFn: () => hlFetch(`/api/hl/accounts/${accountId}/calendar-schedules/${s.id}`, { method: 'DELETE' }), onSuccess: refresh })
  const zones = ZONES.includes(s.timezone) ? ZONES : [s.timezone, ...ZONES]
  return (
    <Card className="flex flex-col gap-5 px-5 py-5">
      <div className="grid gap-3 md:grid-cols-3">
        <Field label="Schedule name">
          <Input value={s.name} onChange={(e) => setS({ ...s, name: e.target.value })} />
        </Field>
        <Field label="Timezone">
          <Select value={s.timezone} onChange={(e) => setS({ ...s, timezone: e.target.value })}>
            {zones.map((z) => (
              <option key={z} value={z}>
                {z.replace(/_/g, ' ')}
              </option>
            ))}
          </Select>
        </Field>
        <div className="flex flex-col gap-1.5">
          <p className="text-[12.5px] font-medium text-muted-foreground">Active on</p>
          {calendars.length ? (
            <div className="flex flex-col gap-1">
              {calendars.map((c) => (
                <label key={c.id} className="flex items-center gap-2 text-[13px] text-foreground/90">
                  <input type="checkbox" checked={s.calendarIds.includes(c.id)} onChange={(e) => setS({ ...s, calendarIds: e.target.checked ? [...s.calendarIds, c.id] : s.calendarIds.filter((x) => x !== c.id) })} />
                  {c.name}
                </label>
              ))}
            </div>
          ) : (
            <p className="text-[12.5px] text-muted-foreground">Not on any calendar’s team yet. Add them to a calendar first.</p>
          )}
        </div>
      </div>
      {!s.calendarIds.length && calendars.length > 0 && <p className="rounded-md border border-warning/30 bg-warning/5 px-3 py-2 text-[12.5px] text-warning">Make this schedule active on at least one calendar to use it.</p>}
      <div>
        <p className="mb-1 text-[14px] font-semibold text-foreground">Weekly working hours</p>
        <WeekHours value={s.openHours} onChange={(openHours) => setS({ ...s, openHours })} />
      </div>
      <div>
        <p className="text-[14px] font-semibold text-foreground">Date-specific hours</p>
        <p className="mb-2 text-[12.5px] text-muted-foreground">Different hours, or a day off, on particular dates.</p>
        <DateHours value={s.availabilities} onChange={(availabilities) => setS({ ...s, availabilities })} />
      </div>
      <div className="flex items-center gap-3 border-t border-border pt-4">
        <Button variant="ghost" className="text-destructive" loading={remove.isPending} onClick={() => void confirmAction(`Delete the schedule “${s.name}”? Its calendars go back to their own hours for this person.`, 'Delete schedule', { danger: true }).then((ok) => ok && remove.mutate())}>
          Delete
        </Button>
        <span className="ml-auto" />
        <ErrorNote error={save.error || remove.error} />
        {save.isSuccess && !save.isPending && <span className="text-[12.5px] text-success">Saved.</span>}
        <Button variant="primary" loading={save.isPending} onClick={() => save.mutate()}>
          Save changes
        </Button>
      </div>
    </Card>
  )
}

// ---------------------------------------------------------------------------
// Connections
// ---------------------------------------------------------------------------

const CONNECTIONS: { group: string; items: { name: string; what: string; when: 'next' | 'later' }[] }[] = [
  {
    group: 'Calendars',
    items: [
      { name: 'Google Calendar', what: 'Two-way: busy times in Google block slots here, and bookings land in Google.', when: 'next' },
      { name: 'Outlook calendar', what: 'Office 365, Outlook.com, live.com or hotmail.', when: 'later' },
      { name: 'iCloud calendar', what: 'Apple calendars, through an app-specific password.', when: 'later' },
      { name: 'Calendly', what: 'Bring Calendly bookings in.', when: 'later' },
    ],
  },
  {
    group: 'Video conferencing',
    items: [
      { name: 'Google Meet', what: 'A Meet link for each booking (needs Google Calendar).', when: 'next' },
      { name: 'Zoom', what: 'A Zoom meeting for each booking.', when: 'later' },
      { name: 'Microsoft Teams', what: 'A Teams meeting for each booking.', when: 'later' },
    ],
  },
]

function ConnectionsTab() {
  return (
    <div className="flex flex-col gap-4">
      <p className="text-[13px] text-muted-foreground">Each team member connects their own calendar and meeting apps, so their bookings and busy times stay in step.</p>
      {CONNECTIONS.map((g) => (
        <Card key={g.group} className="px-5 py-4">
          <p className="mb-2 text-[14px] font-semibold text-foreground">{g.group}</p>
          <div className="flex flex-col divide-y divide-border-soft">
            {g.items.map((i) => (
              <div key={i.name} className="flex items-center gap-4 py-2.5">
                <div className="min-w-0 flex-1">
                  <p className="text-[13.5px] font-medium text-foreground">{i.name}</p>
                  <p className="text-[12.5px] text-muted-foreground">{i.what}</p>
                </div>
                <Badge color={i.when === 'next' ? 'blue' : 'gray'}>{i.when === 'next' ? 'Next up' : 'Later'}</Badge>
              </div>
            ))}
          </div>
        </Card>
      ))}
    </div>
  )
}
