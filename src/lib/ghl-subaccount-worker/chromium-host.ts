/**
 * How Chromium is found on Render's native Node runtime.
 *
 * That runtime is Debian 12 and cannot apt-get. Playwright's own
 * Chromium (installed into node_modules with PLAYWRIGHT_BROWSERS_PATH=0)
 * still needs libraries such as libnss3. scripts/install-render-chromium.mjs
 * downloads the Debian bookworm packages and unpacks them into
 * .chromium-libs. This module points the browser at those files.
 *
 * @sparticuz/chromium is the wrong tool here: it only unpacks its
 * libraries when it detects Amazon Linux, and its build lags the
 * Chromium revision Playwright 1.65 drives.
 *
 * The Docker fallback sets GHL_SUBACCOUNT_CHROMIUM=system. That image
 * already has the libraries, so this path stays out of the way.
 */
import { existsSync, mkdirSync, readdirSync, statSync } from 'fs'
import { join } from 'path'

export const CHROMIUM_LIBS_DIR = '.chromium-libs'

/** Sonames the Debian 12 base image already provides. Everything else must be in the bundle. */
export const BASE_SONAMES = new Set([
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

export function systemChromium(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.GHL_SUBACCOUNT_CHROMIUM ?? '').trim().toLowerCase() === 'system'
}

/** One renderer, no GPU, no /dev/shm. Kept small so the Hub's other work still fits in 2 GB. */
export function chromiumLaunchArgs(): string[] {
  return [
    '--no-sandbox',
    '--disable-dev-shm-usage',
    '--disable-gpu',
    '--disable-extensions',
    '--disable-background-networking',
    '--renderer-process-limit=1',
  ]
}

export function bundledLibDirs(root: string): string[] {
  const base = join(root, CHROMIUM_LIBS_DIR)
  if (!existsSync(base)) return []
  const dirs: string[] = []
  const walk = (dir: string) => {
    let names: string[]
    try {
      names = readdirSync(dir)
    } catch {
      return
    }
    let hasLibrary = false
    for (const name of names) {
      const path = join(dir, name)
      let info
      try {
        info = statSync(path)
      } catch {
        continue
      }
      if (info.isDirectory()) walk(path)
      else if (name.includes('.so')) hasLibrary = true
    }
    if (hasLibrary) dirs.push(dir)
  }
  walk(base)
  return dirs
}

export function prependLibraryPath(existing: string | undefined, dirs: string[]): string | undefined {
  if (!dirs.length) return existing
  const parts = [...dirs, ...(existing ? existing.split(':').filter(Boolean) : [])]
  return [...new Set(parts)].join(':')
}

/** Sonames Chromium needs that are neither in the base image nor in the unpacked debs. */
export function missingBundledSonames(needed: string[], present: Set<string>): string[] {
  return needed.filter((name) => !BASE_SONAMES.has(name) && !present.has(name))
}

/**
 * Call before launching Playwright. Puts the unpacked libraries on
 * LD_LIBRARY_PATH and tells Playwright to use the copy installed into
 * node_modules, which is what the Render build keeps.
 */
export function prepareChromiumEnv(root = process.cwd(), env: NodeJS.ProcessEnv = process.env): void {
  if (systemChromium(env)) return
  if (!env.PLAYWRIGHT_BROWSERS_PATH) env.PLAYWRIGHT_BROWSERS_PATH = '0'
  const base = join(root, CHROMIUM_LIBS_DIR)
  if (existsSync(base)) {
    // The host's GIO modules are built against a different glib and abort Chrome if loaded.
    const gio = join(base, 'gio-empty')
    mkdirSync(gio, { recursive: true })
    if (!env.GIO_MODULE_DIR) env.GIO_MODULE_DIR = gio
  }
  const next = prependLibraryPath(env.LD_LIBRARY_PATH, bundledLibDirs(root))
  if (next) env.LD_LIBRARY_PATH = next
}
