import { createHash } from 'node:crypto'
import Anthropic from '@anthropic-ai/sdk'
import { prisma } from '@/lib/prisma'
import { requireSecret } from '@/lib/seo/secrets'
import { geocodeComponents, GEO_RESET } from '@/lib/geocode'
import { hubAlert } from '@/lib/hub-alerts'
import { isPoBox, parseUsAddress } from '@/lib/address-parse'
import {
  AI_TIDY_SCHEMA,
  CONTEXT_FIELDS,
  TIDY_FIELDS,
  TIDY_SYSTEM,
  applyTidy,
  houseNumber,
  oneLineAddress,
  parseCensusMatch,
  parseTown,
  placesToTry,
  readAiTidy,
  sameHouse,
  tidyMessage,
  tidyStreet,
  tidySummary,
  typedStreet,
  type AiTidy,
  type FoundAddress,
  type TidyAnswers,
  type TidyChange,
} from './intake-tidy-plan'

/**
 * The onboarding answers, tidied right after a client submits (Alex, 2026-11-14), and a business address
 * made whole when a toll-free filing needs it. Claude reads the answers (./intake-tidy-plan.ts says what
 * it's asked and which of its readings are kept); the US Census Bureau's address map, then Google's or
 * OpenStreetMap's, confirms the town and ZIP of a street the client typed without them.
 *
 * What changed is kept in AppSetting `intakeTidy:<intakeId>` (the client's own words stay in the intake's
 * raw submission), and the team gets one Slack line when something mattered or needs a person.
 */

const LOG_KEY = 'intakeTidy:'
/** A street the map couldn't place isn't asked about again for a day (Claude and the map cost a little each time). */
const FIX_KEY = 'addressFix:'
const FIX_RETRY_MS = 24 * 3_600_000

/** Tests swap Claude and the Census map for stubs. */
export const tidyHooks: {
  ai: ((answers: TidyAnswers) => Promise<AiTidy | null>) | null
  census: ((oneLine: string) => Promise<{ street: string; city: string; state: string; zip: string }[]>) | null
} = { ai: null, census: null }

const describe = (err: unknown) => (err instanceof Error ? err.message : String(err))

/** Claude's reading of the answers; null when it couldn't be asked (no key, unreachable, a refusal). Never throws. */
export async function askClaude(answers: TidyAnswers): Promise<AiTidy | null> {
  if (tidyHooks.ai) return tidyHooks.ai(answers)
  try {
    const client = new Anthropic({
      apiKey: await requireSecret('anthropic'),
      // An ANTHROPIC_AUTH_TOKEN in the environment alongside a key is a 401.
      authToken: null,
      maxRetries: 1,
      timeout: 90_000,
    })
    const res = await client.beta.messages.create({
      model: 'claude-opus-5-5',
      max_tokens: 8000,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      output_config: { effort: 'medium', format: { type: 'json_schema', schema: AI_TIDY_SCHEMA } },
      system: TIDY_SYSTEM,
      messages: [{ role: 'user', content: tidyMessage(answers) }],
    })
    if (res.stop_reason === 'refusal' || res.stop_reason === 'max_tokens') return null
    const out = res.content.find((b) => b.type === 'text')
    if (!out || out.type !== 'text') return null
    return readAiTidy(JSON.parse(out.text))
  } catch (err) {
    console.error('[intake-tidy] Claude:', describe(err))
    return null
  }
}

/** The US Census Bureau's address map (free, no key): the matches for one line of address. Never throws. */
async function census(oneLine: string): Promise<{ street: string; city: string; state: string; zip: string }[]> {
  if (tidyHooks.census) return tidyHooks.census(oneLine)
  try {
    const url = new URL('https://geocoding.geo.census.gov/geocoder/locations/onelineaddress')
    url.searchParams.set('address', oneLine)
    url.searchParams.set('benchmark', 'Public_AR_Current')
    url.searchParams.set('format', 'json')
    const res = await fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(20_000) })
    if (!res.ok) return []
    const j = (await res.json()) as { result?: { addressMatches?: { matchedAddress?: string }[] } }
    return (j.result?.addressMatches ?? []).map((m) => parseCensusMatch(m.matchedAddress)).filter((m): m is NonNullable<typeof m> => !!m)
  } catch {
    return []
  }
}

