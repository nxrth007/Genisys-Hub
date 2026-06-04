import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/auth'
import { prisma } from '@/lib/prisma'
import {
  CHAT_ALLOWED_ROLES,
  CHAT_PHOTO_ALLOWED_MIMES,
  CHAT_PHOTO_MAX_BYTES,
} from '@/lib/team-chat'

/**
 * GET  /api/team/chat/channels/[id]/messages — list (most-recent
 *      first, paginated by ?before=<iso> for "load older"). The
 *      UI flips the order client-side so it renders bottom-up.
 *
 * POST /api/team/chat/channels/[id]/messages — multipart/form-data
 *      with `text` (string, optional when files are attached) +
 *      `file` (zero or more, image/jpeg or image/png, max 5 MB
 *      each). Returns the created message + serialized attachments
 *      so the UI can append optimistically and skip a re-fetch.
 *
 * Role gate: team_member, admin, member. Mary (role=agent) hits 403.
 */

const PAGE_SIZE = 50
const MAX_TEXT_LENGTH = 4000
const MAX_FILES_PER_MESSAGE = 4

export async function GET(
  req: NextRequest,
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

  const { id: channelId } = await params
  const url = new URL(req.url)
  const beforeRaw = url.searchParams.get('before')
  const before = beforeRaw ? new Date(beforeRaw) : null
  const hasBefore = before && !Number.isNaN(before.getTime())

  const channel = await prisma.chatChannel.findUnique({
    where: { id: channelId },
    select: { id: true },
  })
  if (!channel) {
    return NextResponse.json({ error: 'channel not found' }, { status: 404 })
  }

  // Fetch newest-first so cursor pagination has a clean shape;
  // the index (@@index([channelId, createdAt])) covers this.
  // Attachment content (bytea) is excluded from the select — the
  // UI requests bytes per-attachment via the /attachments/[id]
  // route, never as part of a list.
  const messages = await prisma.chatMessage.findMany({
    where: {
      channelId,
      ...(hasBefore ? { createdAt: { lt: before } } : {}),
    },
    orderBy: { createdAt: 'desc' },
    take: PAGE_SIZE,
    select: {
      id: true,
      senderId: true,
      senderName: true,
      senderImage: true,
      text: true,
      createdAt: true,
      // Live-query the sender's CURRENT role so the "Admin" chip
      // next to Alex/Ethan stays correct even if their role
      // changes. Deleted users return null and render without a
      // chip (denormalized senderName still drives the display).
      sender: {
        select: { role: true },
      },
      attachments: {
        select: {
          id: true,
          filename: true,
          mimeType: true,
          sizeBytes: true,
          createdAt: true,
        },
      },
    },
  })

  return NextResponse.json({
    messages: messages.map((m) => ({
      id: m.id,
      senderId: m.senderId,
      senderName: m.senderName,
      senderImage: m.senderImage,
      senderRole: m.sender?.role ?? null,
      text: m.text,
      createdAt: m.createdAt.toISOString(),
      attachments: m.attachments.map((a) => ({
        ...a,
        createdAt: a.createdAt.toISOString(),
      })),
    })),
    hasMore: messages.length === PAGE_SIZE,
  })
}

export async function POST(
  req: NextRequest,
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
  const senderId = session.user.id
  // Snapshot name + image at write time so chat history survives
  // a future user-delete cascade.
  const senderName =
    (session.user as { name?: string | null }).name?.trim() || 'Unknown'
  const senderImage =
    (session.user as { image?: string | null }).image ?? null

  const { id: channelId } = await params
  const channel = await prisma.chatChannel.findUnique({
    where: { id: channelId },
    select: { id: true },
  })
  if (!channel) {
    return NextResponse.json({ error: 'channel not found' }, { status: 404 })
  }

  let form: FormData
  try {
    form = await req.formData()
  } catch {
    return NextResponse.json(
      { error: 'multipart/form-data body required' },
      { status: 400 },
    )
  }

  const text = ((form.get('text') as string | null) ?? '').trim()
  const fileEntries = form.getAll('file').filter((f) => f instanceof File) as File[]

  if (!text && fileEntries.length === 0) {
    return NextResponse.json(
      { error: 'Send text or attach at least one image.' },
      { status: 400 },
    )
  }
  if (text.length > MAX_TEXT_LENGTH) {
    return NextResponse.json(
      { error: `Text is too long (max ${MAX_TEXT_LENGTH} characters).` },
      { status: 400 },
    )
  }
  if (fileEntries.length > MAX_FILES_PER_MESSAGE) {
    return NextResponse.json(
      {
        error: `Max ${MAX_FILES_PER_MESSAGE} attachments per message — please send the rest in a follow-up.`,
      },
      { status: 400 },
    )
  }

  // Pre-validate every file BEFORE we start writing — otherwise a
  // bad 4th file would leave 3 partial-uploads in the DB.
  const validatedFiles: Array<{
    filename: string
    mimeType: string
    sizeBytes: number
    buffer: Uint8Array
  }> = []
  for (const file of fileEntries) {
    if (!CHAT_PHOTO_ALLOWED_MIMES.has(file.type)) {
      return NextResponse.json(
        {
          error: `"${file.name}" — only JPEG or PNG images are allowed.`,
        },
        { status: 415 },
      )
    }
    if (file.size > CHAT_PHOTO_MAX_BYTES) {
      const mb = (CHAT_PHOTO_MAX_BYTES / 1024 / 1024).toFixed(0)
      return NextResponse.json(
        {
          error: `"${file.name}" is over the ${mb} MB photo cap. Compress or resize and try again.`,
        },
        { status: 413 },
      )
    }
    validatedFiles.push({
      filename: file.name,
      mimeType: file.type,
      sizeBytes: file.size,
      buffer: new Uint8Array(await file.arrayBuffer()),
    })
  }

  // Single transaction so a partial-write can't leave the chat
  // showing a message with missing attachments.
  const created = await prisma.$transaction(async (tx) => {
    const message = await tx.chatMessage.create({
      data: {
        channelId,
        senderId,
        senderName,
        senderImage,
        text,
      },
      select: { id: true, createdAt: true },
    })
    // Loop rather than createMany — the generated Prisma typing
    // for Bytes columns is stricter on the bulk path than on the
    // single-create path (verified by the Documents flow using
    // the same single-create approach with a Buffer).
    for (const f of validatedFiles) {
      await tx.chatAttachment.create({
        data: {
          messageId: message.id,
          filename: f.filename,
          mimeType: f.mimeType,
          sizeBytes: f.sizeBytes,
          content: Buffer.from(f.buffer),
        },
      })
    }
    // Re-read with attachments + sender role included so the
    // response has the same shape as a GET-list element (including
    // the senderRole field that drives the admin chip).
    return tx.chatMessage.findUniqueOrThrow({
      where: { id: message.id },
      select: {
        id: true,
        senderId: true,
        senderName: true,
        senderImage: true,
        text: true,
        createdAt: true,
        sender: { select: { role: true } },
        attachments: {
          select: {
            id: true,
            filename: true,
            mimeType: true,
            sizeBytes: true,
            createdAt: true,
          },
        },
      },
    })
  })

  return NextResponse.json({
    ok: true,
    message: {
      id: created.id,
      senderId: created.senderId,
      senderName: created.senderName,
      senderImage: created.senderImage,
      senderRole: created.sender?.role ?? null,
      text: created.text,
      createdAt: created.createdAt.toISOString(),
      attachments: created.attachments.map((a) => ({
        ...a,
        createdAt: a.createdAt.toISOString(),
      })),
    },
  })
}
