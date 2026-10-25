import { NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { checkRateLimit } from '@/lib/rate-limit'
import { readProfile } from '@/lib/hl/accounts'
import { hlError, hlGuard, jsonBody } from '@/lib/hl/http'
import { renderTemplate, type MergeData } from '@/lib/hl/merge'
import { SAMPLE_CONTACT, callWebhook, contactPayload, keptResponse } from '@/lib/hl/outbound-webhook'
import { cleanSteps } from '@/lib/hl/workflow-input'

type Ctx = { params: Promise<{ id: string }> }

/**
 * POST { step, webhook?, responses? }: send a Webhook action's request now,
 * as the builder has it, with the sample lead (and the workflow's webhook
 * reference and kept test responses), and say what came back. GHL's "Test
 * action". The same address checks as a real run apply.
 */
export async function POST(req: Request, { params }: Ctx) {
  const guard = await hlGuard()
  if (guard instanceof NextResponse) return guard
  const { id } = await params
  const account = await prisma.hlAccount.findUnique({ where: { id }, select: { id: true, profile: true } })
  if (!account) return NextResponse.json({ error: 'Sub-account not found' }, { status: 404 })
  if (!checkRateLimit(`hl-webhook-test:${guard.email}`, 20, 60_000).ok) return NextResponse.json({ error: 'Too many test requests. Try again in a minute.' }, { status: 429 })
  try {
    const body = await jsonBody(req)
    const raw = body.step && typeof body.step === 'object' ? (body.step as Record<string, unknown>) : {}
    const [step] = cleanSteps([{ ...raw, type: 'webhook' }])
    const profile = readProfile(account.profile)
    const responses = body.responses && typeof body.responses === 'object' ? (body.responses as MergeData['responses']) : null
    const merge: MergeData = { contact: SAMPLE_CONTACT, account: profile, form: SAMPLE_CONTACT.fields as Record<string, unknown>, webhook: body.webhook ?? null, responses }
    const today = new Date().toISOString().slice(0, 10)
    const render = (s: string) => renderTemplate(s.replace(/\{\{\s*today\s*\}\}/gi, today), merge)
    const r = await callWebhook(step.config, render, () =>
      contactPayload({
        contact: SAMPLE_CONTACT,
        accountId: id,
        profile,
        workflow: { id: 'test', name: 'Test request' },
        trigger: { type: 'test' },
        custom: Object.fromEntries((step.config.data ?? []).map((d) => [render(d.key).trim(), render(d.value)]).filter(([k]) => k)),
      }),
    )
    return NextResponse.json({ result: { ok: r.ok, status: r.status, ms: r.ms, detail: r.detail, data: keptResponse(r.data) ?? null } })
  } catch (err) {
    return hlError(err, 'test webhook')
  }
}