/**
 * Where the street the client typed is, on the address map: across a whole state when the map knows that
 * house number on that street in only one place there, else in one of the towns to try (only one ZIP
 * there), else by Google's or OpenStreetMap's map when it finds that very house number. Null when nothing
 * says for sure.
 */
export async function findStreet(street: string, places: { towns: string[]; states: string[]; typed?: string | null }): Promise<FoundAddress | null> {
  if (!houseNumber(street) || isPoBox(street)) return null
  const one = (hits: { street: string; city: string; state: string; zip: string }[]) => {
    const spots = new Set(hits.map((h) => `${h.city}|${h.zip}`))
    return hits.length && spots.size === 1 ? hits[0] : null
  }
  // The town the client typed with the street comes first: the map only fills in its ZIP.
  const typed = parseTown(places.typed)
  if (typed) {
    const hit = one((await census(`${street}, ${typed.city}, ${typed.state}`)).filter((h) => h.state === typed.state && sameHouse(h.street, street)))
    if (hit) return { street: tidyStreet(street), city: typed.city, state: typed.state, zip: hit.zip, how: `the ZIP from the US Census address map for ${typed.city}, ${typed.state}` }
  }
  for (const st of places.states) {
    const hit = one((await census(`${street}, ${st}`)).filter((h) => h.state === st && sameHouse(h.street, street)))
    if (hit) return { street: tidyStreet(street), city: hit.city, state: hit.state, zip: hit.zip, how: `the US Census address map finds that address only in ${hit.city}, ${hit.state}` }
  }
  for (const town of places.towns) {
    const want = parseTown(town)
    if (!want) continue
    const hit = one((await census(`${street}, ${want.city}, ${want.state}`)).filter((h) => h.state === want.state && sameHouse(h.street, street)))
    if (hit) return { street: tidyStreet(street), city: hit.city, state: hit.state, zip: hit.zip, how: `found on the US Census address map in ${hit.city}, ${hit.state}` }
  }
  for (const town of places.towns.slice(0, 3)) {
    const want = parseTown(town)
    if (!want) continue
    const g = await geocodeComponents(`${street}, ${want.city}, ${want.state}`).catch(() => null)
    if (g?.street && g.zip && g.state === want.state && sameHouse(g.street, street)) {
      return { street: tidyStreet(street), city: g.city || want.city, state: g.state, zip: g.zip, how: `found on the map in ${g.city || want.city}, ${g.state}` }
    }
  }
  return null
}

/** Where the business works, from its SEO facts and the first place it serves: more places to look a street up. */
function areaOf(facts: unknown, cities: string | null | undefined): { city: string | null; state: string | null }[] {
  const f = facts && typeof facts === 'object' ? (facts as Record<string, unknown>) : {}
  const s = (k: string) => (typeof f[k] === 'string' ? (f[k] as string) : null)
  const first = (cities ?? '').split(/[,;\n]|\band\b|&/i)[0]?.trim() ?? ''
  const served = parseTown(first)
  return [{ city: s('primaryCity'), state: s('state') }, ...(served ? [{ city: /\bcounty$/i.test(served.city) ? null : served.city, state: served.state }] : [])]
}

const answersOf = (row: Record<string, unknown>): TidyAnswers =>
  Object.fromEntries([...TIDY_FIELDS, ...CONTEXT_FIELDS].map((f) => [f, typeof row[f] === 'string' ? (row[f] as string) : null])) as TidyAnswers

export type TidyOutcome = {
  intakeId: string
  ai: boolean
  changes: TidyChange[]
  notes: string[]
  doubts: string[]
  address: string | null
  addressWhole: boolean
  wrote: boolean
  clientUpdated: string[]
}

/**
 * Tidy one submission's answers: Claude's reading, the address map for a street with no town or ZIP, then
 * the checks in ./intake-tidy-plan.ts. `write: false` only says what would change. Written: the intake's
 * columns, the log, and the client's copies of these answers that still read as the client typed them (its
 * name only for a client this submission just made). Never throws for an ordinary failure: Claude or the
 * map being unreachable just means less gets tidied.
 */
