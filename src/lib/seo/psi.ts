import type { PsiResult } from './types'
import { getSecret } from './secrets'

/**
 * PageSpeed Insights v5 — one mobile Lighthouse run on Google's servers.
 *
 * Keyed when the Vault has a Google API key (25k runs/day); keyless
 * otherwise — but Google's anonymous pool was answering "quota 0/day" in
 * Sept 2026, so without a key expect an error rather than scores. A key
 * that exists but doesn't have the PageSpeed API enabled answers 400/403
 * on every call, so that falls back to keyless instead of failing outright.
 *
 * Only the numbers the audit and the report use are kept — the raw
 * response carries base64 screenshots and runs to megabytes.
 */

const ENDPOINT = 'https://www.googleapis.com/pagespeedonline/v5/runPagespeed'
// Lighthouse gives up at 120s server-side; waiting longer buys nothing.
const TIMEOUT_MS = 120_000
const RETRY_DELAY_MS = 15_000

type Json = Record<string, unknown>

const obj = (v: unknown): Json => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : {})
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null)

type Attempt = { status: number | null; body: Json | null; error: string | null }

async function call(url: string, key: string | null): Promise<Attempt> {
  const q = new URL(ENDPOINT)
  q.searchParams.set('url', url)
  q.searchParams.set('strategy', 'MOBILE')
  for (const c of ['PERFORMANCE', 'SEO', 'ACCESSIBILITY', 'BEST_PRACTICES']) q.searchParams.append('category', c)
  if (key) q.searchParams.set('key', key)
  try {
    const res = await fetch(q, { cache: 'no-store', headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(TIMEOUT_MS) })
    const text = await res.text()
    let body: Json | null = null
    try {
      body = obj(JSON.parse(text))
    } catch {
      body = null
    }
    if (res.ok) return { status: res.status, body, error: body ? null : 'PageSpeed returned a non-JSON response' }
    // Google's error message never contains the key; the request URL does, so it is never echoed.
    const message = str(obj(body?.error).message) ?? text.slice(0, 200)
    return { status: res.status, body: null, error: `PageSpeed HTTP ${res.status}: ${message}` }
  } catch (err) {
    const timedOut = err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')
    return { status: null, body: null, error: timedOut ? `PageSpeed timed out after ${TIMEOUT_MS / 1000}s` : `PageSpeed request failed: ${err instanceof Error ? err.message : String(err)}` }
  }
}

function roundOr(v: number | null, digits = 0): number | null {
  if (v === null) return null
  const f = 10 ** digits
  return Math.round(v * f) / f
}

/** Never throws — any failure comes back in `error` with every number null. */
export async function runPsi(url: string): Promise<PsiResult> {
  const result: PsiResult = {
    url,
    strategy: 'mobile',
    fetchedAt: new Date().toISOString(),
    scores: { performance: null, seo: null, accessibility: null, bestPractices: null },
    lab: { lcpMs: null, cls: null, tbtMs: null, fcpMs: null, speedIndexMs: null },
    field: null,
    error: null,
  }

  let key: string | null = null
  try {
    key = await getSecret('googleApiKey')
  } catch {
    // Vault unreachable: keyless still works, just throttled.
    key = null
  }

  let usedKey = key
  let a = await call(url, usedKey)
  if (usedKey && (a.status === 400 || a.status === 403)) {
    usedKey = null
    a = await call(url, null)
  }
  // Lighthouse failures surface as 5xx and usually pass on a second try.
  if (a.status === null || a.status >= 500) {
    await new Promise((r) => setTimeout(r, RETRY_DELAY_MS))
    a = await call(url, usedKey)
  }
  if (a.status === 429 && !usedKey) {
    // The shared keyless quota answered "limit 0 per day" when this was
    // written (Sept 2026): in practice "a key is required", not "try later".
    return {
      ...result,
      error: `PageSpeed needs an API key — Google refused the keyless request (quota exhausted). Add a Vault entry "Google API Key" with the PageSpeed Insights API enabled.${key ? ' The key in the Vault was rejected (PageSpeed API not enabled on it?).' : ''}`,
    }
  }
  if (!a.body) return { ...result, error: a.error ?? 'PageSpeed returned nothing' }

  const lh = obj(a.body.lighthouseResult)
  const runtime = obj(lh.runtimeError)
  const runtimeCode = str(runtime.code)
  if (runtimeCode && runtimeCode !== 'NO_ERROR') {
    return { ...result, error: `Lighthouse couldn't test the page: ${str(runtime.message) ?? runtimeCode}` }
  }

  const categories = obj(lh.categories)
  const score = (id: string) => num(obj(categories[id]).score)
  const audits = obj(lh.audits)
  const metric = (id: string) => num(obj(audits[id]).numericValue)

  // Field data: CrUX for this URL (or its origin when the URL alone is too
  // quiet). Most small contractor sites have none, and then the metrics
  // object is simply absent.
  const le = obj(a.body.loadingExperience)
  const m = obj(le.metrics)
  const pct = (id: string) => num(obj(m[id]).percentile)
  const lcp = pct('LARGEST_CONTENTFUL_PAINT_MS')
  const inp = pct('INTERACTION_TO_NEXT_PAINT')
  const clsRaw = pct('CUMULATIVE_LAYOUT_SHIFT_SCORE')
  const field =
    lcp !== null || inp !== null || clsRaw !== null
      ? {
          lcpMs: lcp,
          inpMs: inp,
          // CrUX reports CLS ×100 as an integer percentile (5 = 0.05).
          cls: clsRaw === null ? null : clsRaw / 100,
          category: str(le.overall_category),
        }
      : null

  return {
    ...result,
    fetchedAt: str(a.body.analysisUTCTimestamp) ?? result.fetchedAt,
    scores: {
      performance: score('performance'),
      seo: score('seo'),
      accessibility: score('accessibility'),
      bestPractices: score('best-practices'),
    },
    lab: {
      lcpMs: roundOr(metric('largest-contentful-paint')),
      cls: roundOr(metric('cumulative-layout-shift'), 3),
      tbtMs: roundOr(metric('total-blocking-time')),
      fcpMs: roundOr(metric('first-contentful-paint')),
      speedIndexMs: roundOr(metric('speed-index')),
    },
    field,
  }
}

