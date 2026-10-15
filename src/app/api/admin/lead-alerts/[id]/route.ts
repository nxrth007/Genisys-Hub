import { NextResponse } from 'next/server'
import { requireStaff } from '@/lib/auth-helpers'
import { retryLeadAlert } from '@/lib/lead-alert'

/** POST /api/admin/lead-alerts/:id — re-run a logged lead (staff). */
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const denial = await requireStaff()
  if (denial) return denial
  const { id } = await params
  const result = await retryLeadAlert(id)
  return NextResponse.json(result, { status: result.reason === 'Not found.' ? 404 : 200 })
}
