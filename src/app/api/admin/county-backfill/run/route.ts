import { NextResponse } from 'next/server'
import { auth } from '@/auth'
import { backfillMissingCounties } from '@/lib/county-lookup'

/**
 * GET|POST /api/admin/county-backfill/run
 *
 * Manually drain the County backfill backlog (the scheduler also does
 * this automatically every tick). Admin-only. Processes a bounded
 * batch so it can't blow the request timeout or the geocoder quota —
 * re-run until `remaining` hits 0.
 *
 *   ?limit=40   how many to geocode this run (default 40, max 100)
 *
 * Only writes Appointment.county — never touches reminders, client
 * alerts, or dispatch.
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

  const result = await backfillMissingCounties(limit)

  return NextResponse.json({
    ok: true,
    ...result,
    note: result.likelyConfigError
      ? 'Every address in this batch failed to geocode — check the "Google Maps Key" vault entry + that the Geocoding API is enabled.'
      : result.remaining > 0
        ? 'More remain — run again to continue (the scheduler also drains this automatically).'
        : 'All addresses processed.',
  })
}

export async function GET(req: Request) {
  return run(req)
}

export async function POST(req: Request) {
  return run(req)
}
