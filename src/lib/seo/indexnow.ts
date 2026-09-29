import { randomBytes } from 'node:crypto'

/**
 * IndexNow — tell Bing (and Yandex, Naver, Seznam, Yep) that URLs changed.
 * Google doesn't take part; the sitemap submit covers Google.
 *
 * The site proves it owns the key by serving https://{host}/{key}.txt
 * containing the key, so a ping only works once that file is live.
 */

const ENDPOINT = 'https://api.indexnow.org/IndexNow'
const MAX_URLS = 10_000
const TIMEOUT_MS = 15_000

/** 32 hex characters — inside IndexNow's 8–128 [a-zA-Z0-9-] rule. */
export function newIndexNowKey(): string {
  return randomBytes(16).toString('hex')
}

const MEANING: Record<number, string> = {
  200: 'URLs submitted',
  202: 'URLs received; the key file will be checked',
  400: 'Bad request — the payload was rejected',
  403: "Key not valid — the key file isn't live at the key location or doesn't contain the key",
  422: "URLs don't belong to the host, or the key doesn't match the host",
  429: 'Too many requests — IndexNow treats this as spam; back off',
}

/** Never throws. `ok` is true only for 200/202. */
export async function pingIndexNow(o: { host: string; key: string; urls: string[] }): Promise<{ ok: boolean; status: number | null; detail: string }> {
  // Accept "https://example.com/", "example.com" or "example.com:8443".
  const host = o.host
    .trim()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//i, '')
    .replace(/\/.*$/, '')
    .toLowerCase()
  if (!host) return { ok: false, status: null, detail: 'No host given' }
  if (!/^[a-zA-Z0-9-]{8,128}$/.test(o.key)) return { ok: false, status: null, detail: 'Key must be 8–128 characters of letters, digits or "-"' }

  // IndexNow rejects the whole batch (422) if any URL is off-host, so drop
  // strays here rather than lose the rest.
  const urls: string[] = []
  const seen = new Set<string>()
  let dropped = 0
  for (const raw of o.urls) {
    let u: URL
    try {
      u = new URL(raw)
    } catch {
      dropped++
      continue
    }
    if ((u.protocol !== 'https:' && u.protocol !== 'http:') || u.host.toLowerCase() !== host) {
      dropped++
      continue
    }
    u.hash = ''
    if (seen.has(u.href)) continue
    seen.add(u.href)
    urls.push(u.href)
  }
  if (!urls.length) return { ok: false, status: null, detail: `No URLs on ${host} to submit${dropped ? ` (${dropped} dropped as off-host or invalid)` : ''}` }

  const batch = urls.slice(0, MAX_URLS)
  try {
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ host, key: o.key, keyLocation: `https://${host}/${o.key}.txt`, urlList: batch }),
      cache: 'no-store',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    const body = (await res.text().catch(() => '')).trim()
    const ok = res.status === 200 || res.status === 202
    const notes = [
      `${batch.length} URL${batch.length === 1 ? '' : 's'}`,
      dropped ? `${dropped} off-host dropped` : '',
      urls.length > batch.length ? `${urls.length - batch.length} over the ${MAX_URLS} limit not sent` : '',
    ].filter(Boolean)
    const meaning = MEANING[res.status] ?? `HTTP ${res.status}`
    return { ok, status: res.status, detail: `${meaning} (${notes.join(', ')})${!ok && body ? `: ${body.slice(0, 200)}` : ''}` }
  } catch (err) {
    const timedOut = err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')
    return { ok: false, status: null, detail: timedOut ? `IndexNow timed out after ${TIMEOUT_MS / 1000}s` : `IndexNow request failed: ${err instanceof Error ? err.message : String(err)}` }
  }
}
