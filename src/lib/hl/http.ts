import { NextResponse } from 'next/server'
import { auth } from '@/auth'
import { prisma } from '@/lib/prisma'
import { canAccessHellLevel } from './access'

/** Thrown for a bad request the person can fix; the message is shown as is. */
export class HlInputError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'HlInputError'
  }
}

/** Signed in and on the Hell-level allowlist, or the response to send instead. */
export async function hlGuard(): Promise<{ email: string } | NextResponse> {
  const session = await auth()
  const email = session?.user?.email
  if (!email) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  if (!canAccessHellLevel(email)) return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  return { email: email.toLowerCase() }
}

/** The account, or a 404 to return. */
export async function hlAccountOr404(id: string) {
  const account = await prisma.hlAccount.findUnique({ where: { id } })
  if (!account) return NextResponse.json({ error: 'Sub-account not found' }, { status: 404 })
  return account
}

export function hlError(err: unknown, where: string): NextResponse {
  if (err instanceof HlInputError) return NextResponse.json({ error: err.message }, { status: 400 })
  console.error(`[hell-level] ${where} failed:`, err)
  return NextResponse.json({ error: err instanceof Error ? err.message : 'Something went wrong.' }, { status: 500 })
}

/** The JSON body as a record, or an HlInputError. */
export async function jsonBody(req: Request): Promise<Record<string, unknown>> {
  try {
    const body = (await req.json()) as unknown
    if (body && typeof body === 'object' && !Array.isArray(body)) return body as Record<string, unknown>
  } catch {
    // fall through
  }
  throw new HlInputError('Expected a JSON object in the request body.')
}

export const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null)
