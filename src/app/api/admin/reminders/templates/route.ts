import { NextResponse } from 'next/server'
import { auth } from '@/auth'
import { prisma } from '@/lib/prisma'
import { DEFAULT_TEMPLATES, REMINDER_TYPES, type ReminderType } from '@/lib/reminders'

/**
 * GET  /api/admin/reminders/templates
 *   Returns the cross-product of every active client × every reminder
 *   type, with the body that's actually in effect for each cell:
 *     - per-client template if set
 *     - global template (clientId null) if set
 *     - hardcoded DEFAULT_TEMPLATES otherwise
 *   The UI uses this to render an editable grid.
 *
 * PUT  /api/admin/reminders/templates
 *   Upserts a single (clientId, reminderType) row. Body:
 *     { clientId: string | null, reminderType: ReminderType,
 *       body: string, enabled: boolean }
 *   clientId=null hits the global default override. enabled=false
 *   silently skips that cell at dispatch time.
 *
 * DELETE /api/admin/reminders/templates?clientId=…&reminderType=…
 *   Removes the override so the cell falls back to the next layer
 *   (global → hardcoded default).
 */

export async function GET() {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  const [clients, templates] = await Promise.all([
    prisma.client.findMany({
      where: { active: true },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
      select: { id: true, name: true, color: true, state: true },
    }),
    prisma.reminderTemplate.findMany(),
  ])

  // Index DB rows by (clientId, type) for O(1) lookup.
  const dbByKey = new Map<string, { body: string; enabled: boolean }>()
  for (const t of templates) {
    dbByKey.set(`${t.clientId ?? 'null'}:${t.reminderType}`, {
      body: t.body,
      enabled: t.enabled,
    })
  }

  function resolve(clientId: string | null, type: ReminderType) {
    const own = clientId ? dbByKey.get(`${clientId}:${type}`) : null
    const global = dbByKey.get(`null:${type}`)
    if (own) return { ...own, source: 'client' as const }
    if (global) return { ...global, source: 'global' as const }
    return {
      body: DEFAULT_TEMPLATES[type],
      enabled: true,
      source: 'default' as const,
    }
  }

  // Build the grid: a "row" per client (plus a synthetic "global"
  // row for the cross-cutting fallback), each carrying the four
  // type cells.
  const rows = [
    {
      clientId: null as string | null,
      clientName: 'Global default',
      color: '#6b7280',
      state: null as string | null,
      cells: REMINDER_TYPES.map((type) => ({
        type,
        ...resolve(null, type),
      })),
    },
    ...clients.map((c) => ({
      clientId: c.id,
      clientName: c.name,
      color: c.color,
      state: c.state,
      cells: REMINDER_TYPES.map((type) => ({
        type,
        ...resolve(c.id, type),
      })),
    })),
  ]

  return NextResponse.json({ rows })
}

export async function PUT(req: Request) {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  let body: {
    clientId?: unknown
    reminderType?: unknown
    body?: unknown
    enabled?: unknown
  }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'invalid JSON body' }, { status: 400 })
  }

  const reminderType = String(body.reminderType ?? '')
  if (!REMINDER_TYPES.includes(reminderType as ReminderType)) {
    return NextResponse.json(
      { error: `reminderType must be one of: ${REMINDER_TYPES.join(', ')}` },
      { status: 400 }
    )
  }
  const text = typeof body.body === 'string' ? body.body : ''
  if (!text.trim()) {
    return NextResponse.json({ error: 'body is required' }, { status: 400 })
  }
  const clientId =
    typeof body.clientId === 'string' && body.clientId ? body.clientId : null
  const enabled = body.enabled !== false

  // Compound where with nullable column doesn't work via Prisma's
  // upsert API — fall back to findFirst + branch. clientId=null is
  // the global-default override; per-client rows are the common path.
  const existing = await prisma.reminderTemplate.findFirst({
    where: { clientId, reminderType },
  })
  const template = existing
    ? await prisma.reminderTemplate.update({
        where: { id: existing.id },
        data: { body: text, enabled },
      })
    : await prisma.reminderTemplate.create({
        data: { clientId, reminderType, body: text, enabled },
      })
  return NextResponse.json({ template })
}

export async function DELETE(req: Request) {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }
  const sp = new URL(req.url).searchParams
  const clientId = sp.get('clientId') || null
  const reminderType = sp.get('reminderType') || ''
  if (!REMINDER_TYPES.includes(reminderType as ReminderType)) {
    return NextResponse.json(
      { error: 'invalid reminderType' },
      { status: 400 }
    )
  }
  await prisma.reminderTemplate.deleteMany({
    where: { clientId, reminderType },
  })
  return NextResponse.json({ ok: true })
}
