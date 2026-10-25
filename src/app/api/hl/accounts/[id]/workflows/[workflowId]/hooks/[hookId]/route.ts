import { NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { hlGuard } from '@/lib/hl/http'
import { hookRequests } from '@/lib/hl/webhooks'

type Ctx = { params: Promise<{ id: string; workflowId: string; hookId: string }> }

/** GET: the latest requests to one of the workflow's webhook URLs (the trigger's test requests). */
export async function GET(_req: Request, { params }: Ctx) {
  const guard = await hlGuard()
  if (guard instanceof NextResponse) return guard
  const { id, workflowId, hookId } = await params
  const w = await prisma.hlWorkflow.findUnique({ where: { id: workflowId }, select: { accountId: true } })
  if (!w || w.accountId !== id) return NextResponse.json({ error: 'Workflow not found' }, { status: 404 })
  return NextResponse.json({ requests: await hookRequests(id, hookId) })
}
