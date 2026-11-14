import { NextResponse } from 'next/server'
import { auth } from '@/auth'
import { requireAdmin, requireStaff } from '@/lib/auth-helpers'
import { prisma } from '@/lib/prisma'
import { askForClientSite, decideClientSite, pasteDomainCode, previewClientSite } from '@/lib/hl/site-request'
import { lovableEmbedUrl } from '@/lib/seo/lovable-mcp'

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
 *
 * POST { action: 'embed' } — staff: Lovable's preview of the client's latest
 * build for an iframe on the asking page's origin (the Sites folder's builder
 * window), valid an hour. Forge's copy, else the SEO seat's project.
 */
export const dynamic = 'force-dynamic'
// A preview is one Claude call that looks at the client's photos: a few minutes at most.
export const maxDuration = 600

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const denied = await requireStaff()
  if (denied) return denied
  const { id } = await params
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
  // Lovable's preview of the latest build, for the folder's builder window: staff, like the folder.
  if (body?.action === 'embed') {
    const staffDenied = await requireStaff()
    if (staffDenied) return staffDenied
    // The page asking is the one that embeds it: the browser's own Origin header, on https.
    const origin = req.headers.get('origin') ?? ''
    if (!/^https:\/\/[a-z0-9.-]+$/.test(origin)) return NextResponse.json({ ok: false, reason: 'Lovable’s preview only loads on the Hub’s https address.' }, { status: 400 })
    const row = await prisma.client.findUnique({ where: { id }, select: { hlSiteRequest: { select: { projectId: true } }, seoSite: { select: { lovableProjectId: true } } } })
    const projectId = row?.hlSiteRequest?.projectId ?? row?.seoSite?.lovableProjectId ?? null
    if (!projectId) return NextResponse.json({ ok: false, reason: 'This client has no Lovable project.' }, { status: 409 })
    try {
      const e = await lovableEmbedUrl(projectId, origin)
      return NextResponse.json({ ok: true, url: e.url, expiresAt: e.expiresAt })
    } catch (err) {
      return NextResponse.json({ ok: false, reason: err instanceof Error ? err.message : String(err) }, { status: 409 })
    }
  }
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
