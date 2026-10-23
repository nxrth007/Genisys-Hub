import { NextResponse } from 'next/server'
import { requireStaff } from '@/lib/auth-helpers'
import { markTrackerStep, trackerRowFor, trackerWhoForClient } from '@/lib/onboarding-tracker'

/**
 * The A2P board's "Mark Complete": checks "A2P Submitted" for this client in
 * Ethan's onboarding tracker sheet (src/lib/onboarding-tracker.ts).
 *   GET  → the client's tracker row, read-only
 *   POST → check "A2P Submitted"
 */

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const denied = await requireStaff()
  if (denied) return denied
  const { id } = await params
  const who = await trackerWhoForClient(id)
  if (!who) return NextResponse.json({ error: 'client not found' }, { status: 404 })
  return NextResponse.json(await trackerRowFor(who))
}

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const denied = await requireStaff()
  if (denied) return denied
  const { id } = await params
  const who = await trackerWhoForClient(id)
  if (!who) return NextResponse.json({ error: 'client not found' }, { status: 404 })
  return NextResponse.json({ tracker: await markTrackerStep('a2p', who) })
}
