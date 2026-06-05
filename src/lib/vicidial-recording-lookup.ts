/**
 * Vicidial recording_lookup integration.
 *
 * Uses the BPO's whitelisted non_agent_api.php `recording_lookup`
 * function to find a recording for a given customer phone number,
 * then constructs the playback URL and signs it through our
 * existing recording proxy.
 *
 * Why this matters: today Mary pastes a vicitel recording URL by
 * hand when she creates an appointment or callback. With this
 * lookup we can do it automatically — agents save the row and the
 * link auto-fills if Vicidial has a recent recording for that
 * customer. They can still override if they want a different one.
 *
 * Per the probe (2026-06-05), `recording_lookup` is one of four
 * functions the BPO has whitelisted on their non_agent_api.php:
 * version, agent_status, add_lead, update_lead, recording_lookup.
 *
 * Reference: docs/vicidial-knowledge-base.md sections 3 and 4.
 */

import { getSecretByName } from './vault-service'
import { signRecordingUrl } from './recording-proxy'

const VICIDIAL_BASE = 'https://expeditusbpo.vicitel.cc'
const VICIDIAL_API = `${VICIDIAL_BASE}/vicidial/non_agent_api.php`
const USER_AGENT =
  'Mozilla/5.0 (Hub-Scraper) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36'

/** Recording filename → playback URL. Mirrors what's at the
 *  BPO based on the standard Vicidial recording-folder layout
 *  (per knowledge base section 1, Asterisk writes to
 *  /var/spool/asterisk/RECORDINGS/MP3/<filename>.mp3 which is
 *  exposed at /RECORDINGS/MP3/ over HTTP). */
function buildRecordingUrl(filename: string): string {
  // Vicidial's recording_lookup returns the bare filename without
  // an extension some installs; with .mp3 on others. Normalize so
  // the URL always ends in a recognizable extension.
  const safe = filename.trim().replace(/^[\\/]+/, '')
  const withExt = /\.(mp3|wav|gsm)$/i.test(safe) ? safe : `${safe}.mp3`
  return `${VICIDIAL_BASE}/RECORDINGS/MP3/${withExt}`
}

export type LookupResult =
  | {
      ok: true
      /** Raw vicitel URL (un-signed) — store on the appointment/
       *  callback row. The recording-proxy signs it at render
       *  time via the existing flow. */
      recordingLink: string
      filename: string
      startTime: string | null
      callerId: string | null
      durationSec: number | null
      /** Vicidial call_log uniqueid — useful for cross-referencing
       *  with vicidial_log table later. */
      vicidialId: string | null
    }
  | {
      ok: false
      error: string
    }

/**
 * Find the most recent recording for a customer phone number.
 *
 * Vicidial's recording_lookup function returns rows in
 * `recording_id|filename|location|start_time|caller_code|...`
 * pipe-delimited format on success. We take the FIRST row
 * because the API returns most-recent-first by default.
 *
 * Returns ok:false (not throwing) when:
 *  - credentials missing
 *  - API rejects the call
 *  - no recordings found for the phone
 *
 * Callers should treat ok:false as "no auto-attach available;
 * leave the field empty for manual entry" — never block the
 * user's primary action (creating a callback / appointment)
 * on this lookup.
 */
