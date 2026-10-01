import { NextRequest, NextResponse } from 'next/server'
import { assignClientRepo } from '@/lib/seo/actions'
import { seoError, seoGuard } from '@/lib/seo/http'

type Ctx = { params: Promise<{ id: string }> }

/**
 * PUT /api/clients/[id]/repo { repoFullName: "owner/name" | null }
 *
 * Links a client to the GitHub repo its website lives in (the Repo column
 * on the Clients page). The link is held by the client's SEO site, which
 * is created if it doesn't exist yet. Same allowlist as SEO — the repo is
 * what the engine commits to.
 */
export async function PUT(req: NextRequest, { params }: Ctx) {
  const guard = await seoGuard()
  if (guard instanceof NextResponse) return guard
  const { id } = await params
  let body: { repoFullName?: unknown }
  try {
    body = (await req.json()) as { repoFullName?: unknown }
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }
  const repo = typeof body.repoFullName === 'string' && body.repoFullName.trim() ? body.repoFullName.trim() : null
  try {
    return NextResponse.json(await assignClientRepo(id, repo))
  } catch (err) {
    return seoError(err, 'assign client repo')
  }
}