// ---------------------------------------------------------------------------
// Key check for the setup checklist
// ---------------------------------------------------------------------------

export type PsiKeyState = 'ok' | 'missing' | 'invalid' | 'disabled' | 'restricted' | 'quota' | 'unknown'
export type PsiKeyCheck = { state: PsiKeyState; detail: string }

let keyCheck: { at: number; value: PsiKeyCheck } | null = null

/**
 * Does the Vault's Google key actually work for PageSpeed? A key existing
 * proves nothing — the Hub finds whatever Google key is there (often the
 * Maps one), and Maps keys usually don't have PageSpeed enabled.
 *
 * Google checks the key before the request itself, so asking for a
 * deliberately invalid URL answers in under a second without running
 * Lighthouse: "key not valid", "API disabled for this project", "key
 * restricted to other APIs" — or, when the key is fine, a complaint about
 * the URL. Cached for ten minutes.
 */
export async function checkPsiKey(): Promise<PsiKeyCheck> {
  if (keyCheck && Date.now() - keyCheck.at < 10 * 60_000) return keyCheck.value
  const key = await getSecret('googleApiKey').catch(() => null)
  let value: PsiKeyCheck
  if (!key) {
    value = { state: 'missing', detail: 'No Google API key in the Vault.' }
  } else {
    try {
      const res = await fetch(`${ENDPOINT}?url=not-a-url&key=${encodeURIComponent(key)}`, {
        cache: 'no-store',
        signal: AbortSignal.timeout(10_000),
      })
      const body = obj(await res.json().catch(() => ({})))
      const err = obj(body.error)
      const message = str(err.message) ?? `HTTP ${res.status}`
      const details = Array.isArray(err.details) ? err.details.map(obj) : []
      const reasons = details.map((d) => str(d.reason) ?? '')
      const activation = details.map((d) => str(obj(d.metadata).activationUrl)).find(Boolean) ?? null
      if (res.ok || (res.status === 400 && !reasons.includes('API_KEY_INVALID'))) {
        // The key got through; only the probe's fake URL was refused.
        value = { state: 'ok', detail: 'Google accepted the key for PageSpeed Insights.' }
      } else if (reasons.includes('API_KEY_INVALID')) {
        value = { state: 'invalid', detail: 'Google says this key isn’t valid (deleted or mistyped).' }
      } else if (reasons.includes('SERVICE_DISABLED') || /has not been used|is disabled/i.test(message)) {
        value = {
          state: 'disabled',
          detail: `The PageSpeed Insights API isn’t enabled in this key’s Google Cloud project.${activation ? ` Enable it: ${activation}` : ''}`,
        }
      } else if (reasons.some((r) => r.startsWith('API_KEY_') && r.endsWith('_BLOCKED')) || /blocked/i.test(message)) {
        value = {
          state: 'restricted',
          detail: reasons.includes('API_KEY_HTTP_REFERRER_BLOCKED')
            ? 'The key only works from certain websites (HTTP-referrer restriction), so the Hub’s server calls are refused.'
            : 'The key is restricted to other APIs (typical for a Maps key) — PageSpeed Insights isn’t on its allowed list.',
        }
      } else if (res.status === 429) {
        value = { state: 'quota', detail: 'The key’s daily PageSpeed quota is used up.' }
      } else {
        value = { state: 'unknown', detail: `Google answered ${res.status}: ${message.slice(0, 200)}` }
      }
    } catch (e) {
      value = { state: 'unknown', detail: `Couldn’t reach Google to check the key: ${e instanceof Error ? e.message : 'network error'}` }
    }
  }
  keyCheck = { at: Date.now(), value }
  return value
}
