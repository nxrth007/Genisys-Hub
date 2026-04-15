/**
 * Global auth middleware.
 *
 * Forces sign-in for every page and every /api/* route, with a small
 * whitelist for auth endpoints themselves and the health check.
 *
 * Any unauthenticated request to a protected path is redirected (for pages)
 * or returns 401 JSON (for API routes).
 */
import { NextResponse } from 'next/server'
import { auth } from '@/auth'

const PUBLIC_PATHS = [
  '/signin',
  '/api/auth', // NextAuth's own routes
  '/api/health',
]

function isPublic(pathname: string): boolean {
  return PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(p + '/'))
}

export default auth((req) => {
  const { pathname } = req.nextUrl

  if (isPublic(pathname)) return NextResponse.next()
  if (req.auth) return NextResponse.next()

  // API requests → 401 JSON so the client can show a clean error.
  if (pathname.startsWith('/api/')) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  // Pages → redirect to signin, preserving where the user was trying to go.
  const signInUrl = new URL('/signin', req.nextUrl.origin)
  signInUrl.searchParams.set('callbackUrl', req.nextUrl.href)
  return NextResponse.redirect(signInUrl)
})

export const config = {
  // Auth.js's PrismaAdapter transitively uses Node builtins (node:path, etc.)
  // that aren't available in the Edge runtime, so we explicitly run middleware
  // on the Node runtime. Slightly heavier cold start, but correct.
  runtime: 'nodejs',
  // Skip static assets and Next.js internals.
  matcher: ['/((?!_next/static|_next/image|favicon.ico|.*\\.(?:png|jpg|jpeg|gif|svg|webp)).*)'],
}
