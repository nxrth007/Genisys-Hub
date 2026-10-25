import { NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import type { Prisma } from '@/generated/prisma/client'
import { fireTrigger } from '@/lib/hl/automation'
import { upsertContact } from '@/lib/hl/contacts'
import { hlAccountOr404, hlError, HlInputError, jsonBody, str, hlAccountGuard } from '@/lib/hl/http'

type Ctx = { params: Promise<{ id: string }> }

const PAGE = 50

/** GET ?q=&tag=&page=: contacts, newest first. */
export async function GET(req: Request, { params }: Ctx) {
  const { id } = await params
  const guard = await hlAccountGuard(id)
  if (guard instanceof NextResponse) return guard
  const account = await hlAccountOr404(id)
  if (account instanceof NextResponse) return account
  const sp = new URL(req.url).searchParams
  const q = (sp.get('q') ?? '').trim()
  const tag = (sp.get('tag') ?? '').trim().toLowerCase()
  const page = Math.max(0, Number(sp.get('page')) || 0)
  const digits = q.replace(/\D/g, '')
  const where: Prisma.HlContactWhereInput = {
    accountId: id,
    ...(tag ? { tags: { has: tag } } : {}),
    ...(q
      ? {
          OR: [
            { firstName: { contains: q, mode: 'insensitive' } },
            { lastName: { contains: q, mode: 'insensitive' } },
            { email: { contains: q, mode: 'insensitive' } },
            ...(digits.length >= 3 ? [{ phone: { contains: digits } }] : []),
          ],
        }
      : {}),
  }
  const [contacts, total, tagRows] = await Promise.all([
    prisma.hlContact.findMany({ where, orderBy: { createdAt: 'desc' }, skip: page * PAGE, take: PAGE }),
    prisma.hlContact.count({ where }),
    prisma.hlContact.findMany({ where: { accountId: id }, select: { tags: true } }),
  ])
  const tags = [...new Set(tagRows.flatMap((r) => r.tags))].sort()
  return NextResponse.json({ contacts, total, page, pageSize: PAGE, tags })
}

/** POST { firstName, lastName, phone, email, tags, consent }: add a contact by hand. */
export async function POST(req: Request, { params }: Ctx) {
  const { id } = await params
  const guard = await hlAccountGuard(id)
  if (guard instanceof NextResponse) return guard
  const account = await hlAccountOr404(id)
  if (account instanceof NextResponse) return account
  try {
    const body = await jsonBody(req)
    const phone = str(body.phone)
    const email = str(body.email)
    if (!phone && !email) throw new HlInputError('Add a phone number or an email.')
    const { contact, created } = await upsertContact(id, {
      firstName: str(body.firstName),
      lastName: str(body.lastName),
      phone,
      email,
      source: 'manual',
      consent: body.consent === true,
      tags: Array.isArray(body.tags) ? body.tags.filter((t): t is string => typeof t === 'string') : [],
    })
    if (phone && !contact.phone) throw new HlInputError('That phone number doesn’t look right.')
    if (created) {
      await fireTrigger(id, contact.id, { type: 'contact_created' })
      await fireTrigger(id, contact.id, { type: 'manual' })
    }
    return NextResponse.json({ contact, created })
  } catch (err) {
    return hlError(err, 'create contact')
  }
}
