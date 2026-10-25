'use client'

import Link from 'next/link'
import { useEffect, useRef, useState } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { CalendarCheck, CalendarDays, Check, ChevronDown, Copy, CopyPlus, ExternalLink, Folder, Link2, MapPin, MoreHorizontal, Pencil, Plus, Search, Trash2, Video } from 'lucide-react'
import { cn } from '@/lib/utils'
import {
  CALENDAR_TYPES,
  WEEKDAYS,
  calendarTypeLabel,
  durationsOf,
  wantsMeet,
  type HlCalendarGroup,
  type HlCalendarSettings,
  type HlDateOverride,
  type HlHours,
  type HlOpenHours,
  type HlSchedule,
} from '@/lib/hl/calendar-shared'
import type { StaffRow } from '@/lib/hl/staff'
import { useAccount } from './bits'
import { ResourcesTab, ServiceMenusTab } from './calendar-services'
import { confirmAction } from './confirm'
import { Avatar, Badge, Button, Card, Empty, ErrorNote, Field, Input, Modal, PageHeader, Select, Spinner, Tabs, Textarea, Toggle, copyText, hlFetch } from './ui'

/**
 * Settings → Calendars, as GHL has it: Calendars (groups, the calendar list,
 * a new calendar by type), Service menu, Rooms, Equipment, Preferences,
 * Availability (each team member's schedules) and Connections, in one row of
 * tabs. The calendars are cards, active ones first. Also the Calendars
 * section's "Calendar Settings" tab.
 */

type CalendarRow = { id: string; name: string; description: string | null; kind: string | null; isActive: boolean; ghlId: string | null; settings: HlCalendarSettings; updatedAt: string; upcoming: number }
type Data = { calendars: CalendarRow[]; staff: StaffRow[]; groups: HlCalendarGroup[] }

const SECTIONS = ['calendars', 'services', 'rooms', 'equipment', 'preferences', 'availability', 'connections'] as const
type Section = (typeof SECTIONS)[number]
const SECTION_LABEL: Record<Section, string> = {
  calendars: 'Calendars',
  services: 'Service menu',
  rooms: 'Rooms',
  equipment: 'Equipment',
  preferences: 'Preferences',
  availability: 'Availability',
  connections: 'Connections',
}

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
  const cals = useCalendars(accountId)
  const [creating, setCreating] = useState(false)
  const go = (s: Section) => {
    const q = new URLSearchParams(sp.toString())
    q.set('section', s)
    q.delete('gcal_connected')
    q.delete('gcal_error')
    router.replace(`${pathname}?${q}`)
  }
  const calendars = cals.data?.calendars ?? []
  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-5 px-6 py-6">
      <PageHeader
        title="Calendars"
        description="Booking calendars and their groups, when each person works, and the outside calendars and meeting apps they use."
        actions={
          section === 'calendars' && (
            <Button variant="primary" icon={<Plus className="h-4 w-4" />} onClick={() => setCreating(true)}>
              New calendar
            </Button>
          )
        }
      />
      <SectionTabs value={section} onChange={go} count={cals.data ? calendars.length : undefined} />
      {section === 'calendars' && <CalendarList accountId={accountId} creating={creating} onCreating={setCreating} />}
      {section === 'services' && <ServiceMenusTab accountId={accountId} calendars={calendars} />}
      {section === 'rooms' && <ResourcesTab accountId={accountId} kind="room" calendars={calendars} />}
      {section === 'equipment' && <ResourcesTab accountId={accountId} kind="equipment" calendars={calendars} />}
      {section === 'preferences' && <PreferencesTab accountId={accountId} />}
      {section === 'availability' && <AvailabilityTab accountId={accountId} />}
      {section === 'connections' && <ConnectionsTab accountId={accountId} />}
    </div>
  )
}

