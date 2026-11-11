/**
 * Install Playwright's Chromium plus the Debian 12 libraries it needs,
 * without root and without apt-get install.
 *
 * Render's native Node runtime is Debian 12 (bookworm). `npx playwright
 * install chromium` downloads a matching browser, but the browser will
 * not start until libnss3 and the rest are on disk, and this runtime
 * cannot install OS packages. `apt-get download` is not required: the
 * bookworm package index and the .deb files are fetched over HTTPS and
 * unpacked with dpkg-deb into .chromium-libs.
 *
 * Run from the repo root, on Linux, during the Render build:
 *   node scripts/install-render-chromium.mjs
 *
 * No-ops on macOS/Windows (local dev) and when GHL_SUBACCOUNT_CHROMIUM=system
 * (the optional Docker image, which already has the libraries).
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gunzipSync } from 'node:zlib'

const ROOT = process.cwd()
const LIBS = join(ROOT, '.chromium-libs')
const MIRROR = 'https://deb.debian.org/debian'
const INDEX = `${MIRROR}/dists/bookworm/main/binary-amd64/Packages.gz`

/** What Playwright lists for debian12-x64 Chromium. Transitive Depends are pulled too. */
const SEED = [
  'libasound2',
  'libatk-bridge2.0-0',
  'libatk1.0-0',
  'libatspi2.0-0',
  'libcairo2',
  'libcups2',
  'libdbus-1-3',
  'libdrm2',
  'libgbm1',
  'libglib2.0-0',
  'libnspr4',
  'libnss3',
  'libpango-1.0-0',
  'libx11-6',
  'libxcb1',
  'libxcomposite1',
  'libxdamage1',
  'libxext6',
  'libxfixes3',
  'libxkbcommon0',
  'libxrandr2',
  // Chrome links this directly; it is not a Depends of the packages above.
  'libudev1',
]

/** Already on Debian 12. Unpacking a second libc breaks the dynamic linker. */
const SKIP = new Set(['libc6', 'libgcc-s1', 'libstdc++6', 'gcc-12-base', 'gcc-11-base'])

const BASE_SONAMES = new Set([
  'libc.so.6',
  'libdl.so.2',
  'libm.so.6',
  'libpthread.so.0',
  'librt.so.1',
  'libresolv.so.2',
  'libutil.so.1',
  'ld-linux-x86-64.so.2',
  'libstdc++.so.6',
  'libgcc_s.so.1',
])

function log(msg) {
  console.log(`[chromium] ${msg}`)
}

async function downloadToFile(url, dest) {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`GET ${url} answered ${res.status}`)
  writeFileSync(dest, Buffer.from(await res.arrayBuffer()))
}

function parseIndex(text) {
  const byName = new Map()
  for (const block of text.split('\n\n')) {
    const fields = {}
    let key = ''
    for (const line of block.split('\n')) {
      if (line.startsWith(' ') || line.startsWith('\t')) {
        if (key) fields[key] += line
        continue
      }
      const cut = line.indexOf(':')
      if (cut === -1) continue
      key = line.slice(0, cut)
      fields[key] = line.slice(cut + 1).trim()
    }
    if (fields.Package && fields.Filename) byName.set(fields.Package, fields)
  }
  return byName
}

function depNames(depends) {
  if (!depends) return []
  return depends.split(',').map((part) => {
    const choice = part.split('|')[0].trim()
    return choice.replace(/\(.*\)/, '').replace(/:\S+$/, '').trim()
  }).filter(Boolean)
}

function closure(index, seeds) {
  const want = new Set()
  const pending = [...seeds]
  const missing = []
  while (pending.length) {
    const name = pending.pop()
    if (!name || want.has(name) || SKIP.has(name)) continue
    const pkg = index.get(name)
    if (!pkg) {
      missing.push(name)
      continue
    }
    want.add(name)
    for (const dep of depNames(pkg.Depends)) pending.push(dep)
  }
  return { names: [...want], missing }
}

function walkFiles(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    const info = statSync(path)
    if (info.isDirectory()) walkFiles(path, out)
    else out.push(path)
  }
  return out
}

function sonamesPresent(root) {
  const present = new Set()
  if (!existsSync(root)) return present
  for (const path of walkFiles(root)) {
    const base = path.slice(path.lastIndexOf('/') + 1)
    if (!base.includes('.so')) continue
    present.add(base)
  }
  return present
}

function findChrome(root) {
  const base = join(root, 'node_modules/playwright-core/.local-browsers')
  if (!existsSync(base)) return null
  const hits = walkFiles(base).filter((path) => /\/(chrome|chromium|headless_shell)$/.test(path) && !path.includes('chrome-wrapper'))
  return hits.find((path) => path.endsWith('/chrome')) || hits[0] || null
}

