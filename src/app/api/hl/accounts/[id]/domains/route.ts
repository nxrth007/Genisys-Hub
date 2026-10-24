import { NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { readProfile } from '@/lib/hl/accounts'
import { hlAccountOr404, hlError, hlGuard, HlInputError, jsonBody, str } from '@/lib/hl/http'
import { buyDomain, checkTransfer, connectDomain, linkDomain, quoteBuy, quoteTransferIn, searchDomains, startTransferIn, unlinkedRegistrarDomains } from '@/lib/hl/domains'
import { urlForwards } from '@/lib/hl/porkbun'

type Ctx = { params: Promise<{ id: string }> }

/**
 * GET: the sub-account's domains.
 * GET ?search=acme: names for sale with prices. ?quote=acme.com: the all-in price to buy it.
 * GET ?transferCheck=acme.com: can it come in, the price, and its current DNS.
 * GET ?unlinked=1: domains in the Porkbun account no sub-account has.
 * GET ?redirects=1: every URL redirect on the sub-account's domains held here.
 */
export async function GET(req: Request, { params }: Ctx) {
  const guard = await hlGuard()
  if (guard instanceof NextResponse) return guard
  const { id } = await params
  const account = await hlAccountOr404(id)
  if (account instanceof NextResponse) return account
  const sp = new URL(req.url).searchParams
  try {
    const search = str(sp.get('search'))
    if (search) {
      const city = readProfile(account.profile).address?.split(',').at(-2)?.trim() ?? null
      return NextResponse.json({ results: await searchDomains(search, city) })
    }
    const quote = str(sp.get('quote'))
    if (quote) return NextResponse.json({ quote: await quoteBuy(quote) })
    const transferCheck = str(sp.get('transferCheck'))
    if (transferCheck) return NextResponse.json({ check: await checkTransfer(transferCheck) })
    if (sp.get('unlinked')) return NextResponse.json({ domains: await unlinkedRegistrarDomains() })
    if (sp.get('redirects')) {
      const held = await prisma.hlDomain.findMany({ where: { accountId: id, status: 'active', origin: { not: 'external' } }, orderBy: { name: 'asc' }, select: { id: true, name: true } })
      const redirects = []
      const errors: string[] = []
      for (const d of held) {
        try {
          for (const f of await urlForwards(d.name)) redirects.push({ ...f, domainId: d.id, domain: d.name })
        } catch (err) {
          errors.push(`${d.name}: ${err instanceof Error ? err.message : String(err)}`)
        }
      }
      return NextResponse.json({ redirects, domains: held, errors })
    }
    const domains = await prisma.hlDomain.findMany({ where: { accountId: id }, orderBy: { createdAt: 'asc' } })
    return NextResponse.json({ domains })
  } catch (err) {
    return hlError(err, 'domains')
  }
}

/**
 * POST { action: 'buy', name, costCents }: buy it at the quoted price (money: the page confirms first).
 * POST { action: 'transfer-quote', name, authCode }: the all-in transfer price (the code stays out of URLs).
 * POST { action: 'transfer', name, authCode, costCents }: pay for the transfer, held, and copy the DNS.
 * POST { action: 'link', name }: link a domain already in the Porkbun account.
 * POST { action: 'connect', name, txt?, wwwTxt? }: connect a domain or subdomain to the client's site
 *   (held here: records set now; registered elsewhere: an external domain with the records to add there).
 */
export async function POST(req: Request, { params }: Ctx) {
  const guard = await hlGuard()
  if (guard instanceof NextResponse) return guard
  const { id } = await params
  const account = await hlAccountOr404(id)
  if (account instanceof NextResponse) return account
  try {
    const body = await jsonBody(req)
    const name = str(body.name)
    if (!name) throw new HlInputError('Which domain?')
    const costCents = typeof body.costCents === 'number' ? body.costCents : NaN
    switch (body.action) {
      case 'buy':
        return NextResponse.json({ domain: await buyDomain({ accountId: id, name, costCents, by: guard.email }) })
      case 'transfer-quote':
        return NextResponse.json({ quote: await quoteTransferIn(name, str(body.authCode) ?? '') })
      case 'transfer':
        return NextResponse.json({ domain: await startTransferIn({ accountId: id, name, authCode: str(body.authCode) ?? '', costCents, by: guard.email }) })
      case 'link':
        return NextResponse.json({ domain: await linkDomain({ accountId: id, name, by: guard.email }) })
      case 'connect':
        return NextResponse.json(await connectDomain({ accountId: id, name, txt: str(body.txt), wwwTxt: str(body.wwwTxt), by: guard.email }))
      default:
        throw new HlInputError('Unknown action.')
    }
  } catch (err) {
    return hlError(err, 'domain')
  }
}
