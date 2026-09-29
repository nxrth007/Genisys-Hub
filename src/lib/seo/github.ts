import { requireSecret } from './secrets'

/**
 * GitHub — where every Lovable client site's code lives (nxrth007/*).
 *
 * REST v3 with the fine-grained PAT from the Vault ("GitHub Token"). Reads
 * snapshot a site repo; writes go through the Git Data API so a week's
 * changes land as one atomic commit on a fresh branch, then a PR, then a
 * squash merge pinned to the head that was reviewed.
 *
 * Two rules hold for every write:
 *  - nothing is ever force-pushed. Lovable pushes to `main` too, and a
 *    force would silently erase someone's edits in the Lovable editor.
 *  - only client repos are writable. The same PAT can see the Hub's own
 *    repo, so `assertClientRepo` refuses it (and anything not owned by
 *    nxrth007) before any write leaves the process.
 */

const API = 'https://api.github.com'
const API_VERSION = '2022-11-28'
const USER_AGENT = 'genisys-hub-seo'
const TIMEOUT_MS = 20_000

/** The account that owns every client site repo (Lovable's GitHub connection). */
const CLIENT_OWNER = 'nxrth007'
/** Repos under that owner that are ours, not a client's. Lower-case. */
const INTERNAL_REPOS = new Set(['nxrth007/genisys-hub'])

const COMMIT_IDENTITY = { name: 'Genisys SEO', email: 'seo@leadgenisys.com' }

/** Anything larger goes up as its own blob instead of inline in the tree request. */
const INLINE_CONTENT_MAX = 100_000
/** Rate-limit waits longer than this fail fast instead of stalling a request. */
const MAX_RATE_WAIT_MS = 60_000
const MAX_REPOS = 300

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/**
 * A GitHub API failure, carrying what the UI needs to say something useful:
 * the status, the endpoint, GitHub's own message, and — on a 403/404 from a
 * fine-grained PAT — which permission the token is missing
 * (`X-Accepted-GitHub-Permissions`, e.g. "contents=write").
 */
export class GitHubError extends Error {
  readonly status: number
  readonly method: string
  readonly path: string
  readonly githubMessage: string | null
  readonly acceptedPermissions: string | null

  constructor(o: {
    status: number
    method: string
    path: string
    githubMessage: string | null
    acceptedPermissions?: string | null
    hint?: string | null
  }) {
    const parts = [`GitHub ${o.status || 'request failed'} on ${o.method} ${o.path}`]
    if (o.githubMessage) parts.push(`: ${o.githubMessage}`)
    if (o.acceptedPermissions) parts.push(` (the token needs ${o.acceptedPermissions})`)
    if (o.hint) parts.push(` — ${o.hint}`)
    super(parts.join(''))
    this.name = 'GitHubError'
    this.status = o.status
    this.method = o.method
    this.path = o.path
    this.githubMessage = o.githubMessage
    this.acceptedPermissions = o.acceptedPermissions ?? null
  }
}

// ---------------------------------------------------------------------------
// Token
// ---------------------------------------------------------------------------

let testToken: string | null = null

/**
 * Throwaway test scripts only: use this token instead of the Vault's, so the
 * client can be exercised without a database. Pass null to go back to the
 * Vault. Never called from Hub code.
 */
export function setGitHubTokenForTesting(token: string | null): void {
  testToken = token?.trim() || null
}

async function token(): Promise<string> {
  return testToken ?? requireSecret('github')
}

// ---------------------------------------------------------------------------
// Guards and path helpers
// ---------------------------------------------------------------------------