export async function findMostRecentRecording(opts: {
  phone: string
}): Promise<LookupResult> {
  const phone = opts.phone.replace(/\D/g, '')
  if (!phone || phone.length < 7) {
    return { ok: false, error: 'phone number too short for lookup' }
  }

  try {
    const username = (await getSecretByName('Vicidial Admin Username')).trim()
    const password = (await getSecretByName('Vicidial Admin Password')).trim()
    if (!username || !password) {
      return { ok: false, error: 'Vicidial credentials missing from vault' }
    }
    const basicAuth = Buffer.from(`${username}:${password}`).toString('base64')

    // recording_lookup parameters per VICIdial docs. We search by
    // phone_number. duration=0 + length_in_min=0 to avoid extra
    // filtering. start_date / end_date omitted so Vicidial uses
    // its default "recent" window.
    const params = new URLSearchParams({
      source: 'hub',
      user: username,
      pass: password,
      function: 'recording_lookup',
      phone_number: phone,
    })

    const res = await fetch(`${VICIDIAL_API}?${params.toString()}`, {
      headers: {
        'User-Agent': USER_AGENT,
        Authorization: `Basic ${basicAuth}`,
        Accept: 'text/plain',
      },
    })
    if (!res.ok) {
      return { ok: false, error: `Vicidial API HTTP ${res.status}` }
    }
    const body = await res.text()
    const trimmed = body.trim()
    if (trimmed.startsWith('ERROR')) {
      return { ok: false, error: trimmed.slice(0, 300) }
    }

    // recording_lookup body shape (per Vicidial docs):
    //   <count> recording records found
    //   recording_id|location|start_time|filename|...
    //   ...
    // Some installs include a "SUCCESS:" prefix on the first line;
    // others go straight to data. We tolerate both.
    const lines = trimmed
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean)
    // Find the first line that has at least 4 pipe-delimited
    // fields and starts with something digit-ish (recording_id).
    let firstData: string | null = null
    for (const line of lines) {
      if (line.startsWith('SUCCESS')) continue
      if (line.startsWith('ERROR')) continue
      if (!line.includes('|')) continue
      const parts = line.split('|')
      if (parts.length < 4) continue
      // recording_id is typically numeric. Header rows have
      // non-numeric first column.
      if (/^\d+$/.test(parts[0])) {
        firstData = line
        break
      }
    }
    if (!firstData) {
      return { ok: false, error: 'No recordings found for this number' }
    }

    const parts = firstData.split('|')
    // Standard recording_lookup column order (Vicidial 2.14):
    //   0: recording_id
    //   1: location  (full filesystem path)
    //   2: start_time
    //   3: filename
    //   4: length_in_sec  (varies)
    //   5: vicidial_id    (varies — sometimes here, sometimes [6])
    //   6: caller_id      (varies)
    // We index defensively — if a column isn't where we expect, we
    // surface null rather than throw.
    const filename = (parts[3] || '').trim() || (parts[1] || '').split('/').pop() || ''
    if (!filename) {
      return { ok: false, error: 'recording_lookup row had no filename' }
    }
    const startTime = (parts[2] || '').trim() || null
    const durationRaw = parts[4] ? Number(parts[4]) : NaN
    const duration = Number.isFinite(durationRaw) ? durationRaw : null
    // vicidial_id and caller_id positions vary across versions —
    // search the row for the first numeric-looking ID after column
    // 3 and treat anything that looks like a phone as the caller.
    let vicidialId: string | null = null
    let callerId: string | null = null
    for (let i = 5; i < parts.length; i++) {
      const p = (parts[i] || '').trim()
      if (!p) continue
      if (!vicidialId && /^\d+$/.test(p) && p.length < 20) {
        vicidialId = p
        continue
      }
      if (!callerId && /^\+?\d{7,15}$/.test(p)) {
        callerId = p
      }
    }

    const recordingLink = buildRecordingUrl(filename)

    return {
      ok: true,
      recordingLink,
      filename,
      startTime,
      callerId,
      durationSec: duration,
      vicidialId,
    }
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : 'Unknown error',
    }
  }
}

/** Convenience: same lookup but also signs the URL so callers can
 *  use it directly in an `<a href>` without round-tripping through
 *  the recording-proxy lib themselves. */
export async function findMostRecentRecordingSigned(opts: {
  phone: string
  hubOrigin: string
}): Promise<
  | (Extract<LookupResult, { ok: true }> & { signedUrl: string | null })
  | { ok: false; error: string }
> {
  const result = await findMostRecentRecording({ phone: opts.phone })
  if (!result.ok) return result
  const signedUrl = signRecordingUrl(result.recordingLink, opts.hubOrigin)
  return { ...result, signedUrl }
}