/** NEEDED sonames from an ELF64 binary. readelf is not on Render's native image. */
function neededSonames(chrome) {
  const buf = readFileSync(chrome)
  if (buf[0] !== 0x7f || buf.toString('utf8', 1, 4) !== 'ELF' || buf[4] !== 2) {
    throw new Error(`${chrome} is not an ELF64 binary`)
  }
  const le = buf[5] === 1
  const u16 = (o) => (le ? buf.readUInt16LE(o) : buf.readUInt16BE(o))
  const u32 = (o) => (le ? buf.readUInt32LE(o) : buf.readUInt32BE(o))
  const u64 = (o) => Number(le ? buf.readBigUInt64LE(o) : buf.readBigUInt64BE(o))
  const phoff = u64(32)
  const phentsize = u16(54)
  const phnum = u16(56)
  const loads = []
  let dynOff = 0
  let dynSize = 0
  for (let i = 0; i < phnum; i++) {
    const off = phoff + i * phentsize
    const type = u32(off)
    const pOffset = u64(off + 8)
    const pVaddr = u64(off + 16)
    const pFilesz = u64(off + 32)
    if (type === 1) loads.push({ pOffset, pVaddr, pFilesz })
    if (type === 2) {
      dynOff = pOffset
      dynSize = pFilesz
    }
  }
  const toOff = (vaddr) => {
    for (const load of loads) {
      if (vaddr >= load.pVaddr && vaddr < load.pVaddr + load.pFilesz) return load.pOffset + (vaddr - load.pVaddr)
    }
    throw new Error(`no PT_LOAD covers address ${vaddr}`)
  }
  let strtab = 0
  const needed = []
  for (let o = dynOff; o + 16 <= dynOff + dynSize; o += 16) {
    const tag = u64(o)
    const val = u64(o + 8)
    if (tag === 0) break
    if (tag === 1) needed.push(val)
    if (tag === 5) strtab = val
  }
  const strOff = toOff(strtab)
  return needed.map((rel) => {
    const start = strOff + rel
    const end = buf.indexOf(0, start)
    return buf.toString('utf8', start, end)
  })
}

if (process.platform !== 'linux') {
  log('skipping (not Linux). On a Mac or Windows machine, `npx playwright install chromium` is enough for a local dry run.')
  process.exit(0)
}
if ((process.env.GHL_SUBACCOUNT_CHROMIUM ?? '').trim().toLowerCase() === 'system') {
  log('skipping bundled libraries (GHL_SUBACCOUNT_CHROMIUM=system).')
  process.exit(0)
}

process.env.PLAYWRIGHT_BROWSERS_PATH = '0'
delete process.env.PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD
log('installing Playwright Chromium into node_modules (PLAYWRIGHT_BROWSERS_PATH=0)')
execFileSync('npx', ['playwright', 'install', 'chromium'], { stdio: 'inherit', env: process.env })

log('reading the Debian bookworm package index')
const indexRes = await fetch(INDEX)
if (!indexRes.ok) throw new Error(`package index answered ${indexRes.status}`)
const index = parseIndex(gunzipSync(Buffer.from(await indexRes.arrayBuffer())).toString('utf8'))
const { names, missing } = closure(index, SEED)
if (missing.length) log(`not in bookworm main, left for the base image: ${missing.join(', ')}`)
log(`unpacking ${names.length} packages into .chromium-libs`)
rmSync(LIBS, { recursive: true, force: true })
mkdirSync(LIBS, { recursive: true })
const debs = join(tmpdir(), 'chromium-debs')
mkdirSync(debs, { recursive: true })
for (const name of names) {
  const pkg = index.get(name)
  const deb = join(debs, `${name}.deb`)
  await downloadToFile(`${MIRROR}/${pkg.Filename}`, deb)
  execFileSync('dpkg-deb', ['-x', deb, LIBS], { stdio: 'ignore' })
}

const chrome = findChrome(ROOT)
if (!chrome) {
  console.error('[chromium] Playwright installed, but the chrome binary was not under node_modules/playwright-core/.local-browsers')
  process.exit(1)
}
const needed = neededSonames(chrome)
const present = sonamesPresent(LIBS)
const reallyAbsent = needed.filter((name) => !BASE_SONAMES.has(name) && !present.has(name))
if (reallyAbsent.length) {
  console.error(`[chromium] these libraries are not in the bundle or the Debian base: ${reallyAbsent.join(', ')}`)
  console.error('[chromium] the browser would fail on Render with "error while loading shared libraries".')
  process.exit(1)
}

const libDirs = []
const mark = (dir) => {
  let has = false
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) mark(path)
    else if (name.includes('.so')) has = true
  }
  if (has) libDirs.push(dir)
}
mark(LIBS)
log(`launching ${chrome} with the bundled libraries to confirm the linker is satisfied`)
execFileSync(chrome, ['--version'], {
  stdio: 'inherit',
  env: { ...process.env, LD_LIBRARY_PATH: libDirs.join(':') },
})
log(`ready (${names.length} packages). Idle Hub memory is unchanged until a job opens the browser.`)
