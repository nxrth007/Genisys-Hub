import { NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import type { Prisma } from '@/generated/prisma/client'
import { hlAccountOr404, hlError, hlGuard, HlInputError, jsonBody, str } from '@/lib/hl/http'
import { fillLegalLinksFromSite } from '@/lib/hl/legal-links'
import { CHAT_FIELDS, CHAT_SETTINGS, QUOTE_FORM_FIELDS, QUOTE_FORM_SETTINGS } from '@/lib/hl/templates'

type Ctx = { params: Promise<{ id: string }> }

/** GET: forms and chat widgets with submission counts. */
export async function GET(_req: Request, { params }: Ctx) {
  const guard = await hlGuard()
  if (guard instanceof NextResponse) return guard
  const { id } = await params
  const account = await hlAccountOr404(id)
  if (account instanceof NextResponse) return account
  const [forms, counts, last] = await Promise.all([
    prisma.hlForm.findMany({ where: { accountId: id, archivedAt: null }, orderBy: { createdAt: 'asc' } }),
    prisma.hlFormSubmission.groupBy({ by: ['formId'], where: { accountId: id }, _count: { _all: true } }),
    prisma.hlFormSubmission.groupBy({ by: ['formId'], where: { accountId: id }, _max: { createdAt: true } }),
  ])
  return NextResponse.json({
    forms: forms.map((f) => ({
      ...f,
      submissions: counts.find((c) => c.formId === f.id)?._count._all ?? 0,
      lastSubmissionAt: last.find((c) => c.formId === f.id)?._max.createdAt ?? null,
    })),
  })
}

/** POST { name, kind: 'form' | 'chat' }: a new form, starting from the quote form or chat widget fields. */
export async function POST(req: Request, { params }: Ctx) {
  const guard = await hlGuard()
  if (guard instanceof NextResponse) return guard
  const { id } = await params
  const account = await hlAccountOr404(id)
  if (account instanceof NextResponse) return account
  try {
    const body = await jsonBody(req)
    const name = str(body.name)
    if (!name) throw new HlInputError('Name the form.')
    const chat = body.kind === 'chat'
    const form = await prisma.hlForm.create({
      data: {
        accountId: id,
        name,
        kind: chat ? 'chat' : 'form',
        fields: (chat ? CHAT_FIELDS : QUOTE_FORM_FIELDS) as unknown as Prisma.InputJsonValue,
        settings: (chat ? CHAT_SETTINGS : QUOTE_FORM_SETTINGS) as Prisma.InputJsonValue,
      },
    })
    // Its policy links: the client's own pages when their site has them.
    await fillLegalLinksFromSite(id)
    return NextResponse.json({ form })
  } catch (err) {
    return hlError(err, 'create form')
  }
}
