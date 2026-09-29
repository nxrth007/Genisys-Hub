import { NextResponse } from 'next/server'
import { listOwnedRepos } from '@/lib/seo/github'
import { seoGuard } from '@/lib/seo/http'

/** GET /api/seo/github/repos — the token owner's repos, for the "Add site" picker. */
export async function GET() {
  const guard = await seoGuard()
  if (guard instanceof NextResponse) return guard
  try {
    const repos = await listOwnedRepos()
    return NextResponse.json({
      repos: repos
        .filter((r) => r.fullName.toLowerCase() !== 'nxrth007/genisys-hub')
        .map((r) => ({ fullName: r.fullName, private: r.private, pushedAt: r.pushedAt })),
    })
  } catch (err) {
    // The picker degrades to a text field; say why.
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Couldn’t reach GitHub.' }, { status: 502 })
  }
}