const REPO_RE = /^([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/([A-Za-z0-9._-]{1,100})$/

function splitRepo(fullName: string): { owner: string; repo: string } {
  const m = REPO_RE.exec(fullName.trim())
  if (!m || m[2] === '.' || m[2] === '..') throw new Error(`"${fullName}" is not a GitHub owner/repo name.`)
  return { owner: m[1], repo: m[2] }
}

function repoPath(fullName: string): string {
  const { owner, repo } = splitRepo(fullName)
  return `/repos/${owner}/${repo}`
}

/** Encode each segment but keep the slashes — for file paths and branch names in URLs. */
function encodeSegments(p: string): string {
  return p.split('/').map(encodeURIComponent).join('/')
}

/** Can the engine write to this repo? Owned by nxrth007 and not one of ours. */
export function isClientRepo(fullName: string): boolean {
  try {
    const { owner } = splitRepo(fullName)
    return owner.toLowerCase() === CLIENT_OWNER && !INTERNAL_REPOS.has(fullName.trim().toLowerCase())
  } catch {
    return false
  }
}

/** Throws unless `fullName` is a client site repo. Every write calls this first. */
export function assertClientRepo(fullName: string): void {
  if (!isClientRepo(fullName)) {
    throw new Error(
      `Refusing to write to ${fullName}: the SEO engine only writes to client site repos owned by ${CLIENT_OWNER}, never the Hub's own.`,
    )
  }
}

/**
 * Git's ref-name rules (git check-ref-format), enough to reject anything
 * GitHub would 422 on — and anything that could address a different ref.
 */
function assertBranchName(name: string): void {
  const bad =
    !name ||
    name.length > 200 ||
    name === 'HEAD' ||
    name === '@' ||
    name.startsWith('/') ||
    name.endsWith('/') ||
    name.endsWith('.') ||
    name.endsWith('.lock') ||
    name.includes('..') ||
    name.includes('//') ||
    name.includes('@{') ||
    name.split('/').some((seg) => seg.startsWith('.') || seg.endsWith('.lock')) ||
    /[\x00-\x20\x7f~^:?*[\\]/.test(name)
  if (bad) throw new Error(`"${name}" is not a valid branch name.`)
}

/** Repo-relative file path we are willing to write: no absolute paths, no traversal, nothing in .git. */
function assertWritablePath(p: string): void {
  const segs = p.split('/')
  const bad =
    !p ||
    p.length > 400 ||
    p.startsWith('/') ||
    p.includes('\\') ||
    segs.some((s) => s === '' || s === '.' || s === '..') ||
    segs[0].toLowerCase() === '.git' ||
    /[\x00-\x1f\x7f]/.test(p)
  if (bad) throw new Error(`"${p}" is not a writable repo path.`)
}

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

type Method = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE'

type Req = { method?: Method; body?: unknown; accept?: string }
type Res<T> = { status: number; data: T; headers: Headers }

type ErrorBody = {
  message?: unknown
  errors?: unknown
}

function toUrl(pathOrUrl: string): URL {
  const url = new URL(pathOrUrl, API)
  // Pagination links come back absolute; never let one send the token elsewhere.
  if (url.origin !== API) throw new Error(`Refusing to send the GitHub token to ${url.origin}.`)
  return url
}

function githubMessage(body: string): string | null {
  if (!body) return null
  try {
    const j = JSON.parse(body) as ErrorBody
    const parts: string[] = []
    if (typeof j.message === 'string' && j.message.trim()) parts.push(j.message.trim())
    // 422s explain themselves in `errors`: [{ resource, field, code, message }] or plain strings.
    if (Array.isArray(j.errors)) {
      for (const e of j.errors.slice(0, 5)) {
        if (typeof e === 'string') parts.push(e)
        else if (e && typeof e === 'object') {
          const o = e as Record<string, unknown>
          const text = typeof o.message === 'string' ? o.message : [o.resource, o.field, o.code].filter((v) => typeof v === 'string').join(' ')
          if (text) parts.push(text)
        }
      }
    }
    return parts.length ? parts.join('; ') : null
  } catch {
    return body.slice(0, 300)
  }
}

function hintFor(status: number): string | null {
  if (status === 401) return 'the GitHub token is invalid or expired; replace it in /vault'
  // Fine-grained PATs answer 404, not 403, for repos outside their selection.
  if (status === 404) return "not found, or the token can't see this repo"
  return null
}

/** How long to wait before retrying a rate-limited response, or null if it isn't one. */
function rateLimitWait(res: Response, body: string): number | null {
  const retryAfter = Number(res.headers.get('retry-after'))
  if (Number.isFinite(retryAfter) && retryAfter > 0) return retryAfter * 1000
  if (res.headers.get('x-ratelimit-remaining') === '0') {
    const reset = Number(res.headers.get('x-ratelimit-reset')) * 1000
    return Number.isFinite(reset) && reset > 0 ? Math.max(reset - Date.now(), 0) + 1000 : 60_000
  }
  // Secondary limits sometimes arrive as a bare 403 with only the message to go on.
  if (/secondary rate limit|abuse detection/i.test(body)) return 60_000
  return null
}

async function request<T>(pathOrUrl: string, req: Req = {}): Promise<Res<T>> {
  const method = req.method ?? 'GET'
  const url = toUrl(pathOrUrl)
  const path = url.pathname
  const auth = await token()

  for (let attempt = 0; ; attempt++) {
    let res: Response
    let text: string
    try {
      res = await fetch(url, {
        method,
        headers: {
          Authorization: `Bearer ${auth}`,
          Accept: req.accept ?? 'application/vnd.github+json',
          'X-GitHub-Api-Version': API_VERSION,
          'User-Agent': USER_AGENT,
          ...(req.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        body: req.body !== undefined ? JSON.stringify(req.body) : undefined,
        cache: 'no-store',
        signal: AbortSignal.timeout(TIMEOUT_MS),
      })
      text = await res.text()
    } catch (err) {
      // A GET is safe to repeat once; a write may already have happened.
      if (method === 'GET' && attempt === 0) {
        await sleep(1000)
        continue
      }
      const timedOut = err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')
      throw new GitHubError({
        status: 0,
        method,
        path,
        githubMessage: timedOut ? `timed out after ${TIMEOUT_MS / 1000}s` : `network error (${err instanceof Error ? err.message : String(err)})`,
      })
    }

    if ((res.status === 403 || res.status === 429) && attempt < 2) {
      const wait = rateLimitWait(res, text)
      if (wait !== null && wait <= MAX_RATE_WAIT_MS) {
        await sleep(wait)
        continue
      }
    }
    if (res.status >= 500 && method === 'GET' && attempt === 0) {
      await sleep(1500)
      continue
    }

    if (!res.ok) {
      throw new GitHubError({
        status: res.status,
        method,
        path,
        githubMessage: githubMessage(text),
        acceptedPermissions: res.headers.get('x-accepted-github-permissions'),
        hint: hintFor(res.status),
      })
    }

    let data: unknown = undefined
    if (text) {
      try {
        data = JSON.parse(text)
      } catch {
        throw new GitHubError({ status: res.status, method, path, githubMessage: 'response was not JSON' })
      }
    }
    return { status: res.status, data: data as T, headers: res.headers }
  }
}

async function get<T>(pathOrUrl: string, accept?: string): Promise<T> {
  return (await request<T>(pathOrUrl, { accept })).data
}

function isStatus(err: unknown, ...statuses: number[]): err is GitHubError {
  return err instanceof GitHubError && statuses.includes(err.status)
}

function decodeBase64(content: string): string {
  // GitHub wraps base64 at 60 columns; Buffer ignores the newlines.
  return Buffer.from(content, 'base64').toString('utf8')
}

function nextLink(link: string | null): string | null {
  if (!link) return null
  for (const part of link.split(',')) {
    const m = /<([^>]+)>\s*;\s*rel="([^"]+)"/.exec(part)
    if (m && m[2].split(/\s+/).includes('next')) return m[1]
  }
  return null
}

// ---------------------------------------------------------------------------
// Raw GitHub shapes (only the fields read here)
// ---------------------------------------------------------------------------

type RawRepo = {
  full_name: string
  private: boolean
  default_branch: string
  pushed_at: string | null
  html_url: string
}

type RawGitActor = { name?: string | null; email?: string | null; date?: string | null } | null
type RawUser = { login?: string | null } | null

type RawCommit = {
  sha: string
  author: RawUser
  committer: RawUser
  commit: {
    message: string
    tree: { sha: string }
    author: RawGitActor
    committer: RawGitActor
  }
}

type RawPull = {
  number: number
  state: 'open' | 'closed'
  merged?: boolean
  merged_at?: string | null
  /** Once merged: the commit that landed on the base branch. Before that, a throwaway test merge. */
  merge_commit_sha?: string | null
  mergeable: boolean | null
  html_url: string
  head: { sha: string; ref: string }
  base: { ref: string }
}

type RawCompare = {
  status: 'ahead' | 'behind' | 'identical' | 'diverged'
  ahead_by: number
  behind_by: number
  files?: { filename: string }[]
}

function shapeRepo(r: RawRepo) {
  return {
    fullName: r.full_name,
    private: r.private,
    defaultBranch: r.default_branch,
    pushedAt: r.pushed_at ?? null,
    htmlUrl: r.html_url,
  }
}

function commitAuthor(c: RawCommit): string {
  return c.author?.login || c.commit.author?.name || c.committer?.login || c.commit.committer?.name || 'unknown'
}

function commitDate(c: RawCommit): string {
  // Committer date moves with rebases and merges — the better "when did this land".
  return c.commit.committer?.date || c.commit.author?.date || ''
}

// Lovable commits as gpt-engineer-app[bot] / lovable-dev[bot] and tags each
// edit with an X-Lovable-Edit-ID trailer; any of those marks a Lovable edit.
const LOVABLE_RE = /lovable|gpt-engineer/i

function isLovableCommit(c: RawCommit): boolean {
  const who = [c.author?.login, c.commit.author?.name, c.committer?.login, c.commit.committer?.name]
  return who.some((v) => !!v && LOVABLE_RE.test(v)) || /X-Lovable-Edit-ID/i.test(c.commit.message)
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/** Who the token belongs to — doubles as a validity check for the setup screen. */
export async function githubViewer(): Promise<{ login: string }> {
  const u = await get<{ login: string }>('/user')
  return { login: u.login }
}

/** Repos the token's user owns, most recently pushed first (capped at 300). */
export async function listOwnedRepos(): Promise<
  { fullName: string; private: boolean; defaultBranch: string; pushedAt: string | null; htmlUrl: string }[]
> {
  const out: ReturnType<typeof shapeRepo>[] = []
  let next: string | null = '/user/repos?affiliation=owner&per_page=100&sort=pushed'
  while (next && out.length < MAX_REPOS) {
    const res: Res<RawRepo[]> = await request<RawRepo[]>(next)
    out.push(...(res.data ?? []).map(shapeRepo))
    next = nextLink(res.headers.get('link'))
  }
  return out.slice(0, MAX_REPOS)
}

export async function getRepo(
  fullName: string,
): Promise<{ fullName: string; defaultBranch: string; private: boolean; htmlUrl: string; pushedAt: string | null }> {
  const r = shapeRepo(await get<RawRepo>(repoPath(fullName)))
  return { fullName: r.fullName, defaultBranch: r.defaultBranch, private: r.private, htmlUrl: r.htmlUrl, pushedAt: r.pushedAt }
}

/** Head commit of a branch plus its tree, in one call. */
export async function getBranchHead(
  fullName: string,
  branch: string,
): Promise<{ sha: string; treeSha: string; date: string; author: string; message: string }> {
  const b = await get<{ commit: RawCommit }>(`${repoPath(fullName)}/branches/${encodeSegments(branch)}`)
  return {
    sha: b.commit.sha,
    treeSha: b.commit.commit.tree.sha,
    date: commitDate(b.commit),
    author: commitAuthor(b.commit),
    message: b.commit.commit.message,
  }
}

/** A commit's sha and tree, by full sha (Git Data API). */
async function getCommitTree(fullName: string, sha: string): Promise<{ sha: string; treeSha: string }> {
  assertObjectId(sha)
  const c = await get<{ sha: string; tree: { sha: string } }>(`${repoPath(fullName)}/git/commits/${sha}`)
  return { sha: c.sha, treeSha: c.tree.sha }
}

/**
 * Every file and folder at `ref` (a tree sha, commit sha or branch name).
 * `truncated` means GitHub stopped at its 100k-entry / 7 MB limit — not a
 * concern for Lovable sites, but reported rather than hidden. Submodule
 * entries are dropped.
 */
export async function getTree(
  fullName: string,
  ref: string,
): Promise<{ entries: { path: string; type: 'blob' | 'tree'; size: number | null; sha: string }[]; truncated: boolean }> {
  const t = await get<{
    tree: { path: string; type: string; size?: number; sha: string }[]
    truncated: boolean
  }>(`${repoPath(fullName)}/git/trees/${encodeSegments(ref)}?recursive=1`)
  const entries = (t.tree ?? [])
    .filter((e) => e.type === 'blob' || e.type === 'tree')
    .map((e) => ({
      path: e.path,
      type: e.type as 'blob' | 'tree',
      size: typeof e.size === 'number' ? e.size : null,
      sha: e.sha,
    }))
  return { entries, truncated: !!t.truncated }
}

/** A full SHA-1 or SHA-256 object id — safe to put straight into a URL. */
function assertObjectId(sha: string): void {
  if (!/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i.test(sha)) throw new Error(`"${sha}" is not a git object id.`)
}

/** A blob's text by sha (up to GitHub's 100 MB blob limit). */
export async function readBlob(fullName: string, sha: string): Promise<string> {
  assertObjectId(sha)
  const b = await get<{ content: string; encoding: string }>(`${repoPath(fullName)}/git/blobs/${sha}`)
  return b.encoding === 'base64' ? decodeBase64(b.content) : b.content
}

/**
 * A file's text at `ref`, or null when there is no file at that path.
 *
 * Asks for the `object` media type: the default one answers 403 for files
 * over 1 MB, while `object` returns the metadata with empty content, and
 * the blob API fills the gap.
 */
export async function readFile(fullName: string, path: string, ref: string): Promise<string | null> {
  const clean = path.replace(/^\/+/, '')
  let f: { type?: string; encoding?: string; content?: string; sha?: string; size?: number }
  try {
    f = await get(
      `${repoPath(fullName)}/contents/${encodeSegments(clean)}?ref=${encodeURIComponent(ref)}`,
      'application/vnd.github.object+json',
    )
  } catch (err) {
    if (isStatus(err, 404)) return null
    throw err
  }
  // Directories, symlinks and submodules are not files.
  if (f.type !== 'file') return null
  if (f.encoding === 'base64' && typeof f.content === 'string' && (f.content || !f.size)) return decodeBase64(f.content)
  if (!f.sha) return null
  return readBlob(fullName, f.sha)
}

/** Exact match on refs/heads/<branch> (the singular ref endpoint never prefix-matches). */
export async function branchExists(fullName: string, branch: string): Promise<boolean> {
  try {
    await get(`${repoPath(fullName)}/git/ref/heads/${encodeSegments(branch)}`)
    return true
  } catch (err) {
    if (isStatus(err, 404)) return false
    throw err
  }
}

/** The latest `n` commits reachable from `branch` (a branch name or sha), newest first. Max 100. */
export async function recentCommits(
  fullName: string,
  branch: string,
  n: number,
): Promise<{ sha: string; author: string; date: string; message: string; byLovable: boolean }[]> {
  const perPage = Math.min(Math.max(Math.floor(n) || 1, 1), 100)
  let list: RawCommit[]
  try {
    list = await get<RawCommit[]>(
      `${repoPath(fullName)}/commits?sha=${encodeURIComponent(branch)}&per_page=${perPage}`,
    )
  } catch (err) {
    // 409 = the repository has no commits yet.
    if (isStatus(err, 409)) return []
    throw err
  }
  return (list ?? []).slice(0, perPage).map((c) => ({
    sha: c.sha,
    author: commitAuthor(c),
    date: commitDate(c),
    message: c.commit.message,
    byLovable: isLovableCommit(c),
  }))
}

/**
 * GitHub Actions runs for a commit — the build gate. Fine-grained PATs
 * cannot read the Checks API, so this is the only way to see CI results.
 */
export async function workflowRunsForSha(
  fullName: string,
  sha: string,
): Promise<{ name: string; status: string; conclusion: string | null; url: string }[]> {
  const r = await get<{
    workflow_runs?: {
      name?: string | null
      display_title?: string | null
      path?: string | null
      status: string
      conclusion: string | null
      html_url: string
    }[]
  }>(`${repoPath(fullName)}/actions/runs?head_sha=${encodeURIComponent(sha)}&per_page=100`)
  return (r.workflow_runs ?? []).map((w) => ({
    name: w.name || w.display_title || w.path || 'workflow',
    status: w.status,
    conclusion: w.conclusion ?? null,
    url: w.html_url,
  }))
}

/**
 * How `head` relates to `base` (commit shas, short shas or branch names).
 * `ahead` means base is an ancestor of head, `identical` the same commit.
 * `files` are the paths changed between them — GitHub lists at most 300.
 * Throws GitHubError 404 when either side isn't in the repo.
 */
export async function compareCommits(
  fullName: string,
  base: string,
  head: string,
): Promise<{ status: 'ahead' | 'behind' | 'identical' | 'diverged'; aheadBy: number; behindBy: number; files: string[] }> {
  for (const ref of [base, head]) {
    // ".." would change how GitHub splits "base...head".
    if (!ref || ref.includes('..') || /[\x00-\x20\x7f]/.test(ref)) throw new Error(`"${ref}" is not a commit or branch to compare.`)
  }
  // per_page=1 trims the commit list; status, counts and files still cover the whole range.
  const c = await get<RawCompare>(`${repoPath(fullName)}/compare/${encodeSegments(base)}...${encodeSegments(head)}?per_page=1`)
  return {
    status: c.status,
    aheadBy: c.ahead_by,
    behindBy: c.behind_by,
    files: (c.files ?? []).slice(0, 300).map((f) => f.filename),
  }
}

// ---------------------------------------------------------------------------
// Writes — all guarded by assertClientRepo
// ---------------------------------------------------------------------------

/**
 * Atomic multi-file commit on a NEW branch cut from the base branch's head,
 * via the Git Data API: tree on top of the base tree → commit → create ref.
 *
 * With `baseSha`, the branch is cut from that commit instead of the head —
 * for whole-file rewrites made from an older snapshot, so the PR's merge
 * base is what was read and later edits on the base branch merge (or
 * conflict) rather than being silently reverted.
 *
 * Creates or overwrites files only — nothing is ever deleted. Throws
 * GitHubError 422 if the branch already exists (never moves an existing
 * ref). When every file already matches the base, nothing is created and
 * `unchanged` is true (commitSha === baseSha, no branch).
 */
export async function commitToNewBranch(o: {
  fullName: string
  baseBranch: string
  /** Full commit sha to branch from; the base branch's head when omitted. */
  baseSha?: string
  branch: string
  files: { path: string; content: string }[]
  message: string
}): Promise<{ commitSha: string; baseSha: string; unchanged: boolean }> {
  assertClientRepo(o.fullName)
  assertBranchName(o.branch)
  if (o.baseSha) assertObjectId(o.baseSha)
  if (o.branch === o.baseBranch) throw new Error('commitToNewBranch needs a new branch, not the base branch.')
  if (!o.message.trim()) throw new Error('A commit message is required.')
  if (o.files.length === 0) throw new Error('No files to commit.')
  const seen = new Set<string>()
  for (const f of o.files) {
    assertWritablePath(f.path)
    if (typeof f.content !== 'string') throw new Error(`${f.path}: content must be text.`)
    if (seen.has(f.path)) throw new Error(`${f.path} appears twice in one commit.`)
    seen.add(f.path)
  }

  const R = repoPath(o.fullName)
  const refPath = `${R}/git/refs`
  if (await branchExists(o.fullName, o.branch)) {
    throw new GitHubError({
      status: 422,
      method: 'POST',
      path: refPath,
      githubMessage: `Branch ${o.branch} already exists`,
    })
  }

  const base = o.baseSha ? await getCommitTree(o.fullName, o.baseSha) : await getBranchHead(o.fullName, o.baseBranch)

  // Text goes inline in the tree request (GitHub writes the blob), which
  // saves a request per file; only very large files get their own blob.
  const tree: { path: string; mode: '100644'; type: 'blob'; content?: string; sha?: string }[] = []
  for (const f of o.files) {
    if (f.content.length > INLINE_CONTENT_MAX) {
      const blob = await request<{ sha: string }>(`${R}/git/blobs`, {
        method: 'POST',
        body: { content: Buffer.from(f.content, 'utf8').toString('base64'), encoding: 'base64' },
      })
      tree.push({ path: f.path, mode: '100644', type: 'blob', sha: blob.data.sha })
    } else {
      tree.push({ path: f.path, mode: '100644', type: 'blob', content: f.content })
    }
  }

  const newTree = await request<{ sha: string }>(`${R}/git/trees`, {
    method: 'POST',
    body: { base_tree: base.treeSha, tree },
  })
  if (newTree.data.sha === base.treeSha) return { commitSha: base.sha, baseSha: base.sha, unchanged: true }

  const who = { ...COMMIT_IDENTITY, date: new Date().toISOString() }
  const commit = await request<{ sha: string }>(`${R}/git/commits`, {
    method: 'POST',
    body: { message: o.message, tree: newTree.data.sha, parents: [base.sha], author: who, committer: who },
  })

  // Creating a ref never overwrites: GitHub answers 422 if it appeared since the check above.
  await request(refPath, {
    method: 'POST',
    body: { ref: `refs/heads/${o.branch}`, sha: commit.data.sha },
  })
  return { commitSha: commit.data.sha, baseSha: base.sha, unchanged: false }
}

/**
 * Open a PR from `head` into `base`. If one is already open for that pair
 * (a retried run), that PR is returned instead of failing.
 */
export async function openPullRequest(o: {
  fullName: string
  head: string
  base: string
  title: string
  body: string
}): Promise<{ number: number; url: string }> {
  assertClientRepo(o.fullName)
  const R = repoPath(o.fullName)
  try {
    const pr = await request<RawPull>(`${R}/pulls`, {
      method: 'POST',
      body: { title: o.title, head: o.head, base: o.base, body: o.body },
    })
    return { number: pr.data.number, url: pr.data.html_url }
  } catch (err) {
    if (!isStatus(err, 422) || !/already exists/i.test(err.githubMessage ?? '')) throw err
    const { owner } = splitRepo(o.fullName)
    const open = await get<RawPull[]>(
      `${R}/pulls?state=open&head=${encodeURIComponent(`${owner}:${o.head}`)}&base=${encodeURIComponent(o.base)}`,
    )
    const existing = open?.[0]
    if (!existing) throw err
    return { number: existing.number, url: existing.html_url }
  }
}

export async function getPullRequest(
  fullName: string,
  n: number,
): Promise<{
  state: 'open' | 'closed'
  merged: boolean
  mergeable: boolean | null
  headSha: string
  url: string
  /** The commit the merge put on the base branch (squash, merge or last rebased commit); null until merged. */
  mergeCommitSha: string | null
  baseRef: string
}> {
  const pr = await get<RawPull>(`${repoPath(fullName)}/pulls/${Math.floor(n)}`)
  const merged = pr.merged ?? !!pr.merged_at
  return {
    state: pr.state,
    merged,
    // null = GitHub is still computing mergeability; ask again shortly.
    mergeable: pr.mergeable ?? null,
    headSha: pr.head.sha,
    url: pr.html_url,
    // On an open PR this is GitHub's test merge, which never lands anywhere.
    mergeCommitSha: merged ? (pr.merge_commit_sha ?? null) : null,
    baseRef: pr.base.ref,
  }
}

/**
 * Squash-merge, pinned to `headSha`: GitHub answers 409 if anything was
 * pushed to the PR after it was reviewed, and 405 if it can't merge.
 * Returns the merge commit's sha.
 */
export async function mergePullRequest(fullName: string, n: number, headSha: string, title: string): Promise<{ sha: string }> {
  assertClientRepo(fullName)
  const res = await request<{ sha?: string; merged?: boolean; message?: string }>(
    `${repoPath(fullName)}/pulls/${Math.floor(n)}/merge`,
    { method: 'PUT', body: { sha: headSha, merge_method: 'squash', commit_title: title } },
  )
  if (!res.data?.merged || !res.data.sha) {
    throw new GitHubError({
      status: res.status,
      method: 'PUT',
      path: `${repoPath(fullName)}/pulls/${Math.floor(n)}/merge`,
      githubMessage: res.data?.message ?? 'merge did not complete',
    })
  }
  return { sha: res.data.sha }
}

/** Close without merging, optionally leaving a comment saying why (best-effort). */
export async function closePullRequest(fullName: string, n: number, comment?: string): Promise<void> {
  assertClientRepo(fullName)
  const R = repoPath(fullName)
  const num = Math.floor(n)
  if (comment?.trim()) {
    try {
      await request(`${R}/issues/${num}/comments`, { method: 'POST', body: { body: comment } })
    } catch {
      // The comment is a courtesy; closing is what matters.
    }
  }
  await request(`${R}/pulls/${num}`, { method: 'PATCH', body: { state: 'closed' } })
}

/**
 * Delete a branch the engine made. Already-gone (404/422) is fine. Refuses
 * main/master and Lovable's sync branches — `lovable-sync*` can hold the
 * only copy of edits Lovable couldn't push to main.
 */
export async function deleteBranch(fullName: string, branch: string): Promise<void> {
  assertClientRepo(fullName)
  assertBranchName(branch)
  if (/^(main|master)$/i.test(branch) || /^lovable/i.test(branch)) {
    throw new Error(`Refusing to delete ${branch} on ${fullName}.`)
  }
  try {
    await request(`${repoPath(fullName)}/git/refs/heads/${encodeSegments(branch)}`, { method: 'DELETE' })
  } catch (err) {
    if (isStatus(err, 404, 422)) return
    throw err
  }
}
