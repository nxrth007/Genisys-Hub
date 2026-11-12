/**
 * Switches for the GHL sub-account browser worker.
 *
 * Off unless GHL_SUBACCOUNT_WORKER_ENABLED is on/true/1/yes/enabled.
 * Even then the worker fills the form and stops (dry_run) until
 * GHL_SUBACCOUNT_WORKER_MODE=create. A second process can enqueue
 * while this one stays out of Chromium: set GHL_SUBACCOUNT_WORKER_RUN=0.
 * The normal setup is the opposite: this Hub process runs the one browser.
 */

const ON = ['on', 'true', '1', 'yes', 'enabled']
const OFF = ['0', 'false', 'off', 'no', 'disabled']

function token(value: string | undefined): string {
  return (value ?? '').trim().toLowerCase()
}

export function envOn(value: string | undefined): boolean {
  return ON.includes(token(value))
}

export function workerEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return envOn(env.GHL_SUBACCOUNT_WORKER_ENABLED)
}

/** This process launches the browser. Default yes when the worker is enabled. */
export function workerRunsBrowser(env: NodeJS.ProcessEnv = process.env): boolean {
  if (!workerEnabled(env)) return false
  const raw = token(env.GHL_SUBACCOUNT_WORKER_RUN)
  if (!raw) return true
  return !OFF.includes(raw)
}

export type WorkerMode = 'dry_run' | 'create'

/** dry_run fills the GHL form and does not press the final Create. */
export function workerMode(env: NodeJS.ProcessEnv = process.env): WorkerMode {
  return token(env.GHL_SUBACCOUNT_WORKER_MODE) === 'create' ? 'create' : 'dry_run'
}

export function workerHeadless(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = token(env.GHL_SUBACCOUNT_WORKER_HEADLESS)
  if (!raw) return true
  return !OFF.includes(raw)
}

export const MAX_ATTEMPTS = 5

/** 2, 4, 8, 16, 32 minutes, capped at an hour. `attempt` is 1-based. */
export function retryDelayMs(attempt: number): number {
  const minutes = Math.min(60, 2 ** Math.max(1, attempt))
  return minutes * 60_000
}

export const DEFAULT_DASHBOARD_ORIGIN = 'https://app.gohighlevel.com'

export function dashboardOrigin(raw: string | undefined): string {
  try {
    return new URL(raw?.trim() || DEFAULT_DASHBOARD_ORIGIN).origin
  } catch {
    return DEFAULT_DASHBOARD_ORIGIN
  }
}

export function subAccountListUrl(raw: string | undefined): string {
  return `${dashboardOrigin(raw)}/sub-accounts`
}

/** Optional explicit list page. Empty when GHL_SUBACCOUNT_LIST_URL is unset. */
export function listUrlOverride(env: NodeJS.ProcessEnv = process.env): string {
  return env.GHL_SUBACCOUNT_LIST_URL?.trim() || ''
}

/**
 * How long before "now" the cutoff sits the first time the worker is
 * switched on, so the submission that is landing in that moment is
 * included and last month's clients are not.
 */
export const WORKER_SINCE_GRACE_MS = 15 * 60 * 1000

export const VAULT_LOGIN_NAME = 'GHL Agency Dashboard Login'
export const VAULT_WEBHOOK_SECRET_NAME = 'GHL Subaccount Worker Webhook Secret'
export const ONBOARDING_WEBHOOK_SECRET_NAME = 'Client Onboarding Webhook Secret'

export function loginFromEnv(env: NodeJS.ProcessEnv = process.env): { email: string; password: string } | null {
  const email = env.GHL_AGENCY_EMAIL?.trim() ?? ''
  const password = env.GHL_AGENCY_PASSWORD ?? ''
  if (!email || !password.trim()) return null
  return { email, password }
}

/** JSON `{"email","password"}` or two lines (email, then password). */
export function parseAgencyLogin(raw: string | null | undefined): { email: string; password: string } | null {
  if (!raw?.trim()) return null
  const text = raw.trim()
  if (text.startsWith('{')) {
    try {
      const v = JSON.parse(text) as { email?: unknown; password?: unknown }
      if (typeof v.email === 'string' && typeof v.password === 'string' && v.email.includes('@') && v.password) {
        return { email: v.email.trim(), password: v.password }
      }
    } catch {
      return null
    }
    return null
  }
  const lines = text.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
  if (lines.length >= 2 && lines[0].includes('@')) return { email: lines[0], password: lines.slice(1).join('\n') }
  return null
}
