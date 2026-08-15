import { NextRequest } from 'next/server'
import { sendEmail, listConnectedAccounts } from '@/lib/gmail'
import { externalWrite, WriteError, requireOwner } from '@/lib/external-write'
import { externalOptions } from '@/lib/external-api'

/**
 * POST /api/external/v1/inbox/send
 * body: { from?, to, subject, body, threadId?, inReplyTo? }
 *
 * Sends real mail from a connected Gmail account, so it carries the same
 * guards as the CRM's SMS send: a signed-in account only, and the sender
 * is logged.
 *
 * `from` must be one of the connected accounts. Without that check the
 * endpoint would accept any address and fail deep inside the Gmail client
 * with something unhelpful.
 */
export const POST = externalWrite(async ({ auth, body }) => {
  requireOwner(auth)

  const to = String(body.to ?? '').trim()
  const subject = String(body.subject ?? '').trim()
  const text = String(body.body ?? '').trim()
  const from = String(body.from ?? '').trim()

  if (!to) throw new WriteError('Add at least one recipient.')
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to.split(',')[0].trim())) {
    throw new WriteError('That recipient address is not valid.')
  }
  if (!subject && !text) {
    throw new WriteError('The email is empty.')
  }

  const accounts = await listConnectedAccounts()
  if (accounts.length === 0) {
    throw new WriteError(
      'No Gmail account is connected to the Hub. Connect one in Settings first.',
    )
  }

  const account = from
    ? accounts.find((a) => a.email.toLowerCase() === from.toLowerCase())
    : accounts[0]
  if (!account) {
    throw new WriteError(`"${from}" is not a connected Gmail account.`)
  }

  try {
    await sendEmail({
      accountEmail: account.email,
      to,
      subject: subject || '(no subject)',
      body: text,
      threadId: body.threadId ? String(body.threadId) : undefined,
      inReplyTo: body.inReplyTo ? String(body.inReplyTo) : undefined,
    })
  } catch (err) {
    throw new WriteError(
      err instanceof Error ? err.message : 'Gmail rejected the message.',
      502,
    )
  }

  console.log(
    `[inbox-send] ${auth.user.email} sent mail from ${account.email} to ${to}`,
  )

  return { sent: true, from: account.email, to }
})

export const OPTIONS = (req: NextRequest) => externalOptions(req)
