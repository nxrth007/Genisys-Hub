import { NextResponse, after } from 'next/server'
import { prisma } from '@/lib/prisma'
import { readProfile } from '@/lib/hl/accounts'
import { fireTrigger } from '@/lib/hl/automation'
import { logActivity } from '@/lib/hl/contacts'
import { isPreviewBot, readLinkToken } from '@/lib/hl/links'
import { reviewDestination } from '@/lib/hl/review-survey'

type Ctx = { params: Promise<{ token: string }> }

/**
 * A tracked link from a text (GHL's trigger link). The click is the
 * contact's: it's noted on their conversation and fires "Trigger link
 * clicked" (link previews that fetch it on their own don't count), then the
 * review link opens the sub-account's review survey.
 */
export async function GET(req: Request, { params }: Ctx) {
  const { token } = await params
  const t = readLinkToken(token)
  const contact = t ? await prisma.hlContact.findUnique({ where: { id: t.contactId }, select: { id: true, accountId: true, account: { select: { name: true, profile: true } } } }) : null
  if (!t || !contact) return new NextResponse('This link has expired.', { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8' } })

  if (!isPreviewBot(req.headers.get('user-agent'))) {
    after(async () => {
      try {
        await logActivity(contact.accountId, contact.id, t.link === 'review' ? 'Clicked the review link' : `Clicked the ${t.link} link`, { link: t.link }, false)
        await fireTrigger(contact.accountId, contact.id, { type: 'link_clicked', link: t.link })
      } catch (err) {
        console.error('[hell-level] link click failed:', err)
      }
    })
  }

  const survey = await prisma.hlForm.findFirst({ where: { accountId: contact.accountId, kind: 'survey', archivedAt: null }, orderBy: { createdAt: 'asc' }, select: { id: true } })
  const to = survey
    ? new URL(`/hl/s/${survey.id}?c=${encodeURIComponent(token)}`, req.url).toString()
    : reviewDestination(readProfile(contact.account.profile), contact.account.name)
  return NextResponse.redirect(to, { status: 302 })
}
