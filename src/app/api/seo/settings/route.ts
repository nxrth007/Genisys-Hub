import { NextRequest, NextResponse } from 'next/server'
import type { SeoSettings } from '@/lib/seo/api-types'
import { seoError, seoGuard } from '@/lib/seo/http'
import { updateSeoSettings } from '@/lib/seo/settings'

/** PATCH /api/seo/settings — weekly schedule, posts per week, cost cap. */
export async function PATCH(req: NextRequest) {
  const guard = await seoGuard()
  if (guard instanceof NextResponse) return guard
  let body: Partial<SeoSettings>
  try {
    body = (await req.json()) as Partial<SeoSettings>
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }
  try {
    // The model is chosen in code, not from the browser.
    const { model: _model, ...patch } = body
    void _model
    const settings = await updateSeoSettings(patch)
    return NextResponse.json({ settings })
  } catch (err) {
    return seoError(err, 'settings')
  }
}
