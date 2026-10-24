import { NextResponse } from 'next/server'
import { hlGuard } from '@/lib/hl/http'
import { registrarStatus } from '@/lib/hl/porkbun'

/** GET: is the Porkbun account connected (sandbox or live), and its monthly spend limit. */
export async function GET() {
  const guard = await hlGuard()
  if (guard instanceof NextResponse) return guard
  return NextResponse.json(await registrarStatus())
}
