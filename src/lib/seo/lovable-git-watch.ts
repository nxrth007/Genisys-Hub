import { prisma } from '@/lib/prisma'
import { assignClientRepo } from './actions'
import { compareCommits, GitHubError, isClientRepo, listOwnedRepos } from './github'
import { LovableMcpError, lovableMcpCall, lovableMcpGetProject, lovableMcpStatus } from './lovable-mcp'
import { seoAlert } from './slack'

/**
 * Lovable → GitHub watch.
 *
 * Lovable can only link a project to GitHub from its own settings screen
 * (Project settings → Git → GitHub → Connect); neither its API nor its MCP
 * server can do it. So once a day the Hub lists the Lovable projects that
 * appeared since the watch started, and:
 *
 *   - flags each one that has no GitHub repo yet (Slack + the Clients page),
 *     with a link straight to the project;
 *   - once it's connected, finds the repo Lovable created on nxrth007 — the
 *     repo that holds the project's latest commit, created after the
 *     project — and links it to the matching client, as the Repo column
 *     would.
 *
 * Projects that already existed when the watch first ran are ignored.
 */

const STATE_KEY = 'seo.lovable.gitWatch'
/** Daily, at 9 AM Eastern (13:00 UTC), so the Slack note lands in the morning. */
const RUN_HOUR_UTC = 13
const MAX_PAGES = 40
const PAGE_SIZE = 100
/** Lovable creates the repo when the project is connected, so after the project — give clocks some slack. */
const REPO_SLACK_MS = 2 * 3_600_000
/** Without a creation time from Lovable, look this far before the Hub first saw the project. */
const UNKNOWN_CREATED_LOOKBACK_MS = 26 * 3_600_000
/** Keep trying to match a connected project to a client this long (the client may onboard later). */
const ATTACH_RETRY_MS = 21 * 86_400_000

export type WatchedProject = {
  id: string
  name: string
  url: string
  createdAt: string | null
  firstSeenAt: string
  status: 'needs_github' | 'connected' | 'dismissed'
  repoFullName: string | null
  connectedAt: string | null
  /** attached: linked to clientName. suggest: connected, no single client matched. blocked: matched, but see note. */
  attach: 'attached' | 'suggest' | 'blocked' | null
  clientId: string | null
  clientName: string | null
  note: string | null
}

type State = {
  /** When the baseline was taken; null until a first run gets through. */
  startedAt: string | null
  baseline: string[]
  projects: WatchedProject[]
  lastRunAt: string | null
  /** The last scheduled (Slack) run, so a manual check doesn't skip the day's digest. */
  lastDailyAt: string | null
  lastError: string | null
}

const EMPTY: State = { startedAt: null, baseline: [], projects: [], lastRunAt: null, lastDailyAt: null, lastError: null }

export type GitWatchView = {
  connected: boolean
  startedAt: string | null
  lastRunAt: string | null
  lastError: string | null
  baselineCount: number
  projects: WatchedProject[]
  clients: { id: string; name: string; repoFullName: string | null }[]
}

const g = globalThis as unknown as { __lovableGitWatch?: Promise<GitWatchRunResult> | null; __lovableGitWatchDay?: string }

async function readState(): Promise<State | null> {
  const row = await prisma.appSetting.findUnique({ where: { key: STATE_KEY } })
  if (!row) return null
  try {
    return { ...EMPTY, ...(JSON.parse(row.value) as Partial<State>) }
  } catch {
    return null
  }
}

async function writeState(s: State): Promise<void> {
  const value = JSON.stringify(s)
  await prisma.appSetting.upsert({ where: { key: STATE_KEY }, create: { key: STATE_KEY, value }, update: { value } })
}

// ---------------------------------------------------------------------------
// Lovable listing
// ---------------------------------------------------------------------------

type Rec = Record<string, unknown>
const str = (v: unknown) => (typeof v === 'string' && v ? v : null)
const isRec = (v: unknown): v is Rec => !!v && typeof v === 'object' && !Array.isArray(v)

