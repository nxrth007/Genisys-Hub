import { NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { hlError, hlGuard, HlInputError, jsonBody, str } from '@/lib/hl/http'
import { sendSmsToContact } from '@/lib/hl/messages'

type Ctx = { params: Promise<{ id: string; contactId: string }> }

/** POST { kind: 'sms' | 'note', body }: text the contact from the sub-account's number, or leave an internal note. */
export async function POST(req: Request, { params }: Ctx) {
  const guard = await hlGuard()
  if (guard instanceof NextResponse) return guard
  const { id, contactId } = await params
  const contact = await prisma.hlContact.findUnique({ where: { id: contactId }, select: { accountId: true } })
  if (!contact || contact.accountId !== id) return NextResponse.json({ error: 'Contact not found' }, { status: 404 })
  try {
    const body = await jsonBody(req)
    const text = str(body.body)
    if (!text) throw new HlInputError('Type a message first.')
    if (text.length > 1500) throw new HlInputError('That’s too long for a text (1,500 characters max).')
    if (body.kind === 'note') {
      const note = await prisma.hlMessage.create({ data: { accountId: id, contactId, direction: 'outbound', channel: 'note', status: 'logged', body: text, by: guard.email } })
      return NextResponse.json({ ok: true, messageId: note.id })
    }
    const r = await sendSmsToContact({ accountId: id, contactId, body: text, by: guard.email })
    // Replying means the conversation's been seen.
    await prisma.hlContact.update({ where: { id: contactId }, data: { unread: 0 } })
    return NextResponse.json(r, { status: r.ok ? 200 : 422 })
  } catch (err) {
    return hlError(err, 'send message')
  }
}
