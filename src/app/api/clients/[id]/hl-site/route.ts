import { NextResponse } from 'next/server'
import { auth } from '@/auth'
import { requireAdmin, requireStaff } from '@/lib/auth-helpers'
import { prisma } from '@/lib/prisma'
import { askForClientSite, decideClientSite, pasteDomainCode, previewClientSite } from '@/lib/hl/site-request'
import { lovableWebGet } from '@/lib/seo/lovable-mcp'

/**
 * GET /api/clients/:id/hl-site — this client's website build: where it
 * stands, the Lovable copy, the one-shot that was sent, and the log.
 *
 * POST { action: 'ask', overrideGhl? } — admin only: put Forge's question
 * ("Build X's website?") in the Office by hand: an older client, again after
 * a Not now or a failure, or a new copy after a finished build. A client set
 * up in GHL needs overrideGhl. Nothing is built until someone presses Build
 * it there.
 *
 * POST { action: 'preview' } — admin only: the one-shot as it would be sent,
 * without copying or sending anything in Lovable. One Claude call.
 *
 * POST { action: 'publish' } — admin only: the same as Publish it on Forge's
 * question in the Office, for a built site (also after a Not now).
 *
 * POST { action: 'connect' } — admin only: the same as Connect it on Forge's
 * domain question, for a published site with a domain in Hell-level → Domains.
 *
 * POST { action: 'code', text } — staff: while Forge connects their domain,
 * what Lovable showed for it (its lovable_verify= code, or both codes). A
 * domain held here gets its DNS set at Porkbun.
 */
export const dynamic = 'force-dynamic'
// A preview is one Claude call that looks at the client's photos: a few minutes at most.
export const maxDuration = 600

/**
 * GET ?probe=domains|hostname|v1 — admin only, read-only: what Lovable's own
 * API answers the Hub's Lovable sign-in for this client's copy (its domain
 * list as Settings → Domains shows it, its hostname, or the documented /v1
 * project). Shows whether the Hub could connect domains in Lovable itself.
 */
const PROBES: Record<string, (projectId: string) => string> = {
  domains: (p) => `/projects/${p}/v2/domains`,
  hostname: (p) => `/projects/${p}/hostname`,
  v1: (p) => `/v1/projects/${p}`,
}

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const denied = await requireStaff()
  if (denied) return denied
  const { id } = await params
  const probe = new URL(req.url).searchParams.get('probe')
  if (probe) {
    const adminDenied = await requireAdmin()
    if (adminDenied) return adminDenied
    const path = PROBES[probe]
    if (!path) return NextResponse.json({ error: `probe is one of ${Object.keys(PROBES).join(', ')}` }, { status: 400 })
    const row = await prisma.hlSiteRequest.findUnique({ where: { clientId: id }, select: { projectId: true } })
    if (!row?.projectId) return NextResponse.json({ error: 'Forge has no Lovable copy for this client.' }, { status: 409 })
    try {
      return NextResponse.json({ probe, ...(await lovableWebGet(path(row.projectId))) })
    } catch (err) {
      return NextResponse.json({ probe, error: err instanceof Error ? err.message : String(err) }, { status: 502 })
    }
  }
  const request = await prisma.hlSiteRequest.findUnique({
    where: { clientId: id },
    select: {
      id: true,
      status: true,
      projectId: true,
      projectName: true,
      editorUrl: true,
      previewUrl: true,
      prompt: true,
      detail: true,
      trigger: true,
      decidedBy: true,
      decidedAt: true,
      finishedAt: true,
      liveUrl: true,
      publishedAt: true,
      domain: true,
      domainStep: true,
      domainAt: true,
      log: true,
      updatedAt: true,
    },
  })
  return NextResponse.json({ request })
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const body = (await req.json().catch(() => null)) as { action?: unknown; overrideGhl?: unknown; text?: unknown } | null
  const { id } = await params
  // Pasting Lovable's code is the step Ethan (staff) does in Lovable, so it isn't admin only.
  if (body?.action === 'code') {
    const staffDenied = await requireStaff()
    if (staffDenied) return staffDenied
    const session = await auth()
    const by = session?.user?.name || session?.user?.email || 'staff'
    const res = await pasteDomainCode(id, typeof body.text === 'string' ? body.text : '', by)
    return NextResponse.json(res, { status: res.ok ? 200 : 409 })
  }
  const denied = await requireAdmin()
  if (denied) return denied
  if (body?.action === 'ask' || body?.action === 'publish' || body?.action === 'connect') {
    const session = await auth()
    const by = session?.user?.name || session?.user?.email || 'an admin'
    if (body.action === 'publish' || body.action === 'connect') {
      const row = await prisma.hlSiteRequest.findUnique({ where: { clientId: id }, select: { id: true } })
      if (!row) return NextResponse.json({ ok: false, reason: 'Forge never built a site for this client.' }, { status: 409 })
      const res = await decideClientSite(row.id, body.action, by)
      return NextResponse.json(res, { status: res.ok ? 200 : 409 })
    }
    const res = await askForClientSite(id, 'manual', { overrideGhl: body.overrideGhl === true, by })
    return NextResponse.json(res, { status: res.ok ? 200 : 409 })
  }
  if (body?.action === 'preview') {
    try {
      const p = await previewClientSite(id)
      return NextResponse.json({ ok: true, prompt: p.prompt, costUsd: p.costUsd, note: p.note, notes: p.fill.notes, photos: { uploaded: p.facts.photos.length, shown: p.shown.length, skipped: p.facts.skipped } })
    } catch (err) {
      return NextResponse.json({ ok: false, reason: err instanceof Error ? err.message : String(err) }, { status: 409 })
    }
  }
  return NextResponse.json({ error: 'send { "action": "ask" }, { "action": "preview" }, { "action": "publish" }, { "action": "connect" } or { "action": "code", "text": "lovable_verify=…" }' }, { status: 400 })
}