export async function tidyIntake(intakeId: string, o: { clientId: string | null; created: boolean; write?: boolean }): Promise<TidyOutcome | null> {
  const intake = await prisma.clientIntake.findUnique({ where: { id: intakeId } })
  if (!intake) return null
  const answers = answersOf(intake as unknown as Record<string, unknown>)
  const ai = await askClaude(answers)
  // A street with no town or ZIP: look it up where Claude, the form and the business's facts say it may be.
  const street = typedStreet(answers)
  const typed = parseUsAddress(answers.businessAddress)
  let found: FoundAddress | null = null
  if (street && !(typed.city && typed.state && typed.zip)) {
    const facts = o.clientId ? await prisma.seoSite.findFirst({ where: { clientId: o.clientId }, select: { facts: true } }).catch(() => null) : null
    found = await findStreet(street, placesToTry(answers, ai, areaOf(facts?.facts, answers.cities))).catch(() => null)
  }
  const r = applyTidy(answers, ai, found)
  const outcome: TidyOutcome = {
    intakeId,
    ai: !!ai,
    changes: r.changes,
    notes: r.notes,
    doubts: r.doubts,
    address: r.updates.businessAddress ?? answers.businessAddress ?? null,
    addressWhole: r.addressWhole,
    wrote: false,
    clientUpdated: [],
  }
  if (o.write === false) return outcome

  if (r.changes.length) await prisma.clientIntake.update({ where: { id: intakeId }, data: r.updates })
  const log = JSON.stringify({ at: new Date().toISOString(), ai: !!ai, changes: r.changes, notes: r.notes, doubts: r.doubts })
  await prisma.appSetting.upsert({ where: { key: LOG_KEY + intakeId }, create: { key: LOG_KEY + intakeId, value: log }, update: { value: log } })
  outcome.wrote = true
  if (o.clientId && r.changes.length) outcome.clientUpdated = await updateClientCopies(o.clientId, answers, r.updates, o.created).catch((err) => {
    console.warn(`[intake-tidy] client ${o.clientId}:`, describe(err))
    return []
  })
  return outcome
}

/**
 * The client record keeps its own copies of some answers (made from the intake when the client was). Each
 * is brought up to date only while it still reads exactly as the client typed it, so an edit someone made
 * in the Hub is never overwritten; the name only for a client this submission made, and only to a name no
 * other client has.
 */
async function updateClientCopies(clientId: string, typed: TidyAnswers, updates: Partial<Record<(typeof TIDY_FIELDS)[number], string>>, created: boolean): Promise<string[]> {
  const c = await prisma.client.findUnique({ where: { id: clientId }, select: { name: true, contactName: true, contactPhone: true, contactEmail: true, address: true, website: true } })
  if (!c) return []
  const same = (a: string | null | undefined, b: string | null | undefined) => (a ?? '').trim() === (b ?? '').trim()
  const data: Record<string, unknown> = {}
  if (updates.fullName && same(c.contactName, typed.fullName)) data.contactName = updates.fullName
  if (updates.customerPhone && same(c.contactPhone, typed.customerPhone)) data.contactPhone = updates.customerPhone
  if (updates.leadEmail && same(c.contactEmail, typed.leadEmail)) data.contactEmail = updates.leadEmail
  if (updates.website && same(c.website, typed.website)) data.website = updates.website
  if (updates.businessAddress && (same(c.address, typed.businessAddress) || !c.address?.trim())) data.address = updates.businessAddress
  if (created && updates.businessName && same(c.name, typed.businessName) && updates.businessName.toLowerCase() !== c.name.toLowerCase()) {
    const taken = await prisma.client.findFirst({ where: { name: { equals: updates.businessName, mode: 'insensitive' }, id: { not: clientId } }, select: { id: true } })
    if (!taken) data.name = updates.businessName
  } else if (created && updates.businessName && same(c.name, typed.businessName)) {
    // Capitals only ("concrete masonry llc" → "Concrete Masonry LLC"): the same client, better written.
    data.name = updates.businessName
  }
  if (!Object.keys(data).length) return []
  await prisma.client.update({ where: { id: clientId }, data: { ...data, ...('address' in data ? GEO_RESET : {}) } })
  return Object.keys(data)
}

