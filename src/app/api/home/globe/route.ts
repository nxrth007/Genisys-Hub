import { after, NextResponse } from 'next/server'
import { auth } from '@/auth'
import { prisma } from '@/lib/prisma'
import { clientGeoCandidates, ensureClientGeo } from '@/lib/geocode'
import {
  HQ,
  placeFromLabel,
  type GlobeData,
  type UnplacedReason,
} from '@/lib/home-globe'

/**
 * GET /api/home/globe
 *
 * Every client on the roster as a point on the Home globe, with what the
 * hover card needs.
 *
 * Clients without coordinates are geocoded *after* the response is sent
 * (next/server `after`), one batch per process at a time, so the landing
 * page never waits on a geocoder. The page polls quickly while anything
 * is pending, and new points appear as they resolve.
 *
 * Staff-only.
 */

const PLACE_PER_BATCH = 25

// One background geocoding batch per process; ensureClientGeo's claim
// keeps separate processes (and the webhook) from doubling up on a client.
let batch: Promise<void> | null = null
function placeInBackground(ids: string[]): Promise<void> {
  if (!batch) {
    batch = (async () => {
      for (const id of ids) {
        await ensureClientGeo(id).catch((err) =>
          console.warn(`[home/globe] geocode failed for ${id}:`, err),
        )
      }
    })().finally(() => {
      batch = null
    })
  }
  return batch
}

export async function GET() {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }
  const role = (session.user as { role?: string } | undefined)?.role
  if (role !== 'admin' && role !== 'member') {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }

  const clients = await prisma.client.findMany({
    where: { archivedAt: null },
    orderBy: { createdAt: 'desc' },
    select: {
      id: true,
      name: true,
      lifecycle: true,
      siteUrl: true,
      siteLiveAt: true,
      createdAt: true,
      address: true,
      geoLat: true,
      geoLng: true,
      geoLabel: true,
      geoStatus: true,
      geoRetryAt: true,
      intakes: {
        orderBy: { receivedAt: 'desc' },
        take: 1,
        select: { receivedAt: true, businessAddress: true, cities: true },
      },
    },
  })

  const now = Date.now()
  const data: GlobeData = { hq: HQ, markers: [], unplaced: [] }
  const due: string[] = []

  for (const c of clients) {
    const intake = c.intakes[0]
    if (c.geoLat != null && c.geoLng != null) {
      data.markers.push({
        id: c.id,
        name: c.name,
        lat: c.geoLat,
        lng: c.geoLng,
        place: placeFromLabel(c.geoLabel),
        status: c.lifecycle,
        siteUrl: c.siteUrl,
        siteLiveAt: c.siteLiveAt ? c.siteLiveAt.toISOString() : null,
        onboardedAt: (intake?.receivedAt ?? c.createdAt).toISOString(),
      })
      continue
    }

    const locatable =
      clientGeoCandidates({
        address: c.address ?? intake?.businessAddress,
        cities: intake?.cities,
      }).length > 0
    const isDue = !c.geoRetryAt || c.geoRetryAt.getTime() <= now
    let reason: UnplacedReason
    if (!locatable) reason = 'no-address'
    else if (isDue) reason = 'pending'
    else if (c.geoStatus === 'not-found' || c.geoStatus === 'no-address') reason = 'not-found'
    else if (c.geoStatus === 'error') reason = 'error'
    else reason = 'pending' // 'looking-up': claimed, lookup in flight

    if (locatable && isDue) due.push(c.id)
    data.unplaced.push({ id: c.id, name: c.name, reason })
  }

  if (due.length > 0) {
    after(() => placeInBackground(due.slice(0, PLACE_PER_BATCH)))
  }

  return NextResponse.json(data)
}
