import { NextResponse } from 'next/server'
import { auth } from '@/auth'
import { prisma } from '@/lib/prisma'
import { lookupCountyForAddress } from '@/lib/county-lookup'

/**
 * GET|POST /api/admin/county-backfill/run
 *
 * Populate Appointment.county for existing appointments that have an
 * address but no county yet (geocoding only fills new bookings + edits
 * going forward). Admin-only. Processes a bounded batch per call so a
 * run can't blow the request timeout or the geocoder quota — re-run
 * until `remaining` hits 0.
 *
 *   ?limit=40   how many to geocode this run (default 40, max 100)
 */
const DEFAULT_LIMIT = 40
const MAX_LIMIT = 100

async function run(req: Request) {
  const session = await auth()
  const role = (session?.user as { role?: string } | undefined)?.role
  if (role !== 'admin') {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }

  const url = new URL(req.url)
  const limit = Math.min(
    MAX_LIMIT,
    Math.max(1, Number(url.searchParams.get('limit')) || DEFAULT_LIMIT),
  )

  // Count what's left so the caller knows whether to run again.
  const remainingBefore = await prisma.appointment.count({
    where: { county: null, address: { not: null } },
  })

  const batch = await prisma.appointment.findMany({
    where: { county: null, address: { not: null } },
    select: { id: true, address: true },
    orderBy: { createdAt: 'desc' },
    take: limit,
  })

  let filled = 0
  let unresolved = 0
  const samples: string[] = []
  for (const appt of batch) {
    try {
      const county = await lookupCountyForAddress(appt.address)
      if (county) {
        await prisma.appointment.update({
          where: { id: appt.id },
          data: { county },
        })
        filled++
        if (samples.length < 8) samples.push(county)
      } else {
        unresolved++
      }
    } catch {
      unresolved++
    }
  }

  return NextResponse.json({
    ok: true,
    scanned: batch.length,
    filled,
    unresolved,
    remaining: Math.max(0, remainingBefore - filled),
    sampleCounties: samples,
    note:
      remainingBefore - filled > 0
        ? 'More remain — run this again to continue.'
        : 'All addresses processed.',
  })
}

export async function GET(req: Request) {
  return run(req)
}

export async function POST(req: Request) {
  return run(req)
}
