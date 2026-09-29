import { getSecret } from './secrets'

/**
 * Lovable — publishes client sites after the engine's commit reaches `main`.
 *
 * REST API (GA 2026-09-17): https://api.lovable.dev/v1, version pinned with
 * `Lovable-Version`. API keys (lov_…) need a Business plan, so this is
 * optional: with no key in the Vault, `lovableConfigured()` is false and
 * the engine stops at "awaiting publish" for a person to click Publish.
 *
 * The key goes in `Lovable-API-Key`. The OpenAPI spec lists
 * `Authorization: Bearer` too, but documents that scheme for session and
 * OAuth tokens; the API-key header is the one the docs promise for lov_ keys.
 *
 * Publishing takes the project's latest state — it cannot pin a commit — so
 * callers should wait until `getLovableProject().latestCommitSha` is the
 * merge commit before publishing.
 */

const BASE = 'https://api.lovable.dev/v1'
const API_VERSION = '2026-09-11'
const USER_AGENT = 'genisys-hub-seo'
const TIMEOUT_MS = 20_000
const MAX_RETRY_WAIT_MS = 30_000

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/**
 * A Lovable API failure. `type` is Lovable's stable error token
 * (payment_required, insufficient_scope, project_not_found,
 * security_critical_findings, …) or 'not_configured' when there is no key.
 */
export class LovableError extends Error {
  readonly status: number
  readonly type: string | null
  readonly requestId: string | null

  constructor(message: string, o: { status: number; type: string | null; requestId?: string | null }) {
    super(message)
    this.name = 'LovableError'
    this.status = o.status
    this.type = o.type
    this.requestId = o.requestId ?? null
  }
}

let testKey: string | null = null

/** Throwaway test scripts only: use this key instead of the Vault's. Pass null to go back. */
export function setLovableKeyForTesting(key: string | null): void {
  testKey = key?.trim() || null
}

async function apiKey(): Promise<string | null> {
  return testKey ?? (await getSecret('lovable'))
}

/** Is a Lovable API key in the Vault? Never throws — publishing is optional. */
export async function lovableConfigured(): Promise<boolean> {
  try {
    return !!(await apiKey())
  } catch {
    return false
  }
}

/**
 * The project id from whatever a person pastes: the bare id, the editor URL
 * (lovable.dev/projects/<id>) or a preview URL (id-preview--<uuid>.lovable.app).
 * Null when nothing id-shaped is in there.
 */
