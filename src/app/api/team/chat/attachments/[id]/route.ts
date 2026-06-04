import { NextResponse } from 'next/server'
import { auth } from '@/auth'
import { prisma } from '@/lib/prisma'
import { CHAT_ALLOWED_ROLES } from '@/lib/team-chat'

/**
 * GET /api/team/chat/attachments/[id]
 *
 * Streams a chat attachment's bytes back to the browser with
 * inline disposition so <img src="..."> just renders. Verbatim
 * shape of the existing /api/documents/[id] route — minus the
 * "Documents vault role gate" + plus the Team #1 role gate.
 *
 * Lives under /api/team/* so the middleware's TEAM_ALLOWED_PREFIXES
 * permits team_member access. Admin + member also pass via the
 * shared CHAT_ALLOWED_ROLES set.
 */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }
  const role = (session.user as { role?: string } | undefined)?.role ?? ''
  if (!CHAT_ALLOWED_ROLES.has(role)) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }

  const { id } = await params
  const attachment = await prisma.chatAttachment.findUnique({
    where: { id },
    select: {
      filename: true,
      mimeType: true,
      content: true,
    },
  })
  if (!attachment) {
    return NextResponse.json({ error: 'not found' }, { status: 404 })
  }

  // RFC 5987-encoded filename so non-ASCII names (uploaded from a
  // phone with a localized iOS keyboard, etc.) survive the
  // Content-Disposition header.
  const encodedName = encodeURIComponent(attachment.filename)
  const disposition = attachment.mimeType.startsWith('image/')
    ? 'inline'
    : 'attachment'

  return new Response(new Uint8Array(attachment.content), {
    headers: {
      'Content-Type': attachment.mimeType,
      'Content-Disposition': `${disposition}; filename*=UTF-8''${encodedName}`,
      // nosniff so a malicious filename can't trick the browser
      // into running uploaded bytes as a script (defensive — MIME
      // is already whitelisted at upload, but belts + suspenders).
      'X-Content-Type-Options': 'nosniff',
      // Short-lived browser cache + nothing-shared. The list query
      // already returns attachment metadata without bytes, so the
      // browser only fetches each one on its first render anyway.
      'Cache-Control': 'private, max-age=300',
    },
  })
}
