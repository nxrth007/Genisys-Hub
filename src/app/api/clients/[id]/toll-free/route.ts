import { NextResponse } from 'next/server'
import { auth } from '@/auth'
import { prisma } from '@/lib/prisma'
import { TOLL_FREE_CHECKLIST, TOLL_FREE_INPUT_KEYS, tollFreePrefill, type TollFreeInputs } from '@/lib/toll-free'
import { isPoBox } from '@/lib/address-parse'
import { resolveAddress } from '@/lib/address-resolve'

/**
 * GET /api/clients/:id/toll-free — the Toll-Free board: what the onboarding
 * answers fill in, plus what staff typed or ticked on the board for this
 * client. PUT saves the board ({ values, checks }).
 *
 * Staff-only (admin + member), as the A2P board.
 */

type Saved = { values: Partial<TollFreeInputs>; checks: string[]; updatedAt: string | null }

const keyFor = (id: string) => `tollfree.client.${id}`
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
        },
      },
    },
  })
  if (!client) return NextResponse.json({ error: 'client not found' }, { status: 404 })

  const { intakes, seoSite, ...c } = client
  const intake = intakes[0] ?? null
  const facts = seoSite?.facts && typeof seoSite.facts === 'object' ? (seoSite.facts as { trade?: unknown }) : null
  const factsTrade = typeof facts?.trade === 'string' ? facts.trade : null
  const row = await prisma.appSetting.findUnique({ where: { key: keyFor(id) } })

  const prefill = tollFreePrefill({ ...c, intake, factsTrade })
  const address = intake?.businessAddress || c.address
  // The form only asks for one address line; the geocoder fills a missing
  // city, state or ZIP. Not for a PO box: the street address replaces it.
  let geocoded = false
  if ((!prefill.city || !prefill.state || !prefill.zip) && !isPoBox(address)) {
    const r = await resolveAddress(address, { zip: true })
    const before = [prefill.street, prefill.city, prefill.state, prefill.zip].join('|')
    prefill.street ||= r.street
    prefill.city ||= r.city
    prefill.state ||= r.stateName
    prefill.zip ||= r.zip
    geocoded = [prefill.street, prefill.city, prefill.state, prefill.zip].join('|') !== before
  }

  return NextResponse.json({
    client: { id: c.id, name: c.name, siteUrl: c.siteUrl, hasIntake: !!intake, einStatus: c.einStatus },
    prefill,
    // As typed on the form: the board says so when "Legal Business Name" got an address.
    onboardingName: intake?.businessName ?? null,
    onboardingAddress: address ?? null,
    geocoded,
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

  const values: Partial<TollFreeInputs> = {}
  if (body.values && typeof body.values === 'object') {
    for (const k of TOLL_FREE_INPUT_KEYS) {
      const val = (body.values as Record<string, unknown>)[k]
      if (typeof val === 'string') values[k] = val.slice(0, MAX_VALUE)
    }
  }
  const known = new Set(TOLL_FREE_CHECKLIST.map((c) => c.id))
  const checks = Array.isArray(body.checks) ? body.checks.filter((c): c is string => typeof c === 'string' && known.has(c)) : []

  const exists = await prisma.client.findUnique({ where: { id }, select: { id: true } })
  if (!exists) return NextResponse.json({ error: 'client not found' }, { status: 404 })

  const saved: Saved = { values, checks, updatedAt: new Date().toISOString() }
  const value = JSON.stringify(saved)
  await prisma.appSetting.upsert({ where: { key: keyFor(id) }, create: { key: keyFor(id), value }, update: { value } })
  return NextResponse.json({ saved })
}
