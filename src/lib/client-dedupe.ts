import type { Prisma } from '@/generated/prisma/client'
import { prisma } from './prisma'

/**
 * Telling duplicate clients apart and finding them (merging is client-merge.ts).
 *
 * Onboarding used to link a submission to an existing client only on an
 * exact (case-insensitive) business name, so "A Plus Fence & Construction"
 * and "Aplus Construction", or a name with and without "LLC", became two
 * clients. The same signals now link a new submission to the client on
 * file (client-from-intake.ts) and flag existing pairs for a merge.
 */

const GENERIC_HOSTS = /(^|\.)(lovable\.app|gmail\.com|yahoo\.com|outlook\.com|hotmail\.com|icloud\.com|facebook\.com|google\.com|business\.site|wixsite\.com|godaddysites\.com)$/

const LEGAL_WORDS = /\b(llc|l l c|inc|incorporated|co|corp|corporation|company|ltd|pllc|the|and)\b/g
const TRADE_WORDS =
  /\b(construction|constructions|contracting|contractors?|builders?|building|roofing|roofers?|roof|solar|energy|power|fence|fencing|plumbing|hvac|heating|cooling|air|electric|electrical|remodeling|renovations?|exteriors?|interiors?|home|homes|improvements?|services?|solutions|group|enterprises?|pros?|landscaping|lawn|painting|concrete|windows?|doors?|siding|gutters?|pools?|llc)\b/g

const words = (name: string | null | undefined) =>
  (name ?? '').toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').replace(LEGAL_WORDS, ' ')

/** "A-Plus Fence & Construction, LLC" → "aplusfenceconstruction". */
export function compactName(name: string | null | undefined): string {
  return words(name).replace(/\s+/g, '')
}

/** The part of the name that isn't the trade: "A Plus Fence & Construction" → "aplus". */
export function coreName(name: string | null | undefined): string {
  return words(name).replace(TRADE_WORDS, ' ').replace(/\s+/g, '')
}

export const digits = (s: string | null | undefined) => (s ?? '').replace(/\D/g, '')

function phoneKey(s: string | null | undefined): string | null {
  const d = digits(s)
  const ten = d.length === 11 && d.startsWith('1') ? d.slice(1) : d
  return ten.length === 10 ? ten : null
}

function emailKey(s: string | null | undefined): string | null {
  const e = (s ?? '').trim().toLowerCase()
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) ? e : null
}

function einKey(s: string | null | undefined): string | null {
  const d = digits(s)
  return d.length === 9 ? d : null
}

