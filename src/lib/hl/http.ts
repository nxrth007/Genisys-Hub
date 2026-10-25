import { NextResponse } from 'next/server'
import { auth } from '@/auth'
import { prisma } from '@/lib/prisma'
import { canAccessHellLevel } from './access'
import { HL_MEMBER_ROLE } from './member-access'

/** Thrown for a bad request the person can fix; the message is shown as is. */
export class HlInputError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'HlInputError'
  }
}

/**
 * Signed in and on the Hell-level allowlist (Genisys), or the response to
 * send instead. Sub-account logins (contractors, role "hl_user") are refused
 * here: a route they may use calls hlAccountGuard instead, so everything
 * else stays Genisys-only by default.
 */
export async function hlGuard(): Promise<{ email: string } | NextResponse> {
  const session = await auth()
  const email = session?.user?.email
  if (!email) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  // A sub-account login is never Genisys, whatever its email.
  if (session?.user?.role === HL_MEMBER_ROLE || !canAccessHellLevel(email)) return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  return { email: email.toLowerCase() }
}

export type HlActor = { email: string; userId: string | null; admin: boolean }

/**
 * For a sub-account's day-to-day routes, which its own logins (Settings → My
 * Staff → Invite to log in) may use too: Genisys passes; a contractor only
 * for a sub-account they're on. Any other sub-account is "not found".
 */
export async function hlAccountGuard(accountId: string): Promise<HlActor | NextResponse> {
  const session = await auth()
  const email = session?.user?.email?.toLowerCase()
  if (!email) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  const userId = session?.user?.id || null
  if (session?.user?.role !== HL_MEMBER_ROLE) {
    if (canAccessHellLevel(email)) return { email, userId, admin: true }
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }
  if (!userId) return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  const member = await prisma.hlMember.findFirst({ where: { accountId, userId, account: { archivedAt: null } }, select: { id: true } })
  if (!member) return NextResponse.json({ error: 'Sub-account not found' }, { status: 404 })
  return { email, userId, admin: false }
}

/** Who's looking at the sub-account list: Genisys sees every one, a contractor their own (accountIds). */
export async function hlViewer(): Promise<{ email: string; admin: boolean; accountIds: string[] | null } | NextResponse> {
  const session = await auth()
  const email = session?.user?.email?.toLowerCase()
  if (!email) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  if (session?.user?.role !== HL_MEMBER_ROLE) {
    if (canAccessHellLevel(email)) return { email, admin: true, accountIds: null }
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }
  const userId = session.user.id
  const rows = userId ? await prisma.hlMember.findMany({ where: { userId, account: { archivedAt: null } }, orderBy: { createdAt: 'asc' }, select: { accountId: true } }) : []
  return { email, admin: false, accountIds: rows.map((r) => r.accountId) }
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
