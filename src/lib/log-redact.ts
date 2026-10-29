/**
 * Scrub secret-looking substrings from log lines before they leave the
 * server. Bot-facing routes return Render log text; a stray header or
 * token printed by app code must not be relayed to a chat.
 */
const PATTERNS: RegExp[] = [
  /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  /\b(rnd_|ghub_|ghp_|gho_|github_pat_|sk_live_|sk_test_|pk_live_|whsec_|xox[abpr]-|pit-|apik_)[A-Za-z0-9._-]{6,}/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
  /((?:api[_-]?key|token|secret|password|authorization)["']?\s*[:=]\s*["']?)[^\s"',}]{6,}/gi,
]

export function redactSecrets(line: string): string {
  let out = line
  for (const p of PATTERNS) {
    out = out.replace(p, (m, g1: string) =>
      typeof g1 === 'string' && /[:=]\s*["']?$/.test(g1) ? `${g1}[REDACTED]` : '[REDACTED]',
    )
  }
  return out
}
