import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/auth'
import { getDatabase, updatePage } from '@/lib/notion'

/**
 * POST /api/notion/pages/[id]/toggle-status
 *
 * Server-side helper for marking a Notion page done / undone
 * without the client having to know the parent DB's schema.
 * Used by the /today follow-ups drawer (where the drawer
 * doesn't have access to the FocusList's discovered schema).
 *
 * Body:
 *   {
 *     dbId: string                 // parent DB id
 *     done: boolean                // true → set status to a "done" option
 *                                  // false → set status to a "todo" option
 *   }
 *
 * Strategy: discover the status property on the DB (status type
 * preferred, falling back to a select column whose name contains
 * "status"), then pick an option whose name matches a synonym
 * for the requested target ("Done" / "Complete" / "Shipped" for
 * done; "To Do" / "Todo" / "Open" / "Up Next" / "Backlog" for
 * todo). Falls back to the first option of the right tier if
 * none of the synonyms hit, since DB owners pick whatever names
 * they want for their workflow stages.
 */

const DONE_SYNONYMS = ['done', 'complete', 'completed', 'shipped', 'closed']
const TODO_SYNONYMS = [
  'to do',
  'todo',
  'open',
  'up next',
  'upnext',
  'backlog',
  'not started',
  'pending',
]

type StatusEntry = [
  string,
  {
    type?: string
    status?: { options?: Array<{ name?: string }> }
    select?: { options?: Array<{ name?: string }> }
  },
]

function pickOption(
  options: Array<{ name?: string }>,
  synonyms: string[],
): string | null {
  const lower = options.map((o) => (o.name ?? '').trim().toLowerCase())
  for (const syn of synonyms) {
    const idx = lower.indexOf(syn)
    if (idx >= 0) return options[idx].name ?? null
  }
  return options[0]?.name ?? null
}

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }
  const { id: pageId } = await ctx.params
  const body = await req.json().catch(() => null)
  const dbId = typeof body?.dbId === 'string' ? body.dbId : null
  const done = body?.done === true

  if (!dbId) {
    return NextResponse.json({ error: 'dbId required' }, { status: 400 })
  }

  try {
    const db = (await getDatabase(dbId)) as {
      properties?: Record<
        string,
        {
          type?: string
          status?: { options?: Array<{ name?: string }> }
          select?: { options?: Array<{ name?: string }> }
        }
      >
    }
    const props = db.properties ?? {}
    const entries = Object.entries(props) as StatusEntry[]
    const statusEntry =
      entries.find(([, v]) => v.type === 'status') ??
      entries.find(
        ([name, v]) =>
          v.type === 'select' && name.toLowerCase().includes('status'),
      )
    if (!statusEntry) {
      return NextResponse.json(
        { error: 'no status property on this DB' },
        { status: 400 },
      )
    }
    const [statusName, statusDef] = statusEntry
    const isStatusType = statusDef.type === 'status'
    const options =
      (isStatusType
        ? statusDef.status?.options
        : statusDef.select?.options) ?? []
    const targetName = pickOption(options, done ? DONE_SYNONYMS : TODO_SYNONYMS)
    if (!targetName) {
      return NextResponse.json(
        { error: 'no usable option found' },
        { status: 400 },
      )
    }
    const properties: Record<string, unknown> = {
      [statusName]: isStatusType
        ? { status: { name: targetName } }
        : { select: { name: targetName } },
    }
    await updatePage(pageId, properties)
    return NextResponse.json({ ok: true, status: targetName })
  } catch (err) {
    return NextResponse.json(
      { error: (err as Error).message },
      { status: 500 },
    )
  }
}
