import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/auth'
import { prisma } from '@/lib/prisma'
import { sendEmail } from '@/lib/gmail'

/**
 * POST /api/follow-ups/reply
 *
 * Sends a Gmail reply on a follow-up thread. The page calls this
 * when the user types into the inline composer + clicks Send.
 *
 * Body: {
 *   threadKey: string,    // "gmail:{gmailThreadId}"
 *   accountEmail: string, // which mailbox to send from
 *   to: string,           // the other party's email
 *   subject: string,      // "Re: <original subject>"
 *   body: string,         // user's reply (plain text or markdown)
 *   inReplyToMessageId: string, // gmailMessageId of latest in thread
 * }
 *
 * Threading: gmail.users.messages.send takes a `threadId` to keep
 * the reply in the same conversation. The In-Reply-To header is
 * built from the latest message's gmailMessageId. Both are needed
 * for clients (Outlook, etc.) that thread by header rather than by
 * Gmail's threadId.
 *
 * Only handles gmail-source threads. ghl-source rows on the page
 * link out to /crm/[subName]/[convId] where the existing reply box
 * already works — no need to duplicate that path here.
 */
export async function POST(req: NextRequest) {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }
  const role = (session.user as { role?: string } | undefined)?.role
  if (role !== 'admin' && role !== 'member') {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }

  let body: {
    threadKey?: string
    accountEmail?: string
    to?: string
    subject?: string
    body?: string
    inReplyToMessageId?: string
  }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const threadKey = (body.threadKey ?? '').trim()
  const accountEmail = (body.accountEmail ?? '').trim().toLowerCase()
  const to = (body.to ?? '').trim()
  const subject = (body.subject ?? '').trim()
  const message = (body.body ?? '').trim()
  const inReplyToMessageId = (body.inReplyToMessageId ?? '').trim()

  if (!threadKey.startsWith('gmail:')) {
    return NextResponse.json(
      { error: 'threadKey must be a gmail:* thread' },
      { status: 400 },
    )
  }
  if (!accountEmail || !to || !subject || !message) {
    return NextResponse.json(
      {
        error:
          'accountEmail, to, subject, and body are all required.',
      },
      { status: 400 },
    )
  }

  // Confirm the account exists in our connected list — prevents a
  // request from picking an arbitrary "from" address.
  const account = await prisma.gmailAccount.findUnique({
    where: { email: accountEmail },
    select: { id: true },
  })
  if (!account) {
    return NextResponse.json(
      { error: `Gmail account ${accountEmail} is not connected.` },
      { status: 400 },
    )
  }

  // The Gmail threadId we stored on the Email row matches what
  // sendEmail expects. Pull it from the in-reply-to message so we
  // can be sure the reply lands in the right thread.
  const gmailThreadId = threadKey.slice('gmail:'.length)

  try {
    await sendEmail({
      accountEmail,
      to,
      subject,
      body: message,
      inReplyTo: inReplyToMessageId
        ? `<${inReplyToMessageId}@mail.gmail.com>`
        : undefined,
      threadId: gmailThreadId,
    })
  } catch (err) {
    console.error('[follow-ups/reply] send failed:', err)
    const messageStr =
      err instanceof Error ? err.message : 'Failed to send'
    return NextResponse.json({ error: messageStr }, { status: 500 })
  }

  return NextResponse.json({ ok: true })
}
