import { prisma } from '@/lib/prisma'
import type { Prisma } from '@/generated/prisma/client'
import { readProfile } from './accounts'
import { publicCalendar, teamOf, type PublicCalendar } from './booking'
import { listGroups } from './calendar-records'
import { asCalendarSettings } from './calendar-shared'
import { HlInputError } from './http'

/**
 * GHL's Service menu: one public page (/hl/m/<id>) listing service
 * calendars by their group, where people pick a service, and who they'd
 * like when the menu lets them, then book it on that calendar's own form.
 * HlRecord rows of kind service_menu.
 */

export type HlServiceMenu = {
  id: string
  name: string
  description: string
  /** The services, in the order shown. */
  calendarIds: string[]
  /** Let people pick the team member (GHL's "Enable staff selection"). */
  staffSelection: boolean
  isActive: boolean
  updatedAt: string
}

const asJson = (v: unknown) => v as Prisma.InputJsonValue
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {})
const text = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '')

function toMenu(r: { id: string; name: string; data: unknown; updatedAt: Date }): HlServiceMenu {
  const d = obj(r.data)
  return {
    id: r.id,
    name: r.name,
    description: text(d.description, 2000),
    calendarIds: Array.isArray(d.calendarIds) ? d.calendarIds.filter((x): x is string => typeof x === 'string') : [],
    staffSelection: d.staffSelection === true,
    isActive: d.isActive !== false,
    updatedAt: r.updatedAt.toISOString(),
  }
}

export async function listMenus(accountId: string): Promise<HlServiceMenu[]> {
  const rows = await prisma.hlRecord.findMany({ where: { accountId, kind: 'service_menu' }, orderBy: { name: 'asc' } })
  return rows.map(toMenu)
}

async function clean(accountId: string, raw: Record<string, unknown>, before?: HlServiceMenu) {
  const name = raw.name !== undefined ? text(raw.name, 120) : (before?.name ?? '')
  if (!name) throw new HlInputError('Name the service menu.')
  let calendarIds = before?.calendarIds ?? []
  if (raw.calendarIds !== undefined) {
    if (!Array.isArray(raw.calendarIds)) throw new HlInputError('Services must be a list.')
    const want = [...new Set(raw.calendarIds.filter((x): x is string => typeof x === 'string'))].slice(0, 100)
    const found = await prisma.hlCalendar.findMany({ where: { accountId, id: { in: want } }, select: { id: true } })
    calendarIds = want.filter((id) => found.some((f) => f.id === id))
  }
  return {
    name,
    data: {
      description: raw.description !== undefined ? text(raw.description, 2000) : (before?.description ?? ''),
      calendarIds,
      staffSelection: typeof raw.staffSelection === 'boolean' ? raw.staffSelection : (before?.staffSelection ?? false),
      isActive: typeof raw.isActive === 'boolean' ? raw.isActive : (before?.isActive ?? true),
    },
  }
}

export async function createMenu(accountId: string, raw: Record<string, unknown>): Promise<HlServiceMenu> {
  const { name, data } = await clean(accountId, raw)
  return toMenu(await prisma.hlRecord.create({ data: { accountId, kind: 'service_menu', name, data: asJson(data) } }))
}

export async function updateMenu(accountId: string, id: string, raw: Record<string, unknown>): Promise<HlServiceMenu> {
  const row = await prisma.hlRecord.findFirst({ where: { id, accountId, kind: 'service_menu' } })
  if (!row) throw new HlInputError('Service menu not found.')
  const { name, data } = await clean(accountId, raw, toMenu(row))
  return toMenu(await prisma.hlRecord.update({ where: { id }, data: { name, data: asJson({ ...obj(row.data), ...data }) } }))
}

export async function deleteMenu(accountId: string, id: string): Promise<void> {
  await prisma.hlRecord.deleteMany({ where: { id, accountId, kind: 'service_menu' } })
}

// ---------------------------------------------------------------------------
// The public page
// ---------------------------------------------------------------------------

export type MenuService = { calendar: PublicCalendar; group: string; team: { key: string; name: string }[] }
export type PublicMenu = { id: string; name: string; description: string; business: string; color: string; staffSelection: boolean; services: MenuService[] }

/** The menu as its page shows it: its live services, grouped as their calendars are; first names only when people can pick who. */
export async function publicMenu(id: string): Promise<PublicMenu | null> {
  const row = await prisma.hlRecord.findFirst({ where: { id, kind: 'service_menu' }, include: { account: { select: { name: true, profile: true, archivedAt: true } } } })
  if (!row || row.account.archivedAt) return null
  const menu = toMenu(row)
  if (!menu.isActive) return null
  const [calendars, groups] = await Promise.all([prisma.hlCalendar.findMany({ where: { accountId: row.accountId, id: { in: menu.calendarIds }, isActive: true } }), listGroups(row.accountId)])
  const services: MenuService[] = []
  for (const id of menu.calendarIds) {
    const cal = calendars.find((c) => c.id === id)
    if (!cal) continue
    const pub = await publicCalendar(cal.id)
    if (!pub) continue
    const s = asCalendarSettings(cal.settings)
    const group = groups.find((g) => g.key === s.groupId)
    const team = menu.staffSelection && cal.kind !== 'collective' ? (await teamOf(row.accountId, s)).map((m) => ({ key: m.key, name: m.name.split(/\s+/)[0] || m.name })) : []
    services.push({ calendar: pub, group: group?.name ?? 'Services', team: team.length > 1 ? team : [] })
  }
  const profile = readProfile(row.account.profile)
  return { id: menu.id, name: menu.name, description: menu.description, business: profile.businessName || row.account.name, color: services[0]?.calendar.color ?? '#155EEF', staffSelection: menu.staffSelection, services }
}