/** The first array of objects in a tool's answer: data, projects, workspaces, items… */
function listIn(s: Rec | null, keys: string[]): Rec[] {
  if (!s) return []
  for (const k of keys) {
    const v = s[k]
    if (Array.isArray(v)) return v.filter(isRec)
    if (isRec(v)) {
      const inner = listIn(v, keys)
      if (inner.length) return inner
    }
  }
  return []
}

function nextCursor(s: Rec | null): string | null {
  if (!s) return null
  const p = isRec(s.pagination) ? s.pagination : s
  if (p.has_more === false) return null
  return str(p.next_cursor) ?? str(p.nextCursor) ?? null
}

async function workspaceIds(): Promise<string[]> {
  const fromMe = await lovableMcpCall('get_me', {}, 30_000).catch(() => null)
  let list = listIn(fromMe?.structured ?? null, ['workspaces', 'data', 'items'])
  if (!list.length) {
    const res = await lovableMcpCall('list_workspaces', { limit: 100 }, 30_000)
    list = listIn(res.structured, ['data', 'workspaces', 'items', 'results'])
  }
  const ids = list
    .map((w) => str(w.id) ?? str(w.workspace_id) ?? (isRec(w.workspace) ? str(w.workspace.id) : null))
    .filter((x): x is string => !!x)
  if (!ids.length) {
    throw new LovableMcpError(
      'Lovable didn’t list any workspaces for the Hub’s sign-in. Disconnect and connect Lovable again on the SEO page — the Hub now asks for permission to read workspaces.',
    )
  }
  return [...new Set(ids)]
}

type ListedProject = { id: string; name: string; createdAt: string | null; latestCommitSha: string | null; url: string }

async function listAllProjects(): Promise<ListedProject[]> {
  const out = new Map<string, ListedProject>()
  for (const ws of await workspaceIds()) {
    let cursor: string | null = null
    for (let page = 0; page < MAX_PAGES; page++) {
      const res = await lovableMcpCall('list_projects', { workspace_id: ws, limit: PAGE_SIZE, ...(cursor ? { cursor } : {}) }, 60_000)
      const items = listIn(res.structured, ['data', 'projects', 'items', 'results'])
      for (const p of items) {
        const id = str(p.id) ?? str(p.project_id)
        if (!id) continue
        out.set(id, {
          id,
          name: str(p.name) ?? str(p.title) ?? str(p.display_name) ?? id,
          createdAt: str(p.created_at) ?? str(p.createdAt),
          latestCommitSha: str(p.latest_commit_sha) ?? str(p.latestCommitSha),
          url: str(p.editor_url) ?? str(p.url) ?? `https://lovable.dev/projects/${id}`,
        })
      }
      cursor = nextCursor(res.structured)
      if (!cursor || !items.length) break
      if (page === MAX_PAGES - 1) throw new LovableMcpError(`More than ${MAX_PAGES * PAGE_SIZE} Lovable projects in one workspace — the watch stopped rather than miss some.`)
    }
  }
  return [...out.values()]
}

// ---------------------------------------------------------------------------
// GitHub + client matching
// ---------------------------------------------------------------------------

const norm = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\b(llc|inc|co|corp|ltd|the|and|site|website|web|landing|page|copy|remix|of|v\d+)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

async function repoHolding(sha: string, since: number, repos: Awaited<ReturnType<typeof listOwnedRepos>>, taken: Set<string>): Promise<string | null> {
  for (const r of repos) {
    if (!isClientRepo(r.fullName) || taken.has(r.fullName.toLowerCase())) continue
    if (!r.createdAt || Date.parse(r.createdAt) < since) continue
    try {
      await compareCommits(r.fullName, r.defaultBranch, sha)
      return r.fullName
    } catch (err) {
      if (err instanceof GitHubError && (err.status === 404 || err.status === 422)) continue
      throw err
    }
  }
  return null
}

type ClientRow = { id: string; name: string; repoFullName: string | null; lovableProjectId: string | null }

