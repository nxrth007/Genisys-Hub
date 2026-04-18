import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/auth'
import { buildAndSendBrief, buildAndSendSmsBrief } from '@/lib/morning-brief'

/**
 * POST /api/admin/schedules/test
 *   body: {
 *     channel: 'slack' | 'ghl_sms'
 *     email?: string          (slack)
 *     phone?: string          (ghl_sms)
 *     firstName?: string
 *     notionAssignee?: string (ghl_sms; filters Kanban tasks)
 *   }
 *
 * Fires the brief right now — for verifying a schedule config end-to-end
 * before the 9 AM cron picks it up. Admin-only.
 */
export async function POST(req: NextRequest) {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  const body = (await req.json().catch(() => ({}))) as {
    channel?: 'slack' | 'ghl_sms'
    email?: string
    phone?: string
    firstName?: string
    notionAssignee?: string
  }

  try {
    if (body.channel === 'ghl_sms') {
      if (!body.phone) {
        return NextResponse.json({ error: 'phone required' }, { status: 400 })
      }
      const result = await buildAndSendSmsBrief({
        phone: body.phone,
        firstName: body.firstName,
        notionAssignee: body.notionAssignee,
      })
      return NextResponse.json(result)
    } else {
      if (!body.email) {
        return NextResponse.json({ error: 'email required' }, { status: 400 })
      }
      const result = await buildAndSendBrief(body.email)
      return NextResponse.json(result)
    }
  } catch (err) {
    console.error('[schedules/test] failed:', err)
    const message = err instanceof Error ? err.message : 'Send failed'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
