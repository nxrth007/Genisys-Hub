import { NextResponse } from 'next/server'
import { getSolarApiCallsThisMonth } from '@/lib/solar'
import { requireStaff } from '@/lib/auth-helpers'

/**
 * GET /api/admin/solar/stats
 *
 * Surfaces Solar API usage so admins can spot runaway billing early:
 *   - calls       : billable upstream calls this calendar month
 *                   (= cache rows created since the 1st)
 *   - cachedTotal : every unique address ever resolved (= every
 *                   billable call ever made; subsequent lookups for
 *                   the same address hit cache and cost zero).
 */
export async function GET() {
  const denial = await requireStaff()
  if (denial) return denial
  const stats = await getSolarApiCallsThisMonth()
  return NextResponse.json(stats)
}
