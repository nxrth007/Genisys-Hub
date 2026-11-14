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
  return NextResponse.json({ status: r.status, projectId: r.projectId, messageId: r.messageId, threadId: r.threadId, message, recent })
}
