import { NextResponse } from 'next/server'
import { auth } from '@/auth'
import { dismissPair, findDuplicatePairs } from '@/lib/client-dedupe'
import { mergeClients } from '@/lib/client-merge'

/** Merging deletes the duplicate record, so it sits with deleting clients: Alex only. */
const MERGE_AUTHORIZED_EMAIL = 'alex@leadgenisys.com'

async function staff() {
  const session = await auth()
  const role = (session?.user as { role?: string } | undefined)?.role
  if (!session?.user?.id) return { error: NextResponse.json({ error: 'unauthorized' }, { status: 401 }) }
  if (role !== 'admin' && role !== 'member') return { error: NextResponse.json({ error: 'forbidden' }, { status: 403 }) }
  return { canMerge: (session.user.email ?? '').toLowerCase() === MERGE_AUTHORIZED_EMAIL }
}

/** GET /api/clients/duplicates — clients that look like the same business. */
export async function GET() {
  const g = await staff()
  if (g.error) return g.error
  return NextResponse.json({ pairs: await findDuplicatePairs(), canMerge: g.canMerge })
}

/**
 * POST /api/clients/duplicates
 *   { action: 'dismiss', a, b }                    — "not duplicates", stop flagging the pair
 *   { action: 'merge', keepId, dropId, useOtherName } — fold dropId into keepId
 */
export async function POST(req: Request) {
  const g = await staff()
  if (g.error) return g.error
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null
  const str = (k: string) => (typeof body?.[k] === 'string' ? (body[k] as string) : '')

  if (body?.action === 'dismiss') {
    if (!str('a') || !str('b')) return NextResponse.json({ error: 'a and b are required' }, { status: 400 })
    await dismissPair(str('a'), str('b'))
    return NextResponse.json({ pairs: await findDuplicatePairs(), canMerge: g.canMerge })
  }

  if (body?.action === 'merge') {
    if (!g.canMerge) return NextResponse.json({ error: `Only ${MERGE_AUTHORIZED_EMAIL} can merge clients.` }, { status: 403 })
    if (!str('keepId') || !str('dropId')) return NextResponse.json({ error: 'keepId and dropId are required' }, { status: 400 })
    try {
      const result = await mergeClients(str('keepId'), str('dropId'), { useOtherName: body.useOtherName === true })
      console.log(`[clients merge] merged ${str('dropId')} into ${str('keepId')} as "${result.name}":`, result.moved)
      return NextResponse.json({ result, pairs: await findDuplicatePairs(), canMerge: g.canMerge })
    } catch (err) {
      console.error('[clients merge] failed:', err)
      return NextResponse.json({ error: err instanceof Error ? err.message : 'Merge failed' }, { status: 400 })
    }
  }

  return NextResponse.json({ error: 'unknown action' }, { status: 400 })
}
