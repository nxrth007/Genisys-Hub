import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

/**
 * Genisys OS as a phone app (src/components/genisys-os/app-meta.ts): "Add to Home Screen" reads the
 * manifest and its icons, and Chrome wants the service worker, all fetched without the sign-in
 * cookie. Behind the Hub's login check they'd get the sign-in page, and the app would have no name,
 * no icon and no install button.
 */

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const middleware = readFileSync(join(root, 'src/middleware.ts'), 'utf8')
const manifest = JSON.parse(readFileSync(join(root, 'public/genisys-os.webmanifest'), 'utf8'))

function publicPaths() {
  const block = middleware.match(/const PUBLIC_PATHS = \[([\s\S]*?)\n\]/)
  assert.ok(block, 'PUBLIC_PATHS not found in src/middleware.ts')
  return [...block[1].matchAll(/^\s*'([^']+)'/gm)].map((m) => m[1])
}
const isPublic = (paths, pathname) => paths.some((p) => pathname === p || pathname.startsWith(p + '/'))

test('the manifest and the service worker load signed out; Genisys OS itself does not', () => {
  const paths = publicPaths()
  assert.ok(isPublic(paths, '/genisys-os.webmanifest'))
  assert.ok(isPublic(paths, '/genisys-os-sw.js'))
  assert.ok(!isPublic(paths, '/genisys-os'))
  assert.ok(!isPublic(paths, '/genisys-os/abc123/dashboard'))
})

test('the icons are files the middleware never gates (.png) and they exist', () => {
  // The middleware's matcher skips .png, so the icons load signed out without a PUBLIC_PATHS entry.
  assert.match(middleware, /png\|jpg\|jpeg\|gif\|svg\|webp/)
  for (const icon of manifest.icons) {
    assert.match(icon.src, /\.png$/)
    assert.ok(existsSync(join(root, 'public', icon.src)), `${icon.src} is missing (node scripts/build-genisys-os-icons.mjs)`)
  }
  // iPhones use the apple-icon beside the pages, not the manifest's.
  assert.ok(existsSync(join(root, 'src/app/genisys-os/apple-icon.png')))
  assert.ok(existsSync(join(root, 'src/app/login/apple-icon.png')))
})

test('the manifest makes a full-screen app that opens on Genisys OS', () => {
  assert.equal(manifest.name, 'Genisys OS')
  assert.ok(manifest.short_name.length <= 12, 'a home-screen label longer than ~12 characters gets cut off')
  assert.equal(manifest.display, 'standalone')
  assert.equal(manifest.start_url, '/genisys-os')
  // The sign-in page (/login) has to stay inside the app, so the scope is the whole site.
  assert.equal(manifest.scope, '/')
  const sizes = manifest.icons.map((i) => `${i.sizes} ${i.purpose}`)
  assert.ok(sizes.includes('192x192 any') && sizes.includes('512x512 any'), 'Chrome needs a 192 and a 512 icon')
  assert.ok(sizes.includes('512x512 maskable'), 'Android crops icons to its own shape: give it a maskable one')
})

test('the service worker only steps in for page loads, and never caches', () => {
  const sw = readFileSync(join(root, 'public/genisys-os-sw.js'), 'utf8')
  assert.match(sw, /request\.mode !== 'navigate'\) return/)
  assert.doesNotMatch(sw, /caches\./)
})
