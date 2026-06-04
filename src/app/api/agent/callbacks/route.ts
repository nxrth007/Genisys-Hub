import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/auth'
import { prisma } from '@/lib/prisma'
import { signRecordingUrl } from '@/lib/recording-proxy'
import { getPublicOrigin } from '@/lib/gmail'

/**
 * GET  /api/agent/callbacks  → own callbacks, soonest first
 * POST /api/agent/callbacks  → create a new callback
 */

type CallbackInput = {
  customerName?: string
  customerPhone?: string
  callbackAt?: string // ISO datetime
  notes?: string | null
  callRecordingLink?: string | null
}

export async function GET(req: NextRequest) {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }
  const callbacks = await prisma.callback.findMany({
    where: { agentUserId: session.user.id },
    // Pending first (ordered by when they're due), then completed (recent first).
    orderBy: [{ completedAt: 'asc' }, { callbackAt: 'asc' }],
  })
  const hubOrigin = getPublicOrigin(req)
  return NextResponse.json({
    callbacks: callbacks.map((c) => ({
      ...c,
      recordingUrl: c.callRecordingLink
        ? signRecordingUrl(c.callRecordingLink, hubOrigin)
        : null,
    })),
  })
}

export async function POST(req: NextRequest) {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  let body: CallbackInput
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  if (!body.customerName?.trim()) {
    return NextResponse.json({ error: "Customer's name is required." }, { status: 400 })
  }
  if (!body.customerPhone?.trim()) {
    return NextResponse.json(
      { error: "Customer's phone number is required." },
      { status: 400 }
    )
  }
  if (!body.callbackAt) {
    return NextResponse.json(
      { error: 'Callback date/time is required.' },
      { status: 400 }
    )
  }
  const when = new Date(body.callbackAt)
  if (isNaN(when.getTime())) {
    return NextResponse.json({ error: 'Invalid date/time.' }, { status: 400 })
  }

  const callback = await prisma.callback.create({
    data: {
      agentUserId: session.user.id,
      customerName: body.customerName.trim(),
      customerPhone: body.customerPhone.trim(),
      callbackAt: when,
      notes: body.notes?.trim() || null,
      callRecordingLink: body.callRecordingLink?.trim() || null,
    },
  })
  return NextResponse.json({ ok: true, callback })
}
