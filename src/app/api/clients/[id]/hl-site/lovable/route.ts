import { NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/auth-helpers'
import { prisma } from '@/lib/prisma'
import { lovableMcpCall } from '@/lib/seo/lovable-mcp'

/**
 * GET /api/clients/:id/hl-site/lovable — admin only, read-only: what Lovable
 * itself reports for this client's website build, as Lovable sends it. The
 * one-shot message's state (get_message, no wait) and the project's latest
 * messages. Nothing is sent, answered or changed in Lovable.
 *
 * For working out a build Forge can't read (Cnc transportation, 2026-11-14:
 * Lovable's editor showed "Waiting for answers" while Forge still saw it as
 * building).
 */
export const dynamic = 'force-dynamic'

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const denied = await requireAdmin()
  if (denied) return denied
  const { id } = await params
  const r = await prisma.hlSiteRequest.findUnique({ where: { clientId: id }, select: { status: true, projectId: true, messageId: true, threadId: true } })
  if (!r?.projectId) return NextResponse.json({ error: 'No Lovable copy for this client yet.' }, { status: 404 })
  const read = async (tool: string, args: Record<string, unknown>) => {
    try {
      const res = await lovableMcpCall(tool, args, 60_000)
      return { structured: res.structured, text: res.text.slice(0, 20_000) }
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) }
    }
  }
  const [message, recent] = await Promise.all([
    r.messageId
      ? read('get_message', { project_id: r.projectId, message_id: r.messageId, ...(r.threadId ? { thread_id: r.threadId } : {}), wait_seconds: 0 })
      : Promise.resolve(null),
    read('list_messages', { project_id: r.projectId, limit: 5 }),
  ])
  // Each other person-side message's own state: one paused on a question holds Forge's one-shot in the queue.
  const list = 'structured' in recent && recent.structured ? ((recent.structured.messages ?? recent.structured.data) as unknown) : null
  const others = (Array.isArray(list) ? list : [])
    .map((m) => (m && typeof m === 'object' ? (m as Record<string, unknown>) : null))
    .filter((m): m is Record<string, unknown> => !!m && m.role === 'user' && typeof m.message_id === 'string' && m.message_id !== r.messageId)
    .slice(0, 3)
  const earlier = await Promise.all(
    others.map(async (m) => ({ id: m.message_id, state: await read('get_message', { project_id: r.projectId, message_id: m.message_id, ...(r.threadId ? { thread_id: r.threadId } : {}), wait_seconds: 0 }) })),
  )
  return NextResponse.json({ status: r.status, projectId: r.projectId, messageId: r.messageId, threadId: r.threadId, message, recent, earlier })
}
