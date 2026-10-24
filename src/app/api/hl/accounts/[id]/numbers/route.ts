import { NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { hlAccountOr404, hlError, hlGuard, HlInputError, jsonBody, str } from '@/lib/hl/http'
import { buyNumber, searchNumbers } from '@/lib/hl/twilio'

type Ctx = { params: Promise<{ id: string }> }

/** GET: the sub-account's numbers. GET ?search=1&kind=toll_free|local&areaCode=&contains=: numbers for sale. */
export async function GET(req: Request, { params }: Ctx) {
  const guard = await hlGuard()
  if (guard instanceof NextResponse) return guard
  const { id } = await params
  const account = await hlAccountOr404(id)
  if (account instanceof NextResponse) return account
  const sp = new URL(req.url).searchParams
  try {
    if (sp.get('search')) {
      const kind = sp.get('kind') === 'local' ? 'local' : 'toll_free'
      return NextResponse.json({ available: await searchNumbers({ kind, areaCode: sp.get('areaCode') ?? '', contains: sp.get('contains') ?? '' }) })
    }
    const numbers = await prisma.hlPhoneNumber.findMany({ where: { accountId: id, status: 'active' }, orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }] })
    return NextResponse.json({ numbers })
  } catch (err) {
    return hlError(err, 'numbers')
  }
}

/** POST { number, kind }: buy it. Costs money (Twilio bills the Hub's account monthly), so the page confirms first. */
export async function POST(req: Request, { params }: Ctx) {
  const guard = await hlGuard()
  if (guard instanceof NextResponse) return guard
  const { id } = await params
  const account = await hlAccountOr404(id)
  if (account instanceof NextResponse) return account
  try {
    const body = await jsonBody(req)
    const number = str(body.number)
    if (!number) throw new HlInputError('Pick a number.')
    const kind = body.kind === 'local' ? 'local' : 'toll_free'
    const row = await buyNumber(id, number, kind)
    console.log(`[hell-level] ${guard.email} bought ${row.number} (${kind}) for ${account.name}`)
    return NextResponse.json({ number: row })
  } catch (err) {
    return hlError(err, 'buy number')
  }
}
