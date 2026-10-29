import { NextRequest, NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/auth-helpers'
import { renderMonitorEnabled, renderMonitorOnce } from '@/lib/render-monitor-run'

/**
 * POST /api/admin/render/monitor[?dryRun=0]
 *   Run the Render monitor once (lib/render-monitor.ts). Dry run by default:
 *   returns the problems and the texts it would send, sends and saves nothing.
 *   `dryRun=0` really sends (only when RENDER_MONITOR_ENABLED=1). Admin-only.
 */
export async function POST(req: NextRequest) {
  const denial = await requireAdmin()
  if (denial) return denial
  const dryRun = req.nextUrl.searchParams.get('dryRun') !== '0' || !renderMonitorEnabled()
  try {
    return NextResponse.json({ enabled: renderMonitorEnabled(), ...(await renderMonitorOnce({ dryRun })) })
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 502 })
  }
}