/** One row of tabs: GHL's Calendars sub-tabs, then the settings around them. */
function SectionTabs({ value, onChange, count }: { value: Section; onChange: (s: Section) => void; count?: number }) {
  const tab = (s: Section) => (
    <button
      key={s}
      type="button"
      onClick={() => onChange(s)}
      className={cn(
        '-mb-px flex shrink-0 items-center gap-1.5 border-b-2 px-3 pb-2.5 pt-1 text-[13px] font-medium transition',
        value === s ? 'border-primary text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground',
      )}
    >
      {SECTION_LABEL[s]}
      {s === 'calendars' && count !== undefined && <span className="rounded-full bg-muted px-1.5 font-mono text-[10.5px] tabular-nums text-muted-foreground">{count}</span>}
    </button>
  )
  return (
    <div className="flex items-end gap-1 overflow-x-auto border-b border-border">
      {(['calendars', 'services', 'rooms', 'equipment'] as const).map((s) => tab(s))}
      <span className="mx-2 mb-3 h-4 w-px shrink-0 bg-border" aria-hidden />
      {(['preferences', 'availability', 'connections'] as const).map((s) => tab(s))}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Calendars: groups and the list
// ---------------------------------------------------------------------------

type GroupPick = 'all' | 'none' | string

function CalendarList({ accountId, creating, onCreating }: { accountId: string; creating: boolean; onCreating: (v: boolean) => void }) {
  const qc = useQueryClient()
  const router = useRouter()
  const q = useCalendars(accountId)
  const [group, setGroup] = useState<GroupPick>('all')
  const [type, setType] = useState('all')
  const [owner, setOwner] = useState('anyone')
  const [search, setSearch] = useState('')
  const [showInactive, setShowInactive] = useState(false)
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
  const data = q.data
  const groups = data?.groups ?? []
  const staff = data?.staff ?? []
  const groupOf = (c: CalendarRow) => (c.settings.groupId && groups.some((g) => g.key === c.settings.groupId) ? c.settings.groupId : null)
  const needle = search.trim().toLowerCase()
  const filtering = !!needle || type !== 'all' || owner !== 'anyone'
  const rows = (data?.calendars ?? []).filter((c) => {
    const g = groupOf(c)
    if (group === 'none' ? g : group !== 'all' && g !== group) return false
    if (type !== 'all' && (c.kind ?? 'round_robin') !== type) return false
    if (owner !== 'anyone' && !(c.settings.teamMembers ?? []).some((m) => m.userId === owner && m.selected !== false)) return false
    return !needle || c.name.toLowerCase().includes(needle) || c.id.includes(needle) || (c.ghlId ?? '').toLowerCase().includes(needle)
  })
  const active = rows.filter((c) => c.isActive)
  const inactive = rows.filter((c) => !c.isActive)
  const count = (pick: GroupPick) => (data?.calendars ?? []).filter((c) => (pick === 'all' ? true : pick === 'none' ? !groupOf(c) : groupOf(c) === pick)).length
  const clear = () => {
    setSearch('')
    setType('all')
    setOwner('anyone')
  }
  const picked = groups.find((g) => g.key === group) ?? null
  const card = (c: CalendarRow) => (
    <CalendarCard
      key={c.id}
      c={c}
      accountId={accountId}
      staff={staff}
      groups={groups}
      group={groupOf(c)}
      showGroup={group === 'all'}
      onToggle={(v) => patch.mutate({ id: c.id, body: { isActive: v } })}
      onMove={(key) => patch.mutate({ id: c.id, body: { settings: { groupId: key } } })}
      onClone={() => clone.mutate(c)}
      onDelete={() => void confirmAction(`Delete “${c.name}”? Its booking page stops working. Appointments already booked stay on the contacts.`, 'Delete calendar', { danger: true }).then((ok) => ok && remove.mutate(c))}
    />
  )

  if (q.isLoading) return <div className="flex justify-center py-14"><Spinner /></div>
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative min-w-[200px] flex-1 sm:max-w-xs">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input className="pl-8" placeholder="Search calendars" value={search} onChange={(e) => setSearch(e.target.value)} />
          </div>
          <Select className="w-auto" value={type} onChange={(e) => setType(e.target.value)}>
            <option value="all">Any type</option>
            {CALENDAR_TYPES.map((t) => (
              <option key={t.key} value={t.key}>
                {t.label}
              </option>
            ))}
          </Select>
          <Select className="w-auto" value={owner} onChange={(e) => setOwner(e.target.value)}>
            <option value="anyone">Any host</option>
            {staff.map((s) => (
              <option key={s.id} value={staffKey(s)}>
                {s.name}
              </option>
            ))}
          </Select>
          {filtering && (
            <button type="button" onClick={clear} className="px-1 text-[12.5px] text-muted-foreground hover:text-foreground">
              Clear
            </button>
          )}
        </div>
        {/* GHL's groups: each has a booking page listing its calendars. */}
        <div className="flex flex-wrap items-center gap-1.5">
          <GroupChip label="All calendars" n={count('all')} on={group === 'all'} onClick={() => setGroup('all')} />
          {groups.length > 0 && <GroupChip label="Not grouped" n={count('none')} on={group === 'none'} onClick={() => setGroup('none')} />}
          {groups.map((g) => (
            <GroupChip key={g.id} label={g.name} n={count(g.key)} on={group === g.key} off={!g.isActive} onClick={() => setGroup(g.key)} />
          ))}
          <button type="button" onClick={() => setEditingGroup('new')} className="flex h-7 items-center gap-1 rounded-full px-2.5 text-[12.5px] font-medium text-primary hover:bg-primary-soft">
            <Plus className="h-3.5 w-3.5" /> New group
          </button>
        </div>
        {picked && <GroupBar group={picked} onEdit={() => setEditingGroup(picked)} />}
      </div>

      {!data?.calendars.length ? (
        <Card>
          <Empty icon={<CalendarDays className="h-5 w-5" />} title="No calendars yet" action={<Button variant="primary" onClick={() => onCreating(true)}>New calendar</Button>}>
            Make one for estimates or calls, set its hours, and put its booking page on the client’s site.
          </Empty>
        </Card>
      ) : !rows.length ? (
        <Card>
          <Empty icon={<CalendarDays className="h-5 w-5" />} title="No calendars match" action={filtering && <Button onClick={clear}>Clear the filters</Button>}>
            {filtering ? 'Nothing here matches the search and filters.' : 'This group has no calendars yet: move one in from its ⋯ menu.'}
          </Empty>
        </Card>
      ) : (
        <>
          {active.length > 0 && (
            <section className="flex flex-col gap-2.5">
              <p className="eyebrow text-muted-foreground">Active · {active.length}</p>
              <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">{active.map(card)}</div>
            </section>
          )}
          {inactive.length > 0 && (
            <section className="flex flex-col gap-2.5">
              {active.length > 0 && !filtering ? (
                <button type="button" onClick={() => setShowInactive((v) => !v)} className="eyebrow flex w-fit items-center gap-1.5 text-muted-foreground hover:text-foreground">
                  Inactive · {inactive.length}
                  <ChevronDown className={cn('h-3.5 w-3.5 transition', showInactive && 'rotate-180')} />
                </button>
              ) : (
                <p className="eyebrow text-muted-foreground">Inactive · {inactive.length}</p>
              )}
              {(showInactive || filtering || !active.length) && <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">{inactive.map(card)}</div>}
            </section>
          )}
        </>
      )}
      <ErrorNote error={q.error || patch.error || clone.error || remove.error || groupAction.error} />

      {creating && (
        <NewCalendarModal
          accountId={accountId}
          groups={groups}
          group={group !== 'all' && group !== 'none' ? group : ''}
          onClose={() => onCreating(false)}
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

function GroupChip({ label, n, on, off, onClick }: { label: string; n: number; on: boolean; off?: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'flex h-7 items-center gap-1.5 rounded-full border px-2.5 text-[12.5px] transition',
        on ? 'border-primary bg-primary font-medium text-primary-foreground' : 'border-border text-muted-foreground hover:border-primary/40 hover:text-foreground',
      )}
    >
      <span className={cn('max-w-[180px] truncate', off && 'line-through opacity-60')}>{label}</span>
      <span className="font-mono text-[10.5px] tabular-nums opacity-80">{n}</span>
    </button>
  )
}

/** The picked group: its booking page and its settings. */
function GroupBar({ group, onEdit }: { group: HlCalendarGroup; onEdit: () => void }) {
  const [copied, setCopied] = useState(false)
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-border bg-surface px-3 py-2 text-[12.5px]">
      <span className="font-medium text-foreground">{group.name}</span>
      <span className="text-muted-foreground">{group.isActive ? (group.description || 'Its booking page lists its active calendars.') : 'Turned off: its booking page is closed.'}</span>
      <span className="ml-auto flex items-center gap-1">
        <button
          type="button"
          onClick={() => {
            copyText(`${window.location.origin}/hl/g/${group.id}`)
            setCopied(true)
            window.setTimeout(() => setCopied(false), 1500)
          }}
          className="flex items-center gap-1.5 rounded-md px-2 py-1 text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          {copied ? <Check className="h-3.5 w-3.5 text-success" /> : <Link2 className="h-3.5 w-3.5" />} {copied ? 'Copied' : 'Copy group link'}
        </button>
        <button type="button" onClick={onEdit} className="flex items-center gap-1.5 rounded-md px-2 py-1 text-muted-foreground hover:bg-muted hover:text-foreground">
          <Pencil className="h-3.5 w-3.5" /> Edit group
        </button>
      </span>
    </div>
  )
}

const HEX = /^#[0-9a-f]{3}(?:[0-9a-f]{3})?$/i

/** One calendar at a glance: what it is, who takes the bookings, what's coming up, and its links. */
function CalendarCard({
  c,
  accountId,
  staff,
  groups,
  group,
  showGroup,
  onToggle,
  onMove,
  onClone,
  onDelete,
}: {
  c: CalendarRow
  accountId: string
  staff: StaffRow[]
  groups: HlCalendarGroup[]
  group: string | null
  showGroup: boolean
  onToggle: (v: boolean) => void
  onMove: (groupKey: string) => void
  onClone: () => void
  onDelete: () => void
}) {
  const [copied, setCopied] = useState<'link' | 'id' | null>(null)
  const flash = (what: 'link' | 'id', text: string) => {
    copyText(text)
    setCopied(what)
    window.setTimeout(() => setCopied(null), 1500)
  }
  const edit = `/hell-level/${accountId}/calendars/${c.id}`
  const members = (c.settings.teamMembers ?? []).filter((m) => m.selected !== false)
  const hosts = members.map((m) => staff.find((s) => staffKey(s) === m.userId)).filter((s): s is StaffRow => !!s)
  const unknown = members.length - hosts.length
  const meet = c.settings.meetingType === 'google_meet' || members.some((m) => wantsMeet(c.settings, m.userId))
  const place = !meet && c.settings.meetingLocation?.trim()
  const color = c.settings.eventColor && HEX.test(c.settings.eventColor) ? c.settings.eventColor : null
  const groupName = group ? groups.find((g) => g.key === group)?.name : null
  const who = hosts.length
    ? `${hosts
        .slice(0, 2)
        .map((h) => h.name)
        .join(', ')}${hosts.length + unknown > 2 ? ` +${hosts.length + unknown - 2}` : ''}`
    : unknown
      ? `${unknown} team member${unknown === 1 ? '' : 's'}`
      : c.kind === 'event'
        ? 'No host: seats only'
        : 'Nobody on it yet'

  return (
    // Above the cards after it while its ⋯ menu is open (an inactive card's dimming would otherwise bury the menu).
    <div className={cn('relative flex flex-col rounded-lg border border-border bg-card transition hover:border-primary/40 has-[[aria-expanded=true]]:z-20', !c.isActive && 'opacity-75')}>
      {color && <span className="absolute inset-y-3 left-0 w-[3px] rounded-r" style={{ background: color }} aria-hidden />}
      <div className="flex items-start gap-3 px-4 pt-3.5">
        <div className="min-w-0 flex-1">
          <Link href={edit} className="line-clamp-2 text-[14px] font-semibold leading-snug text-foreground hover:underline" title={c.name}>
            {c.name}
          </Link>
          <p className="mt-0.5 text-[12.5px] text-muted-foreground">
            {calendarTypeLabel(c.kind)} · {durationsOf(c.settings).map(lengthLabel).join(' / ')}
          </p>
        </div>
        <Toggle checked={c.isActive} onChange={onToggle} label={c.isActive ? 'Active: turn off' : 'Inactive: turn on'} />
      </div>

      <div className="flex items-center gap-2 px-4 pt-3">
        {hosts.length > 0 && (
          <span className="flex -space-x-1.5">
            {hosts.slice(0, 3).map((h) => (
              <span key={h.id} className="rounded-full ring-2 ring-card" title={h.name}>
                <Avatar name={h.name} size={22} />
              </span>
            ))}
          </span>
        )}
        <span className="truncate text-[12.5px] text-foreground/80">{who}</span>
      </div>

      <div className="flex flex-wrap gap-1.5 px-4 pb-3 pt-2.5">
        {c.upcoming > 0 && (
          <Fact icon={<CalendarCheck className="h-3 w-3" />} strong>
            {c.upcoming} upcoming
          </Fact>
        )}
        {meet && <Fact icon={<Video className="h-3 w-3" />}>Google Meet</Fact>}
        {place && (
          <Fact icon={<MapPin className="h-3 w-3" />} title={place}>
            {place}
          </Fact>
        )}
        {showGroup && groupName && <Fact icon={<Folder className="h-3 w-3" />}>{groupName}</Fact>}
      </div>

      <div className="mt-auto flex items-center gap-0.5 border-t border-border-soft px-2 py-1.5 text-[12px]">
        <button type="button" onClick={() => flash('link', `${window.location.origin}/hl/b/${c.id}`)} className="flex items-center gap-1.5 rounded-md px-2 py-1 text-muted-foreground transition hover:bg-muted hover:text-foreground">
          {copied === 'link' ? <Check className="h-3.5 w-3.5 text-success" /> : <Link2 className="h-3.5 w-3.5" />}
          {copied === 'link' ? 'Copied' : 'Copy link'}
        </button>
        <a href={`/hl/b/${c.id}`} target="_blank" rel="noreferrer" className="flex items-center gap-1.5 rounded-md px-2 py-1 text-muted-foreground transition hover:bg-muted hover:text-foreground">
          <ExternalLink className="h-3.5 w-3.5" /> Preview
        </a>
        <Link href={edit} className="ml-auto flex items-center gap-1.5 rounded-md px-2 py-1 text-muted-foreground transition hover:bg-muted hover:text-foreground">
          <Pencil className="h-3.5 w-3.5" /> Edit
        </Link>
        <MoreMenu>
          {(close) => (
            <>
              {groups.length > 0 && (
                <>
                  <p className="eyebrow px-3 pb-1 pt-2 text-muted-foreground">Group</p>
                  {[{ key: '', name: 'Not grouped' }, ...groups].map((g) => (
                    <MenuItem
                      key={g.key || 'none'}
                      onClick={() => {
                        close()
                        if ((group ?? '') !== g.key) onMove(g.key)
                      }}
                    >
                      <span className="w-3.5">{(group ?? '') === g.key && <Check className="h-3.5 w-3.5 text-primary" />}</span>
                      <span className="truncate">{g.name}</span>
                    </MenuItem>
                  ))}
                  <div className="my-1 h-px bg-border-soft" />
                </>
              )}
              <MenuItem
                onClick={() => {
                  close()
                  onClone()
                }}
              >
                <CopyPlus className="h-3.5 w-3.5" /> Clone
              </MenuItem>
              <MenuItem onClick={() => flash('id', c.id)}>
                {copied === 'id' ? <Check className="h-3.5 w-3.5 text-success" /> : <Copy className="h-3.5 w-3.5" />} {copied === 'id' ? 'Copied' : 'Copy calendar id'}
              </MenuItem>
              <div className="my-1 h-px bg-border-soft" />
              <MenuItem
                danger
                onClick={() => {
                  close()
                  onDelete()
                }}
              >
                <Trash2 className="h-3.5 w-3.5" /> Delete
              </MenuItem>
            </>
          )}
        </MoreMenu>
      </div>
    </div>
  )
}

function Fact({ icon, strong, title, children }: { icon?: React.ReactNode; strong?: boolean; title?: string; children: React.ReactNode }) {
  return (
    <span title={title} className={cn('inline-flex max-w-full items-center gap-1 rounded-md bg-muted/60 px-1.5 py-0.5 text-[11.5px]', strong ? 'text-foreground/90' : 'text-muted-foreground')}>
      {icon && <span className="shrink-0">{icon}</span>}
      <span className="truncate">{children}</span>
    </span>
  )
}

function MoreMenu({ children }: { children: (close: () => void) => React.ReactNode }) {
  const [open, setOpen] = useState(false)
  const box = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false)
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [open])
  return (
    <div ref={box} className="relative">
      <button type="button" title="More" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)} className="grid h-7 w-7 place-items-center rounded-md text-muted-foreground transition hover:bg-muted hover:text-foreground">
        <MoreHorizontal className="h-4 w-4" />
      </button>
      {open && (
        <div role="menu" className="absolute right-0 top-full z-30 mt-1 w-52 overflow-hidden rounded-lg border border-border bg-popover py-1 shadow-pop">
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  )
}

function MenuItem({ onClick, danger, children }: { onClick: () => void; danger?: boolean; children: React.ReactNode }) {
  return (
    <button type="button" role="menuitem" onClick={onClick} className={cn('flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12.5px] transition hover:bg-muted', danger ? 'text-destructive' : 'text-foreground/90')}>
      {children}
    </button>
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

type Connection = { id: string; staffKey: string; staffId: string; email: string; calendarId: string; checkIds: string[]; conflicts: boolean; push: boolean; pull: boolean; connectedAt: string; error: string | null }
type GoogleCal = { id: string; name: string; primary: boolean; canWrite: boolean }

const LATER: { group: string; items: { name: string; what: string }[] }[] = [
  {
    group: 'Other calendars',
    items: [
      { name: 'Outlook calendar', what: 'Office 365, Outlook.com, live.com or hotmail.' },
      { name: 'iCloud calendar', what: 'Apple calendars, through an app-specific password.' },
      { name: 'Calendly', what: 'Bring Calendly bookings in.' },
    ],
  },
  {
    group: 'Other video conferencing',
    items: [
      { name: 'Zoom', what: 'A Zoom meeting for each booking.' },
      { name: 'Microsoft Teams', what: 'A Teams meeting for each booking.' },
    ],
  },
]

/** GHL's Connections: each team member's own Google Calendar (busy times in, bookings out), and Google Meet. */
function ConnectionsTab({ accountId }: { accountId: string }) {
  const sp = useSearchParams()
  const cals = useCalendars(accountId)
  const conns = useQuery<{ connections: Connection[]; googleApp: 'hl' | 'hub' | null; googleAppNote: string | null }>({ queryKey: ['hl', 'calendar-connections', accountId], queryFn: () => hlFetch(`/api/hl/accounts/${accountId}/calendar-connections`) })
  const staff = cals.data?.staff ?? []
  const list = conns.data?.connections ?? []
  const connFor = (m: StaffRow) => list.find((c) => c.staffId === m.id || c.staffKey === staffKey(m))
  const connected = sp.get('gcal_connected')
  const failed = sp.get('gcal_error')
  // Calendars that make a Meet link for someone, and who on them isn't connected (so gets none).
  const meet = (cals.data?.calendars ?? []).flatMap((c) => {
    const members = (c.settings.teamMembers ?? []).filter((m) => m.selected !== false && wantsMeet(c.settings, m.userId))
    if (!members.length) return []
    const missing = members.filter((m) => !list.some((x) => x.push && (x.staffKey === m.userId || x.staffId === m.userId))).map((m) => staff.find((x) => staffKey(x) === m.userId || x.id === m.userId)?.name ?? 'A team member')
    return [{ id: c.id, name: c.name, missing }]
  })

  return (
    <div className="flex flex-col gap-4">
      {connected && <p className="rounded-md border border-success/30 bg-success/5 px-3 py-2 text-[13px] text-success">Google Calendar connected: {connected}.</p>}
      {failed && <p className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-[13px] text-destructive">Google Calendar didn’t connect: {failed}</p>}
      <Card className="px-5 py-4">
        <div className="flex items-start gap-3">
          <div className="min-w-0 flex-1">
            <p className="text-[14px] font-semibold text-foreground">Google Calendar</p>
            <p className="text-[12.5px] text-muted-foreground">
              Each team member connects their own Google account. Busy times on it stop people booking them then, as soon as Google says they’ve changed. Their appointments go into it, moving or coming off when they’re rescheduled or cancelled, and a booking moved or deleted in Google moves or cancels the appointment, as in GHL. Send them a link to connect it themselves (it works for a week), or connect here if it’s your own.
            </p>
          </div>
        </div>
        {conns.data && conns.data.googleApp === null && (
          <p className="mt-3 rounded-md border border-warning/30 bg-warning/5 px-3 py-2 text-[12.5px] text-warning">No Google app is set up for calendar connections yet. Add Hell-level’s to the Vault as “Hell Level Calendar” (its client ID) and “Hell Level Calendar Secret”.</p>
        )}
        {conns.data?.googleApp === 'hub' && (
          <p className="mt-3 rounded-md border border-warning/30 bg-warning/5 px-3 py-2 text-[12.5px] text-warning">
            Connections sign in through the Hub’s own Google app for now, which works for Genisys’s own Google accounts only. For contractors’ accounts, add Hell-level’s own Google app to the Vault as “Hell Level Calendar” (its client ID) and “Hell Level Calendar Secret”.
          </p>
        )}
        {conns.data?.googleAppNote && <p className="mt-3 rounded-md border border-warning/30 bg-warning/5 px-3 py-2 text-[12.5px] text-warning">{conns.data.googleAppNote}</p>}
        {conns.data?.googleApp === 'hl' && !conns.data.googleAppNote && (
          <p className="mt-3 text-[12.5px] text-muted-foreground">
            Connections sign in through Hell-level’s own Google app. Until Google verifies it, people see Google’s “unverified app” screen first and click Advanced to carry on.
          </p>
        )}
        <ErrorNote error={cals.error || conns.error} />
        {(cals.isLoading || conns.isLoading) && <Spinner />}
        {!cals.isLoading && !staff.length && <p className="mt-3 text-[13px] text-muted-foreground">No team members yet: add them under Settings → My Staff.</p>}
        <div className="mt-2 flex flex-col divide-y divide-border-soft">
          {staff.map((m) => (
            <StaffConnection key={m.id} accountId={accountId} member={m} conn={connFor(m)} onCalendars={(cals.data?.calendars ?? []).filter((c) => (c.settings.teamMembers ?? []).some((t) => t.selected !== false && (t.userId === staffKey(m) || t.userId === m.id))).length} />
          ))}
        </div>
      </Card>

      <Card className="px-5 py-4">
        <p className="text-[14px] font-semibold text-foreground">Google Meet</p>
        <p className="text-[12.5px] text-muted-foreground">
          A calendar set to Google Meet (its Details → Meeting type) gets a Meet link made for each booking, on the team member’s Google Calendar. The link becomes the appointment’s location, so {'{{appointment.location}}'} in its texts carries it. Calendars brought over from GHL with Meet keep it.
        </p>
        {meet.length > 0 ? (
          <div className="mt-2 flex flex-col divide-y divide-border-soft">
            {meet.map((c) => (
              <div key={c.id} className="flex flex-wrap items-center gap-3 py-2">
                <Link href={`/hell-level/${accountId}/calendars/${c.id}`} className="text-[13.5px] font-medium text-foreground hover:underline">
                  {c.name}
                </Link>
                {c.missing.length ? <span className="text-[12.5px] text-warning">No Meet link for {c.missing.join(', ')} until their Google Calendar is connected.</span> : <Badge color="green">Ready</Badge>}
              </div>
            ))}
          </div>
        ) : (
          !cals.isLoading && <p className="mt-2 text-[12.5px] text-muted-foreground">No calendar uses Google Meet yet.</p>
        )}
      </Card>

      {LATER.map((g) => (
        <Card key={g.group} className="px-5 py-4">
          <p className="mb-2 text-[14px] font-semibold text-foreground">{g.group}</p>
          <div className="flex flex-col divide-y divide-border-soft">
            {g.items.map((i) => (
              <div key={i.name} className="flex items-center gap-4 py-2.5">
                <div className="min-w-0 flex-1">
                  <p className="text-[13.5px] font-medium text-foreground">{i.name}</p>
                  <p className="text-[12.5px] text-muted-foreground">{i.what}</p>
                </div>
                <Badge color="gray">Later</Badge>
              </div>
            ))}
          </div>
        </Card>
      ))}
    </div>
  )
}

function StaffConnection({ accountId, member, conn, onCalendars }: { accountId: string; member: StaffRow; conn: Connection | undefined; onCalendars: number }) {
  const qc = useQueryClient()
  const [copied, setCopied] = useState(false)
  const [choosing, setChoosing] = useState(false)
  const refresh = () => qc.invalidateQueries({ queryKey: ['hl', 'calendar-connections', accountId] })
  const start = useMutation({
    mutationFn: (action: 'connect' | 'link') => hlFetch<{ url: string }>(`/api/hl/accounts/${accountId}/calendar-connections`, { method: 'POST', json: { staffKey: staffKey(member), action } }),
    onSuccess: (r, action) => {
      if (action === 'connect') {
        window.location.href = r.url
      } else {
        copyText(r.url)
        setCopied(true)
      }
    },
  })
  const patch = useMutation({
    mutationFn: (body: Partial<Pick<Connection, 'conflicts' | 'push' | 'pull' | 'calendarId' | 'checkIds'>>) => hlFetch(`/api/hl/accounts/${accountId}/calendar-connections/${conn!.id}`, { method: 'PATCH', json: body }),
    onSuccess: refresh,
  })
  const remove = useMutation({
    mutationFn: () => hlFetch(`/api/hl/accounts/${accountId}/calendar-connections/${conn!.id}`, { method: 'DELETE' }),
    onSuccess: refresh,
  })
  return (
    <div className="flex flex-col gap-2 py-3">
      <div className="flex flex-wrap items-center gap-3">
        <div className="min-w-0 flex-1">
          <p className="text-[13.5px] font-medium text-foreground">
            {member.name}
            <span className="ml-2 text-[12px] font-normal text-muted-foreground">
              {[member.email, onCalendars ? `on ${onCalendars} calendar${onCalendars === 1 ? '' : 's'}` : 'on no calendars'].filter(Boolean).join(' · ')}
            </span>
          </p>
          <p className="text-[12.5px] text-muted-foreground">
            {conn ? (
              <>
                Connected as <span className="text-foreground">{conn.email}</span>
              </>
            ) : (
              'Not connected'
            )}
          </p>
        </div>
        {conn ? (
          <>
            {conn.error ? <Badge color="red">Needs attention</Badge> : <Badge color="green">Connected</Badge>}
            <Button size="sm" variant="ghost" onClick={() => setChoosing((v) => !v)}>
              {choosing ? 'Done' : 'Calendars'}
            </Button>
            <Button size="sm" variant="ghost" loading={start.isPending && start.variables === 'link'} icon={<Copy className="h-3.5 w-3.5" />} onClick={() => start.mutate('link')}>
              {copied ? 'Link copied' : 'Reconnect link'}
            </Button>
            <Button size="sm" variant="ghost" className="text-destructive" loading={remove.isPending} onClick={() => void confirmAction(`Disconnect ${conn.email}? Busy times there stop blocking ${member.name}’s slots and new bookings stop going into it (ones already there stay).`, 'Disconnect').then((ok) => ok && remove.mutate())}>
              Disconnect
            </Button>
          </>
        ) : (
          <>
            <Button size="sm" loading={start.isPending && start.variables === 'link'} icon={<Copy className="h-3.5 w-3.5" />} onClick={() => start.mutate('link')}>
              {copied ? 'Link copied' : 'Copy connect link'}
            </Button>
            <Button size="sm" variant="ghost" loading={start.isPending && start.variables === 'connect'} icon={<ExternalLink className="h-3.5 w-3.5" />} onClick={() => start.mutate('connect')} title="Signs in to Google in this browser: for your own calendar">
              Connect here
            </Button>
          </>
        )}
      </div>
      {conn?.error && (
        <p className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-[12.5px] text-destructive">
          Google says: {conn.error}. {/invalid_grant|expired|revoked/i.test(conn.error) ? 'The sign-in has been withdrawn: send them a reconnect link.' : /has not been used|is disabled|accessNotConfigured/i.test(conn.error) ? 'The Google Calendar API is off in the Hub’s Google Cloud project: turn it on there.' : ''}
        </p>
      )}
      {conn && (
        <div className="flex flex-wrap gap-x-6 gap-y-2 pl-0.5">
          {[
            { label: 'Busy times block bookings', on: conn.conflicts, set: (v: boolean) => patch.mutate({ conflicts: v }) },
            { label: 'Add bookings to Google Calendar', on: conn.push, set: (v: boolean) => patch.mutate({ push: v }) },
            { label: 'Moves and deletions in Google change the appointment', on: conn.pull, set: (v: boolean) => patch.mutate({ pull: v }), off: !conn.push },
          ].map((t) => (
            <label key={t.label} className={cn('flex items-center gap-2 text-[12.5px] text-foreground/90', t.off && 'opacity-50')}>
              <Toggle checked={t.on} disabled={patch.isPending || !!t.off} onChange={t.set} label={t.label} />
              {t.label}
            </label>
          ))}
        </div>
      )}
      {conn && choosing && <ChooseCalendars accountId={accountId} conn={conn} onSave={(v) => patch.mutateAsync(v).then(() => setChoosing(false))} saving={patch.isPending} />}
      <ErrorNote error={start.error || patch.error || remove.error} />
    </div>
  )
}

/** GHL's linked calendar (where bookings go) and conflict calendars (whose busy times count). */
function ChooseCalendars({ accountId, conn, onSave, saving }: { accountId: string; conn: Connection; onSave: (v: { calendarId: string; checkIds: string[] }) => Promise<unknown>; saving: boolean }) {
  const q = useQuery<{ calendars: GoogleCal[] }>({ queryKey: ['hl', 'google-calendars', conn.id], queryFn: () => hlFetch(`/api/hl/accounts/${accountId}/calendar-connections/${conn.id}`) })
  const [into, setInto] = useState(conn.calendarId)
  const [check, setCheck] = useState<string[]>(conn.checkIds)
  const items = q.data?.calendars ?? []
  return (
    <div className="flex flex-col gap-3 rounded-md border border-border bg-muted/30 p-3">
      {q.isLoading && <Spinner />}
      <ErrorNote error={q.error} />
      {items.length > 0 && (
        <>
          <Field label="Bookings go into">
            <Select value={into} onChange={(e) => setInto(e.target.value)}>
              {items
                .filter((c) => c.canWrite)
                .map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                    {c.primary ? ' (main)' : ''}
                  </option>
                ))}
            </Select>
          </Field>
          <div>
            <p className="text-[12.5px] font-medium text-foreground">Check these for busy times</p>
            <div className="mt-1 flex flex-col gap-1">
              {items.map((c) => (
                <label key={c.id} className="flex items-center gap-2 text-[13px] text-foreground">
                  <input type="checkbox" checked={check.includes(c.id)} onChange={(e) => setCheck(e.target.checked ? [...check, c.id] : check.filter((x) => x !== c.id))} />
                  {c.name}
                  {c.primary ? ' (main)' : ''}
                </label>
              ))}
            </div>
          </div>
          <div>
            <Button size="sm" variant="primary" loading={saving} onClick={() => void onSave({ calendarId: into, checkIds: check })}>
              Save calendars
            </Button>
          </div>
        </>
      )}
    </div>
  )
}