function hostKey(url: string | null | undefined): string | null {
  const s = (url ?? '').trim()
  if (!s) return null
  try {
    const host = new URL(/^https?:\/\//i.test(s) ? s : `https://${s}`).hostname.toLowerCase().replace(/^www\./, '')
    return host.includes('.') && !GENERIC_HOSTS.test(host) ? host : null
  } catch {
    return null
  }
}

/** What identifies a business, from the client record and its onboarding answers. */
export type Identity = { names: Set<string>; cores: Set<string>; eins: Set<string>; emails: Set<string>; phones: Set<string>; hosts: Set<string> }

export type IntakeIdentity = {
  businessName: string | null
  ein: string | null
  leadEmail: string | null
  customerPhone: string | null
  website: string | null
  domainName: string | null
}

type IdentitySource = {
  name?: string | null
  contactEmail?: string | null
  contactPhone?: string | null
  website?: string | null
  siteUrl?: string | null
  intakes?: IntakeIdentity[]
}

export function identityOf(c: IdentitySource): Identity {
  const add = <T>(set: Set<T>, v: T | null) => {
    if (v) set.add(v)
  }
  const id: Identity = { names: new Set(), cores: new Set(), eins: new Set(), emails: new Set(), phones: new Set(), hosts: new Set() }
  const addName = (name: string | null | undefined) => {
    const n = compactName(name)
    const core = coreName(name)
    if (n.length >= 4) id.names.add(n)
    if (core.length >= 4) id.cores.add(core)
  }
  addName(c.name)
  add(id.emails, emailKey(c.contactEmail))
  add(id.phones, phoneKey(c.contactPhone))
  add(id.hosts, hostKey(c.website))
  add(id.hosts, hostKey(c.siteUrl))
  for (const i of c.intakes ?? []) {
    addName(i.businessName)
    add(id.eins, einKey(i.ein))
    add(id.emails, emailKey(i.leadEmail))
    add(id.phones, phoneKey(i.customerPhone))
    add(id.hosts, hostKey(i.website))
    add(id.hosts, hostKey(i.domainName))
  }
  return id
}

const SAME_NAME = 'same name, give or take spacing / LLC'
const SIMILAR_NAME = 'similar name'

/** Why two identities are the same business, strongest first. Empty when they aren't. */
export function sameBusiness(a: Identity, b: Identity): string[] {
  const shared = (x: Set<string>, y: Set<string>) => [...x].some((v) => y.has(v))
  const why: string[] = []
  if (shared(a.eins, b.eins)) why.push('same EIN')
  if (shared(a.names, b.names)) why.push(SAME_NAME)
  else if (shared(a.cores, b.cores)) why.push(SIMILAR_NAME)
  if (shared(a.emails, b.emails)) why.push('same email')
  if (shared(a.hosts, b.hosts)) why.push('same website')
  if (shared(a.phones, b.phones)) why.push('same phone')
  return why
}

const IDENTITY_SELECT = {
  id: true,
  name: true,
  contactEmail: true,
  contactPhone: true,
  website: true,
  siteUrl: true,
  intakes: { select: { businessName: true, ein: true, leadEmail: true, customerPhone: true, website: true, domainName: true } },
} satisfies Prisma.ClientSelect

/** The client on file that this submission's business already is, if exactly one is. */
export async function findClientForIntake(intake: IntakeIdentity): Promise<{ id: string; name: string; why: string } | null> {
  const mine = identityOf({ intakes: [intake] })
  const clients = await prisma.client.findMany({ select: IDENTITY_SELECT })
  const all = clients.map((c) => ({ c, why: sameBusiness(mine, identityOf(c)) })).filter((h) => h.why.length)
  // A similar name alone ("Elite Roofing" / "Elite Solar") is only a hint for the
  // duplicates list; it links a submission when something else matches too.
  const hits = all.filter((h) => !(h.why.length === 1 && h.why[0] === SIMILAR_NAME))
  if (!hits.length) return null
  // EIN or name beats a lone shared phone or email (a bookkeeper's email can cover two businesses).
  const strong = hits.filter((h) => h.why.includes('same EIN') || h.why.includes(SAME_NAME) || (h.why.includes(SIMILAR_NAME) && h.why.length > 1))
  const pick = strong.length === 1 ? strong[0] : strong.length === 0 && hits.length === 1 ? hits[0] : null
  return pick ? { id: pick.c.id, name: pick.c.name, why: pick.why.join(', ') } : null
}

// ---------------------------------------------------------------------------
// Finding pairs
// ---------------------------------------------------------------------------

const DISMISSED_KEY = 'clients.duplicates.dismissed'

export type ClientSummary = {
  id: string
  name: string
  createdAt: string
  lifecycle: string
  archived: boolean
  contactName: string | null
  contactEmail: string | null
  contactPhone: string | null
  siteUrl: string | null
  repoFullName: string | null
  ghlLocationId: string | null
  intakes: number
  users: number
  appointments: number
}

export type DuplicatePair = { a: ClientSummary; b: ClientSummary; why: string[] }

const pairKey = (x: string, y: string) => [x, y].sort().join('|')

async function dismissedPairs(): Promise<Set<string>> {
  const row = await prisma.appSetting.findUnique({ where: { key: DISMISSED_KEY } })
  try {
    return new Set(row ? (JSON.parse(row.value) as string[]) : [])
  } catch {
    return new Set()
  }
}

export async function dismissPair(a: string, b: string): Promise<void> {
  const set = await dismissedPairs()
  set.add(pairKey(a, b))
  const value = JSON.stringify([...set])
  await prisma.appSetting.upsert({ where: { key: DISMISSED_KEY }, create: { key: DISMISSED_KEY, value }, update: { value } })
}

export async function findDuplicatePairs(): Promise<DuplicatePair[]> {
  const [clients, dismissed] = await Promise.all([
    prisma.client.findMany({
      select: {
        ...IDENTITY_SELECT,
        createdAt: true,
        lifecycle: true,
        archivedAt: true,
        contactName: true,
        ghlLocationId: true,
        seoSite: { select: { repoFullName: true, archivedAt: true } },
        _count: { select: { intakes: true, users: true, appointments: true } },
      },
      orderBy: { createdAt: 'asc' },
    }),
    dismissedPairs(),
  ])
  const ids = clients.map((c) => identityOf(c))
  const summary = (c: (typeof clients)[number]): ClientSummary => ({
    id: c.id,
    name: c.name,
    createdAt: c.createdAt.toISOString(),
    lifecycle: c.lifecycle,
    archived: !!c.archivedAt,
    contactName: c.contactName,
    contactEmail: c.contactEmail,
    contactPhone: c.contactPhone,
    siteUrl: c.siteUrl,
    repoFullName: c.seoSite && !c.seoSite.archivedAt ? c.seoSite.repoFullName : null,
    ghlLocationId: c.ghlLocationId,
    intakes: c._count.intakes,
    users: c._count.users,
    appointments: c._count.appointments,
  })
  const out: DuplicatePair[] = []
  for (let i = 0; i < clients.length; i++) {
    for (let j = i + 1; j < clients.length; j++) {
      if (dismissed.has(pairKey(clients[i].id, clients[j].id))) continue
      const why = sameBusiness(ids[i], ids[j])
      if (why.length) out.push({ a: summary(clients[i]), b: summary(clients[j]), why })
    }
  }
  return out
}

