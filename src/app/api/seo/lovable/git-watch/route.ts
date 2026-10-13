import { NextRequest, NextResponse } from 'next/server'
import { attachToClient, gitWatchView, runLovableGitWatch, setDismissed } from '@/lib/seo/lovable-git-watch'
import { seoError, seoGuard } from '@/lib/seo/http'

/**
 * GET  /api/seo/lovable/git-watch — new Lovable projects and their GitHub state.
 * POST /api/seo/lovable/git-watch
 *   { action: 'run' }                                  check now (no Slack post)
 *   { action: 'dismiss' | 'restore', projectId }       stop / start flagging a project
 *   { action: 'attach', projectId, clientId }          link its repo to a client
 */
export async function GET() {
  const guard = await seoGuard()
  if (guard instanceof NextResponse) return guard
  try {
    return NextResponse.json(await gitWatchView())
  } catch (err) {
    return seoError(err, 'lovable git watch')
  }
}

export async function POST(req: NextRequest) {
  const guard = await seoGuard()
  if (guard instanceof NextResponse) return guard
  let body: { action?: unknown; projectId?: unknown; clientId?: unknown }
  try {
    body = (await req.json()) as typeof body
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }
  const projectId = typeof body.projectId === 'string' ? body.projectId : ''
  try {
    if (body.action === 'run') {
      const result = await runLovableGitWatch()
      return NextResponse.json({ result, view: await gitWatchView() })
    }
    if (body.action === 'dismiss' || body.action === 'restore') {
      if (!projectId) return NextResponse.json({ error: 'projectId is required' }, { status: 400 })
      await setDismissed(projectId, body.action === 'dismiss')
      return NextResponse.json({ view: await gitWatchView() })
    }
    if (body.action === 'attach') {
      const clientId = typeof body.clientId === 'string' ? body.clientId : ''
      if (!projectId || !clientId) return NextResponse.json({ error: 'projectId and clientId are required' }, { status: 400 })
      try {
        await attachToClient(projectId, clientId)
      } catch (err) {
        return NextResponse.json({ error: err instanceof Error ? err.message : 'Couldn’t link it' }, { status: 400 })
      }
      return NextResponse.json({ view: await gitWatchView() })
    }
    return NextResponse.json({ error: 'Unknown action' }, { status: 400 })
  } catch (err) {
    return seoError(err, 'lovable git watch')
  }
}
