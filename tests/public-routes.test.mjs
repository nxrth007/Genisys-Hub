import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

/**
 * Routes that outside services and the public call (Stripe, Whop, GHL, Twilio,
 * the onboarding form, links in emails) must be exempt from the Hub's login
 * check in src/middleware.ts, or every call meets a 401 before the route runs.
 *
 * The Stripe webhook and the form's checkout check sat behind it from
 * 2026-11-17 to 11-19. Every Stripe delivery was refused, and Stripe's retries
 * then brought sign-up texts in one to two days late.
 */

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const middleware = readFileSync(join(root, 'src/middleware.ts'), 'utf8')

/** The folders whose routes are called from outside the Hub. */
const OUTSIDE_FACING = ['src/app/api/webhooks', 'src/app/api/public', 'src/app/api/hl/public', 'src/app/api/hl/twilio', 'src/app/api/external']

function publicPaths() {
  const block = middleware.match(/const PUBLIC_PATHS = \[([\s\S]*?)\n\]/)
  assert.ok(block, 'PUBLIC_PATHS not found in src/middleware.ts')
  return [...block[1].matchAll(/^\s*'([^']+)'/gm)].map((m) => m[1])
}

/** The same rule as isPublic() in src/middleware.ts. */
const isPublic = (paths, pathname) => paths.some((p) => pathname === p || pathname.startsWith(p + '/'))

function routeFiles(dir) {
  const out = []
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) out.push(...routeFiles(full))
    else if (name === 'route.ts') out.push(full)
  }
  return out
}

/** src/app/api/public/gbp/[token]/route.ts → /api/public/gbp/x: a dynamic segment stands for any value, a (group) adds nothing. */
const urlOf = (file) =>
  '/' +
  relative(join(root, 'src/app'), dirname(file))
    .split(sep)
    .filter((seg) => !/^\(.*\)$/.test(seg))
    .map((seg) => (/^\[.*\]$/.test(seg) ? 'x' : seg))
    .join('/')

test('every webhook and public API route is exempt from the login check', () => {
  const paths = publicPaths()
  const files = OUTSIDE_FACING.filter((d) => existsSync(join(root, d))).flatMap((d) => routeFiles(join(root, d)))
  assert.ok(files.length >= 20, `found only ${files.length} routes; did the folders move?`)
  const blocked = files.map(urlOf).filter((url) => !isPublic(paths, url))
  assert.deepEqual(blocked, [], `behind the login check, so outside callers get a 401: ${blocked.join(', ')}. Add them to PUBLIC_PATHS in src/middleware.ts.`)
})

test('the Stripe webhook and the form\'s checkout check are among them', () => {
  const paths = publicPaths()
  assert.ok(isPublic(paths, '/api/webhooks/stripe'))
  assert.ok(isPublic(paths, '/api/public/checkout-verify'))
})

test('this test reads PUBLIC_PATHS the way the middleware matches it', () => {
  // If the middleware's rule changed (exact matches only, say), the check above would no longer mean what it says.
  assert.match(middleware, /PUBLIC_PATHS\.some\(\(p\) => pathname === p \|\| pathname\.startsWith\(p \+ '\/'\)\)/)
})
