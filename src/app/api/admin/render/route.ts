import { NextRequest, NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/auth-helpers'
import { renderDeploys } from '@/lib/render'

/**
 * GET /api/admin/render[?deploy=<id>]
 *
 * The Hub's recent Render deploys, with the build log of the given deploy
 * (default: the latest that failed). Read through Render's API with the
 * Vault's "Render API Key"; admin-only, and never returns the key.
 */
export async function GET(req: NextRequest) {
  const denial = await requireAdmin()
  if (denial) return denial
  try {
    return NextResponse.json(await renderDeploys({ deployId: req.nextUrl.searchParams.get('deploy') ?? undefined }))
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 502 })
  }
}