async function clientRows(): Promise<ClientRow[]> {
  const rows = await prisma.client.findMany({
    where: { archivedAt: null },
    select: { id: true, name: true, seoSite: { select: { repoFullName: true, lovableProjectId: true, archivedAt: true } } },
    orderBy: { name: 'asc' },
  })
  return rows.map((c) => ({
    id: c.id,
    name: c.name,
    repoFullName: c.seoSite && !c.seoSite.archivedAt ? c.seoSite.repoFullName : null,
    lovableProjectId: c.seoSite && !c.seoSite.archivedAt ? c.seoSite.lovableProjectId : null,
  }))
}

/** The one client this project belongs to: by repo or Lovable project id already on it, else by name. */
function matchClient(p: WatchedProject, clients: ClientRow[]): ClientRow[] {
  const repo = p.repoFullName?.toLowerCase()
  const byRepo = repo ? clients.filter((c) => c.repoFullName?.toLowerCase() === repo) : []
  if (byRepo.length) return byRepo
  const byId = clients.filter((c) => c.lovableProjectId === p.id)
  if (byId.length) return byId
  const n = norm(p.name)
  if (n.length < 3) return []
  const exact = clients.filter((c) => norm(c.name) === n)
  if (exact.length) return exact
  // Every word of the shorter name in the longer one ("jr-painting-pro" ⊇ "J&R Painting"),
  // and enough of it to mean something — "fence" alone would match half the roster.
  const words = (s: string) => new Set(s.split(' ').filter(Boolean))
  const pw = words(n)
  return clients.filter((c) => {
    const cn = norm(c.name)
    const cw = words(cn)
    const [short, long, shortText] = cw.size <= pw.size ? [cw, pw, cn] : [pw, cw, n]
    return (short.size >= 2 || shortText.length >= 8) && [...short].every((w) => long.has(w))
  })
}

/** Link the repo to the client (the Repo column) and remember the project for publishing. */
export async function attachProject(p: WatchedProject, clientId: string): Promise<WatchedProject> {
  if (!p.repoFullName) throw new Error('This project isn’t connected to GitHub yet.')
  const client = await prisma.client.findUnique({ where: { id: clientId }, select: { name: true } })
  if (!client) throw new Error('That client no longer exists.')
  const { siteId } = await assignClientRepo(clientId, p.repoFullName)
  await prisma.seoSite.update({ where: { id: siteId }, data: { lovableProjectId: p.id } })
  return { ...p, attach: 'attached', clientId, clientName: client.name, note: null }
}

