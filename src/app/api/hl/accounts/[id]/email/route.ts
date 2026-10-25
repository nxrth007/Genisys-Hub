import { NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { readProfile } from '@/lib/hl/accounts'
import { checkEmail, emailDomainChoices, recordsOf, removeEmail, sendTestEmail, setUpEmail, updateEmailSettings } from '@/lib/hl/email'
import { hlAccountOr404, hlError, hlGuard, HlInputError, jsonBody, str, hlAccountGuard } from '@/lib/hl/http'
import { mailgunStatus } from '@/lib/hl/mailgun'

type Ctx = { params: Promise<{ id: string }> }

/** GET: Email Services: Mailgun's connection, the sub-account's email (records and all), and the domains it could use. */
export async function GET(_req: Request, { params }: Ctx) {
  const { id } = await params
  const guard = await hlAccountGuard(id)
  if (guard instanceof NextResponse) return guard
  const account = await hlAccountOr404(id)
  if (account instanceof NextResponse) return account
  try {
    // The sub-account's own login: only whether it can send (the Conversations composer).
    if (!guard.admin) {
      const setup = await prisma.hlEmailDomain.findUnique({ where: { accountId: id }, select: { status: true, domain: true, rootDomain: true, fromName: true, fromLocal: true } })
      return NextResponse.json({ setup })
    }
    const [mailgun, setup, choices] = await Promise.all([mailgunStatus(), prisma.hlEmailDomain.findUnique({ where: { accountId: id } }), emailDomainChoices(id)])
    return NextResponse.json({
      mailgun,
      setup: setup ? { ...setup, records: recordsOf(setup) } : null,
      choices,
      notifyEmail: readProfile(account.profile).notifyEmail ?? '',
      you: guard.email,
    })
  } catch (err) {
    return hlError(err, 'load email')
  }
}

/**
 * POST { action: 'setup', domain } | { action: 'check' }
 *    | { action: 'settings', fromName?, fromLocal?, forwardReplies? } | { action: 'test', to }
 */
export async function POST(req: Request, { params }: Ctx) {
  const guard = await hlGuard()
  if (guard instanceof NextResponse) return guard
  const { id } = await params
  const account = await hlAccountOr404(id)
  if (account instanceof NextResponse) return account
  try {
    const body = await jsonBody(req)
    switch (body.action) {
      case 'setup': {
        const domain = str(body.domain)
        if (!domain) throw new HlInputError('Pick the domain to send from.')
        await setUpEmail({ accountId: id, domain, by: guard.email })
        break
      }
      case 'check':
        await checkEmail(id)
        break
      case 'settings':
        await updateEmailSettings(id, {
          ...(body.fromName !== undefined ? { fromName: str(body.fromName) ?? '' } : {}),
          ...(body.fromLocal !== undefined ? { fromLocal: str(body.fromLocal) ?? '' } : {}),
          ...(typeof body.forwardReplies === 'boolean' ? { forwardReplies: body.forwardReplies } : {}),
        })
        break
      case 'test':
        return NextResponse.json({ ok: true, detail: await sendTestEmail(id, str(body.to) ?? '') })
      default:
        throw new HlInputError('Unknown action.')
    }
    const setup = await prisma.hlEmailDomain.findUnique({ where: { accountId: id } })
    return NextResponse.json({ setup: setup ? { ...setup, records: recordsOf(setup) } : null })
  } catch (err) {
    return hlError(err, 'set up email')
  }
}

/** DELETE: take email off the sub-account (Mailgun's domain and route, and the records Hell-level wrote). */
export async function DELETE(_req: Request, { params }: Ctx) {
  const guard = await hlGuard()
  if (guard instanceof NextResponse) return guard
  const { id } = await params
  const account = await hlAccountOr404(id)
  if (account instanceof NextResponse) return account
  try {
    await removeEmail(id, guard.email)
    return NextResponse.json({ ok: true })
  } catch (err) {
    return hlError(err, 'remove email')
  }
}