export function parseLovableProjectId(input: string | null | undefined): string | null {
  const s = input?.trim()
  if (!s) return null
  const fromEditor = /lovable\.dev\/projects\/([A-Za-z0-9_-]+)/i.exec(s)?.[1]
  const fromPreview = /(?:^|\/\/|\.)(?:id-)?preview--([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i.exec(s)?.[1]
  const id = fromEditor ?? fromPreview ?? s
  return /^[A-Za-z0-9_-]{6,100}$/.test(id) ? id : null
}

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

type Method = 'GET' | 'POST'

type ErrorEnvelope = {
  type?: unknown
  title?: unknown
  detail?: unknown
  request_id?: unknown
  errors?: unknown
  props?: unknown
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null)
const bool = (v: unknown): boolean | null => (typeof v === 'boolean' ? v : null)

function projectPath(projectId: string): string {
  const id = parseLovableProjectId(projectId)
  if (!id) throw new LovableError(`"${projectId}" is not a Lovable project id.`, { status: 0, type: 'invalid_project_id' })
  return `/projects/${encodeURIComponent(id)}`
}

/** Turn Lovable's error envelope into one sentence a person can act on. */
function describeError(status: number, body: string): LovableError {
  let env: ErrorEnvelope = {}
  try {
    env = JSON.parse(body) as ErrorEnvelope
  } catch {
    // Not the documented envelope (a proxy error page, say) — fall through with the status alone.
  }
  const type = str(env.type)
  const requestId = str(env.request_id)
  const props = env.props && typeof env.props === 'object' ? (env.props as Record<string, unknown>) : {}

  const parts: string[] = [str(env.detail) ?? str(env.title) ?? `HTTP ${status}`]
  if (Array.isArray(env.errors)) {
    for (const e of env.errors.slice(0, 5)) {
      const o = (e ?? {}) as Record<string, unknown>
      const msg = str(o.message)
      const loc = str(o.location)
      if (msg) parts.push(loc ? `${loc}: ${msg}` : msg)
    }
  }

  let hint: string | null = null
  if (status === 401) hint = 'the Lovable API key is invalid or revoked; replace it in /vault'
  else if (type === 'payment_required' || status === 402)
    hint = `the Lovable API needs a ${str(props.required_plan) ?? 'Business'} plan`
  else if (type === 'insufficient_scope')
    hint = `the key needs scope ${Array.isArray(props.required_scopes) ? props.required_scopes.join(' or ') : 'projects:write'}`
  else if (type === 'security_critical_findings')
    hint = 'Lovable blocks publishing until its security findings are fixed in the editor'
  else if (status === 404) hint = "project not found, or it isn't in this key's workspace"
  else if (status === 429) hint = 'rate limited by Lovable; try again shortly'

  const msg = `Lovable ${status}${type ? ` ${type}` : ''}: ${parts.join('; ')}${hint ? ` — ${hint}` : ''}${requestId ? ` (request ${requestId})` : ''}`
  return new LovableError(msg, { status, type, requestId })
}

async function request(method: Method, path: string, body?: unknown): Promise<unknown> {
  const key = await apiKey()
  if (!key) {
    throw new LovableError('Lovable API key is not configured. Add a Vault entry named "Lovable API Key" (needs a Business plan).', {
      status: 0,
      type: 'not_configured',
    })
  }

  for (let attempt = 0; ; attempt++) {
    let res: Response
    let text: string
    try {
      res = await fetch(`${BASE}${path}`, {
        method,
        headers: {
          'Lovable-API-Key': key,
          'Lovable-Version': API_VERSION,
          Accept: 'application/json',
          'User-Agent': USER_AGENT,
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        cache: 'no-store',
        signal: AbortSignal.timeout(TIMEOUT_MS),
      })
      text = await res.text()
    } catch (err) {
      // Reads repeat safely; a publish POST may already have started a deployment.
      if (method === 'GET' && attempt === 0) {
        await sleep(1000)
        continue
      }
      const timedOut = err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')
      throw new LovableError(
        `Lovable ${method} ${path} ${timedOut ? `timed out after ${TIMEOUT_MS / 1000}s` : `failed (${err instanceof Error ? err.message : String(err)})`}`,
        { status: 0, type: timedOut ? 'timeout' : 'network' },
      )
    }

    if (method === 'GET' && attempt < 2) {
      if (res.status === 429) {
        const wait = Number(res.headers.get('retry-after')) * 1000
        if (Number.isFinite(wait) && wait > 0 && wait <= MAX_RETRY_WAIT_MS) {
          await sleep(wait)
          continue
        }
      } else if (res.status >= 500 && attempt === 0) {
        await sleep(1500)
        continue
      }
    }

    if (!res.ok) throw describeError(res.status, text)
    if (!text) return null
    try {
      return JSON.parse(text) as unknown
    } catch {
      throw new LovableError(`Lovable ${method} ${path} returned something other than JSON.`, { status: res.status, type: 'bad_response' })
    }
  }
}

// ---------------------------------------------------------------------------
// Endpoints
// ---------------------------------------------------------------------------

/**
 * `GET /projects/{id}`. `latestCommitSha` is what Lovable has pulled from
 * GitHub — publish only once it equals the merge commit.
 */
export async function getLovableProject(projectId: string): Promise<{
  latestCommitSha: string | null
  lastEditedAt: string | null
  isPublished: boolean | null
  previewUrl: string | null
  raw: unknown
}> {
  const raw = await request('GET', projectPath(projectId))
  const p = (raw ?? {}) as Record<string, unknown>
  return {
    latestCommitSha: str(p.latest_commit_sha),
    lastEditedAt: str(p.last_edited_at),
    isPublished: bool(p.is_published),
    previewUrl: str(p.preview_url),
    raw,
  }
}

/**
 * `POST /projects/{id}/publish` → 202 with a running deployment. Not
 * retried: a repeated POST would start a second deployment.
 */
export async function publishLovableProject(projectId: string): Promise<{ deploymentId: string }> {
  // The body is required but every field is optional; {} keeps the current audience and URL.
  const raw = await request('POST', `${projectPath(projectId)}/publish`, {})
  const id = str((raw as Record<string, unknown> | null)?.id)
  if (!id) throw new LovableError('Lovable accepted the publish but returned no deployment id.', { status: 202, type: 'bad_response' })
  return { deploymentId: id }
}

/**
 * `GET /projects/{id}/publish/{deploymentId}` — poll no more than every 2s.
 *
 * `done` is true once the deployment completed (url set) or failed. On
 * failure `errorClass` is Lovable's class (transient | code | configuration
 * | data | integration | policy | internal), or 'unclassified' when Lovable
 * gave none, so `done && errorClass` always means failed. Status `unknown`
 * is not done: keep polling with a bounded timeout.
 */
export async function getLovableDeployment(
  projectId: string,
  deploymentId: string,
): Promise<{
  done: boolean
  url: string | null
  errorClass: string | null
  raw: unknown
  /** running | completed | error | unknown (or a newer value). */
  status: string
  errorMessage: string | null
}> {
  if (!/^[A-Za-z0-9_-]{1,200}$/.test(deploymentId)) {
    throw new LovableError(`"${deploymentId}" is not a Lovable deployment id.`, { status: 0, type: 'invalid_deployment_id' })
  }
  const raw = await request('GET', `${projectPath(projectId)}/publish/${encodeURIComponent(deploymentId)}`)
  const d = (raw ?? {}) as Record<string, unknown>
  const status = str(d.status) ?? 'unknown'
  const failed = status === 'error'
  return {
    done: status === 'completed' || failed,
    url: str(d.url),
    errorClass: failed ? (str(d.error_class) ?? 'unclassified') : null,
    raw,
    status,
    errorMessage: str(d.error_message),
  }
}
