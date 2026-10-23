import { NextResponse } from 'next/server'
import { auth } from '@/auth'
import { siteSuggestions } from '@/lib/site-suggestions'

type Ctx = { params: Promise<{ id: string }> }

/**
 * GET /api/clients/[id]/site-suggestions
 *
 * Live sites that could be this client's, for the dropdown under the Site
 * field on the Clients page (src/lib/site-suggestions.ts). Staff-only, like
 * editing the Site itself.
 */
export async function GET(_req: Request, { params }: Ctx) {
  const session = await auth()
  if (!session?.user?.id) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  const role = (session.user as { role?: string } | undefined)?.role
  if (role !== 'admin' && role !== 'member') return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  const { id } = await params
  try {
    return NextResponse.json({ suggestions: await siteSuggestions(id) })
  } catch (err) {
    console.error(`[site-suggestions] ${id}:`, err)
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Couldn’t look for sites.' }, { status: 500 })
  }
}
