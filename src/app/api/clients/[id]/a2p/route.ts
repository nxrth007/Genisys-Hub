import { NextResponse } from 'next/server'
import { auth } from '@/auth'
import { prisma } from '@/lib/prisma'
import { A2P_CHECKLIST, A2P_INPUT_KEYS, a2pPrefill, areaHint, boardFacts, onboardingNameAndAddress, type A2pInputs } from '@/lib/a2p'
import { parseUsAddress } from '@/lib/address-parse'
import { completeAddress } from '@/lib/address-resolve'

/**
 * GET /api/clients/:id/a2p — the A2P board: what the onboarding answers
 * fill in, plus what staff typed or ticked on the board for this client.
 * PUT saves the board ({ values, checks }).
 *
 * Staff-only (admin + member); agents can reach /api/clients for the
 * booking picker, so the role is checked here.
 */

type Saved = { values: Partial<A2pInputs>; checks: string[]; updatedAt: string | null }

const keyFor = (id: string) => `a2p.client.${id}`
const MAX_VALUE = 2000

async function staff() {
  const session = await auth()
  if (!session?.user?.id) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  const role = (session.user as { role?: string } | undefined)?.role
  if (role !== 'admin' && role !== 'member') return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  return null
}

function parseSaved(raw: string | null | undefined): Saved {
  try {
    const p = raw ? (JSON.parse(raw) as Partial<Saved>) : {}
    return {
      values: p.values && typeof p.values === 'object' ? p.values : {},
      checks: Array.isArray(p.checks) ? p.checks.filter((c): c is string => typeof c === 'string') : [],
      updatedAt: typeof p.updatedAt === 'string' ? p.updatedAt : null,
    }
  } catch {
    return { values: {}, checks: [], updatedAt: null }
  }
}

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const denied = await staff()
  if (denied) return denied
  const { id } = await params

  const client = await prisma.client.findUnique({
    where: { id },
    select: {
      id: true,
      name: true,
      contactName: true,
      contactEmail: true,
      contactPhone: true,
      address: true,
      siteUrl: true,
      website: true,
      ein: true,
      einStatus: true,
      seoSite: { select: { facts: true } },
      intakes: {
        orderBy: { receivedAt: 'desc' },
        take: 1,
        select: {
          fullName: true,
          businessName: true,
          businessAddress: true,
          customerPhone: true,
          leadEmail: true,
          cities: true,
          website: true,
          domainName: true,
          yearStarted: true,
          ein: true,
          mainServices: true,
          aboutBusiness: true,
          businessContact: true,
        },
      },
    },
  })
  if (!client) return NextResponse.json({ error: 'client not found' }, { status: 404 })

  const { intakes, seoSite, ...c } = client
  const intake = intakes[0] ?? null
  const row = await prisma.appSetting.findUnique({ where: { key: keyFor(id) } })

  const src = { ...c, intake, ...boardFacts(seoSite?.facts) }
  const prefill = a2pPrefill(src)
  const { swapped, streetFromName } = onboardingNameAndAddress(src)
  // The form only asks for a business address; when the text alone doesn't
  // give a city and state, the map does (looked up once per address). That's
  // the address wherever onboarding put it (src/lib/a2p.ts); a street with no
  // town is looked up where the business works, and then gets its town,
  // state and ZIP here too.
  if (!prefill.city || !prefill.state) {
    const r = await completeAddress(prefill.address, areaHint(src))
    if (r.city && !prefill.city) prefill.city = r.city
    if (r.stateName && !prefill.state) prefill.state = r.stateName
    const typed = parseUsAddress(prefill.address)
    if (typed.street && !typed.city && !typed.state && !typed.zip && r.city && r.state) {
      prefill.address = `${typed.street}, ${r.city}, ${[r.state, r.zip].filter(Boolean).join(' ')}`
    }
    if (!prefill.primaryCities && prefill.city) prefill.primaryCities = prefill.city
  }

  return NextResponse.json({
    client: { id: c.id, name: c.name, siteUrl: c.siteUrl, hasIntake: !!intake, einStatus: c.einStatus },
    prefill,
    // As typed on the form: the board says so when "Legal Business Name" got an address, or the two boxes were swapped.
    onboardingName: intake?.businessName ?? null,
    onboardingAddress: intake?.businessAddress ?? c.address ?? null,
    streetFromName,
    swapped,
    mainServices: intake?.mainServices ?? null,
    saved: parseSaved(row?.value),
  })
}

export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const denied = await staff()
  if (denied) return denied
  const { id } = await params

  let body: { values?: unknown; checks?: unknown }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'invalid JSON body' }, { status: 400 })
  }

  const values: Partial<A2pInputs> = {}
  if (body.values && typeof body.values === 'object') {
    for (const k of A2P_INPUT_KEYS) {
      const val = (body.values as Record<string, unknown>)[k]
      if (typeof val === 'string') values[k] = val.slice(0, MAX_VALUE)
    }
  }
  const known = new Set(A2P_CHECKLIST.map((c) => c.id))
  const checks = Array.isArray(body.checks) ? body.checks.filter((c): c is string => typeof c === 'string' && known.has(c)) : []

  const exists = await prisma.client.findUnique({ where: { id }, select: { id: true } })
  if (!exists) return NextResponse.json({ error: 'client not found' }, { status: 404 })

  const saved: Saved = { values, checks, updatedAt: new Date().toISOString() }
  const value = JSON.stringify(saved)
  await prisma.appSetting.upsert({ where: { key: keyFor(id) }, create: { key: keyFor(id), value }, update: { value } })
  return NextResponse.json({ saved })
}
