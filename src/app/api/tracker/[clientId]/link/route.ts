import { NextResponse } from 'next/server'
import { requireStaff } from '@/lib/auth-helpers'
import { prisma } from '@/lib/prisma'
import { revokeStatusLinks, statusLinkPath, trackerEvents } from '@/lib/tracker/store'

/**
 * A client's read-only status link (no Google, no Hub login). Staff only.
 * Generating a link sends nothing: staff copy it and send it themselves.
 *   GET    → recent tracker history for the client
 *   POST   { rotate?: boolean } → { path: "/status/<token>" }
 *   DELETE → revoke every link for the client
 */
type Ctx = { params: Promise<{ clientId: string }> }

async function client(ctx: Ctx) {
  const { clientId } = await ctx.params
  return prisma.client.findUnique({ where: { id: clientId }, select: { id: true } })
}

export async function GET(_req: Request, ctx: Ctx) {
  const denied = await requireStaff()
  if (denied) return denied
  const c = await client(ctx)
  if (!c) return NextResponse.json({ error: 'client not found' }, { status: 404 })
  return NextResponse.json({ events: await trackerEvents(c.id) })
}

export async function POST(req: Request, ctx: Ctx) {
  const denied = await requireStaff()
  if (denied) return denied
  const c = await client(ctx)
  if (!c) return NextResponse.json({ error: 'client not found' }, { status: 404 })
  const body = (await req.json().catch(() => ({}))) as { rotate?: unknown }
  try {
    return NextResponse.json({ path: await statusLinkPath(c.id, { rotate: body?.rotate === true }) })
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'could not create link' }, { status: 503 })
  }
}

export async function DELETE(_req: Request, ctx: Ctx) {
  const denied = await requireStaff()
  if (denied) return denied
  const c = await client(ctx)
  if (!c) return NextResponse.json({ error: 'client not found' }, { status: 404 })
  await revokeStatusLinks(c.id)
  return NextResponse.json({ revoked: true })
}
