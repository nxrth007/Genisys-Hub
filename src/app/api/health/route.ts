import { NextResponse } from 'next/server'

/**
 * Used by Render's healthCheckPath to confirm the service is alive.
 * Keep this endpoint fast and dependency-free.
 *
 * `commit` exposes which git SHA is actually running — Render
 * injects RENDER_GIT_COMMIT into every build. Lets anyone answer
 * "did my push actually deploy?" by comparing against GitHub's
 * main HEAD, instead of hunting through the dashboard. Public and
 * harmless: a bare SHA reveals nothing sensitive.
 */
export function GET() {
  return NextResponse.json({
    ok: true,
    ts: Date.now(),
    commit: process.env.RENDER_GIT_COMMIT?.slice(0, 7) ?? null,
  })
}