/** The tidy log for one submission (what changed, notes, doubts), or null. */
export async function readTidyLog(intakeId: string): Promise<{ at: string; ai: boolean; changes: TidyChange[]; notes: string[]; doubts: string[] } | null> {
  const row = await prisma.appSetting.findUnique({ where: { key: LOG_KEY + intakeId } })
  try {
    return row ? JSON.parse(row.value) : null
  } catch {
    return null
  }
}

/**
 * The tidy for a new submission, inside a time limit so the rest of onboarding (the Hell-level
 * sub-account, SEO, the map) never waits long on Claude. Never rejects. Posts the Slack line.
 */
export async function tidyNewIntake(intakeId: string, o: { clientId: string | null; created: boolean; name: string }, ms = 120_000): Promise<TidyOutcome | null> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const work = tidyIntake(intakeId, o)
    .then(async (out) => {
      const line = out ? tidySummary(o.name, out) : null
      if (line) await hubAlert(line).catch(() => undefined)
      if (out?.changes.length) console.log(`[intake-tidy] ${intakeId}: ${out.changes.map((c) => c.field).join(', ')} tidied${out.clientUpdated.length ? `; client ${out.clientUpdated.join(', ')}` : ''}`)
      return out
    })
    .catch((err) => {
      console.error(`[intake-tidy] ${intakeId}:`, describe(err))
      return null
    })
  const late = new Promise<null>((resolve) => {
    timer = setTimeout(() => {
      console.warn(`[intake-tidy] ${intakeId}: still tidying after ${Math.round(ms / 1000)}s; onboarding goes on without waiting`)
      resolve(null)
    }, ms)
  })
  try {
    return await Promise.race([work, late])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/**
 * A business address made whole for a toll-free filing: the street they typed, with the town, state and
 * ZIP the address map confirms where the business works (its typed town, the places it serves, its facts,
 * then Claude's guesses from all its answers). Null when nothing confirms it; then a person is asked, and
 * the same address isn't looked up again for a day. Never throws.
 */
export async function completeBusinessAddress(clientId: string, address: string | null | undefined): Promise<{ address: string; how: string } | null> {
  const typed = (address ?? '').trim()
  const street = parseUsAddress(typed).street
  if (!houseNumber(street) || isPoBox(typed)) return null
  const key = `${FIX_KEY}${clientId}:${createHash('sha1').update(typed.toLowerCase()).digest('hex').slice(0, 16)}`
  try {
    const tried = await prisma.appSetting.findUnique({ where: { key } })
    if (tried && Date.now() - Date.parse(JSON.parse(tried.value).at) < FIX_RETRY_MS) return null
  } catch {
    // A bad row just means a fresh look.
  }
  try {
    const c = await prisma.client.findUnique({
      where: { id: clientId },
      select: { seoSite: { select: { facts: true } }, intakes: { orderBy: { receivedAt: 'desc' }, take: 1 } },
    })
    const intake = c?.intakes[0]
    const answers: TidyAnswers = { ...(intake ? answersOf(intake as unknown as Record<string, unknown>) : {}), businessAddress: typed }
    const area = areaOf(c?.seoSite?.facts, answers.cities)
    const typedTown = parseUsAddress(typed)
    // The map first, with what's known; Claude's guesses only when that doesn't settle it.
    let found = await findStreet(street, placesToTry(answers, null, area))
    if (!found) found = await findStreet(street, placesToTry(answers, await askClaude(answers), area))
    if (found) {
      // A ZIP or town they typed that the map disagrees with: their words lose to the map only on what they left out.
      const whole = oneLineAddress({ street: tidyStreet(street), city: typedTown.city || found.city, state: typedTown.state || found.state, zip: typedTown.zip || found.zip })
      return { address: whole, how: found.how }
    }
  } catch (err) {
    console.warn(`[intake-tidy] completing ${clientId}'s address:`, describe(err))
  }
  const value = JSON.stringify({ at: new Date().toISOString() })
  await prisma.appSetting.upsert({ where: { key }, create: { key, value }, update: { value } }).catch(() => undefined)
  return null
}