async function tryAttach(p: WatchedProject, clients: ClientRow[]): Promise<WatchedProject> {
  const matches = matchClient(p, clients)
  if (matches.length !== 1) {
    return { ...p, attach: 'suggest', note: matches.length > 1 ? `Matches ${matches.map((m) => m.name).join(', ')} — pick one.` : 'No client matched its name — pick one.' }
  }
  const c = matches[0]
  if (c.repoFullName && c.repoFullName.toLowerCase() !== p.repoFullName?.toLowerCase()) {
    return { ...p, attach: 'blocked', clientId: c.id, clientName: c.name, note: `${c.name} is already linked to ${c.repoFullName}.` }
  }
  try {
    return await attachProject(p, c.id)
  } catch (err) {
    return { ...p, attach: 'blocked', clientId: c.id, clientName: c.name, note: err instanceof Error ? err.message : String(err) }
  }
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

export type GitWatchRunResult = { started: boolean; newProjects: number; needsGithub: number; connected: number; attached: number; error: string | null }

async function runOnce(opts: { alert: boolean }): Promise<GitWatchRunResult> {
  const prev = (await readState()) ?? EMPTY
  const now = new Date()
  const stamp = { lastRunAt: now.toISOString(), ...(opts.alert ? { lastDailyAt: now.toISOString() } : {}) }
  const result: GitWatchRunResult = { started: false, newProjects: 0, needsGithub: 0, connected: 0, attached: 0, error: null }
  try {
    if (!(await lovableMcpStatus()).connected) throw new LovableMcpError('Lovable isn’t connected — connect it on the SEO page.')
    const listed = await listAllProjects()

    if (!prev.startedAt) {
      // First run: everything that exists now is the baseline, never flagged.
      await writeState({ ...prev, ...stamp, startedAt: now.toISOString(), baseline: listed.map((p) => p.id), lastError: null })
      return { ...result, started: true }
    }

    const known = new Set([...prev.baseline, ...prev.projects.map((p) => p.id)])
    const listedById = new Map(listed.map((p) => [p.id, p]))
    const projects: WatchedProject[] = prev.projects.map((p) => {
      const l = listedById.get(p.id)
      if (l) return { ...p, name: l.name, url: l.url, createdAt: p.createdAt ?? l.createdAt }
      return p.status === 'needs_github' ? { ...p, status: 'dismissed', note: 'No longer in Lovable.' } : p
    })
    for (const l of listed) {
      if (known.has(l.id)) continue
      result.newProjects++
      projects.push({
        id: l.id,
        name: l.name,
        url: l.url,
        createdAt: l.createdAt,
        firstSeenAt: now.toISOString(),
        status: 'needs_github',
        repoFullName: null,
        connectedAt: null,
        attach: null,
        clientId: null,
        clientName: null,
        note: null,
      })
    }

    const pending = projects.filter((p) => p.status === 'needs_github' && listedById.has(p.id))
    const repos = pending.length ? await listOwnedRepos() : []
    // Repos already claimed by another watched project. Ones linked to a client
    // by hand still count: that's this project, connected and linked early.
    const taken = new Set(projects.map((p) => p.repoFullName?.toLowerCase()).filter((x): x is string => !!x))
    const clients = await clientRows()

    const shas = new Map<string, string | null>()
    for (const p of pending) {
      shas.set(p.id, listedById.get(p.id)?.latestCommitSha ?? (await lovableMcpGetProject(p.id).catch(() => null))?.latestCommitSha ?? null)
    }
    // Two unedited remixes of one template share a commit, so either would
    // match the other's repo. Wait until their histories differ.
    const shared = new Set([...shas.values()].filter((s, i, all): s is string => !!s && all.indexOf(s) !== i))

    for (let i = 0; i < projects.length; i++) {
      let p = projects[i]
      if (p.status === 'needs_github' && listedById.has(p.id)) {
        const sha = shas.get(p.id) ?? null
        const created = p.createdAt ? Date.parse(p.createdAt) : NaN
        const since = (Number.isNaN(created) ? Date.parse(p.firstSeenAt) - UNKNOWN_CREATED_LOOKBACK_MS : created) - REPO_SLACK_MS
        const repo = sha && !shared.has(sha) ? await repoHolding(sha, since, repos, taken) : null
        if (repo) {
          taken.add(repo.toLowerCase())
          p = { ...p, status: 'connected', repoFullName: repo, connectedAt: now.toISOString() }
          result.connected++
        }
      }
      const retrying = p.status === 'connected' && p.attach !== 'attached' && p.connectedAt && now.getTime() - Date.parse(p.connectedAt) < ATTACH_RETRY_MS
      if (retrying) {
        p = await tryAttach(p, clients)
        if (p.attach === 'attached') {
          result.attached++
          const c = clients.find((x) => x.id === p.clientId)
          if (c) c.repoFullName = p.repoFullName
        }
      }
      projects[i] = p
    }

    result.needsGithub = projects.filter((p) => p.status === 'needs_github').length
    const next: State = { ...prev, ...stamp, projects, lastError: null }
    await writeState(next)
    if (opts.alert) await postDigest(next, prev)
    return result
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    await writeState({ ...prev, ...stamp, lastError: message }).catch(() => undefined)
    if (opts.alert) await seoAlert(`:warning: *Lovable → GitHub* — the daily check failed: ${message}`)
    return { ...result, error: message }
  }
}

function hubUrl(path: string): string {
  return `${(process.env.AUTH_URL || 'http://localhost:3000').replace(/\/+$/, '')}${path}`
}

async function postDigest(s: State, prev: State): Promise<void> {
  const before = new Map(prev.projects.map((p) => [p.id, p]))
  const pending = s.projects.filter((p) => p.status === 'needs_github')
  const justConnected = s.projects.filter((p) => p.status === 'connected' && before.get(p.id)?.status !== 'connected')
  const justAttached = s.projects.filter((p) => p.attach === 'attached' && before.get(p.id)?.attach !== 'attached' && !justConnected.includes(p))
  if (!pending.length && !justConnected.length && !justAttached.length) return

  const lines = [':link: *Lovable → GitHub*']
  if (pending.length) {
    lines.push(`${pending.length} new project${pending.length === 1 ? '' : 's'} still need${pending.length === 1 ? 's' : ''} GitHub — open it, then Settings → Git → GitHub → Connect:`)
    for (const p of pending) lines.push(`• <${p.url}|${p.name}>${p.createdAt ? ` (created ${p.createdAt.slice(0, 10)})` : ''}`)
  }
  for (const p of [...justConnected, ...justAttached]) {
    lines.push(
      p.attach === 'attached'
        ? `• ${p.name} → ${p.repoFullName}, linked to *${p.clientName}* :white_check_mark:`
        : `• ${p.name} → ${p.repoFullName} — ${p.note ?? 'no client linked yet'}`,
    )
  }
  lines.push(hubUrl('/clients'))
  await seoAlert(lines.join('\n'))
}

/** Run now (the Clients page button) — one run at a time per process. */
export function runLovableGitWatch(opts: { alert?: boolean } = {}): Promise<GitWatchRunResult> {
  if (!g.__lovableGitWatch) {
    g.__lovableGitWatch = runOnce({ alert: opts.alert ?? false }).finally(() => {
      g.__lovableGitWatch = null
    })
  }
  return g.__lovableGitWatch
}

/** Scheduler hook: once a day from RUN_HOUR_UTC. Cheap when it's not time. */
export async function maybeRunLovableGitWatch(now = new Date()): Promise<GitWatchRunResult | null> {
  if (now.getUTCHours() < RUN_HOUR_UTC) return null
  const day = now.toISOString().slice(0, 10)
  if (g.__lovableGitWatchDay === day) return null
  g.__lovableGitWatchDay = day
  // A restart later the same day must not post the digest twice.
  const s = await readState()
  if (s?.lastDailyAt?.slice(0, 10) === day) return null
  if (!(await lovableMcpStatus()).connected) return null
  return runLovableGitWatch({ alert: true })
}

export async function gitWatchView(): Promise<GitWatchView> {
  const [s, status, clients] = await Promise.all([readState(), lovableMcpStatus(), clientRows()])
  return {
    connected: status.connected,
    startedAt: s?.startedAt ?? null,
    lastRunAt: s?.lastRunAt ?? null,
    lastError: s?.lastError ?? null,
    baselineCount: s?.baseline.length ?? 0,
    projects: [...(s?.projects ?? [])].sort((a, b) => b.firstSeenAt.localeCompare(a.firstSeenAt)),
    clients: clients.map(({ id, name, repoFullName }) => ({ id, name, repoFullName })),
  }
}

/** Not a client site (or connected some other way): stop flagging it. Or flag it again. */
export async function setDismissed(projectId: string, dismissed: boolean): Promise<void> {
  const s = await readState()
  const p = s?.projects.find((x) => x.id === projectId)
  if (!s || !p) throw new Error('That project isn’t on the list.')
  p.status = dismissed ? 'dismissed' : p.repoFullName ? 'connected' : 'needs_github'
  if (!dismissed) p.note = null
  await writeState(s)
}

/** Link a connected project's repo to a client picked by hand. */
export async function attachToClient(projectId: string, clientId: string): Promise<void> {
  const s = await readState()
  const i = s?.projects.findIndex((x) => x.id === projectId) ?? -1
  if (!s || i < 0) throw new Error('That project isn’t on the list.')
  s.projects[i] = await attachProject(s.projects[i], clientId)
  await writeState(s)
}
