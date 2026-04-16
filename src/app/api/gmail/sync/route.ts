import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { auth } from '@/auth'
import { syncInbox, syncSent, listConnectedAccounts } from '@/lib/gmail'

const BodySchema = z.object({
  email: z.string().email().optional(), // if omitted, syncs all connected accounts
  folder: z.enum(['inbox', 'sent', 'both']).default('both'),
  maxResults: z.number().int().min(1).max(500).default(50),
})

/**
 * POST /api/gmail/sync
 * Pulls recent messages from Gmail into our Email table.
 */
export async function POST(req: NextRequest) {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  const body = await req.json().catch(() => ({}))
  const parsed = BodySchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message }, { status: 400 })
  }

  const emails = parsed.data.email
    ? [parsed.data.email]
    : (await listConnectedAccounts()).map((a) => a.email)

  if (emails.length === 0) {
    return NextResponse.json(
      { error: 'No Gmail accounts connected. Connect one from Settings.' },
      { status: 400 }
    )
  }

  const results: Array<{ email: string; inbox?: unknown; sent?: unknown; error?: string }> = []

  for (const email of emails) {
    try {
      const entry: { email: string; inbox?: unknown; sent?: unknown } = { email }
      if (parsed.data.folder === 'inbox' || parsed.data.folder === 'both') {
        entry.inbox = await syncInbox(email, parsed.data.maxResults)
      }
      if (parsed.data.folder === 'sent' || parsed.data.folder === 'both') {
        entry.sent = await syncSent(email, parsed.data.maxResults)
      }
      results.push(entry)
    } catch (err) {
      const message = err instanceof Error ? err.message : 'sync failed'
      results.push({ email, error: message })
    }
  }

  return NextResponse.json({ results })
}
