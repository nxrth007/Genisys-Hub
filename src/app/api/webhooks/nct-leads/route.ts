import { NextResponse } from 'next/server'

/**
 * POST /api/webhooks/nct-leads — retired.
 *
 * Genisys no longer resells NCT Media roofing leads, so nothing is
 * recorded or charged here any more. 410 Gone tells NCT's sender to stop,
 * rather than looking like an outage it should keep retrying. The old
 * leads and charges stay in the database (NctLead, NctBillingConfig…).
 */
const gone = () =>
  NextResponse.json(
    { ok: false, error: 'gone', note: 'Genisys no longer accepts NCT leads at this endpoint.' },
    { status: 410 },
  )

export const POST = gone
export const GET = gone
