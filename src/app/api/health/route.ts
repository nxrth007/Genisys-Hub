import { NextResponse } from 'next/server'

/**
 * Used by Render's healthCheckPath to confirm the service is alive.
 * Keep this endpoint fast and dependency-free.
 */
export function GET() {
  return NextResponse.json({ ok: true, ts: Date.now() })
}
