import { prisma } from '@/lib/prisma'
import { PAYMENTS_ALLOWED_EMAILS } from '@/lib/payments-access'
import { fetchPage } from './crawl'
import { branchExists, commitToNewBranch, deleteBranch, mergePullRequest, openPullRequest, readFile, recentCommits } from './github'
import {
  gscAddSite,
  gscConfigured,
  GscError,
  gscListSites,
  gscSubmitSitemap,
  siteVerificationAddOwners,
  siteVerificationFileToken,
  siteVerificationVerify,
} from './gsc'
import { bareHost } from './html'
import { lovableChannel, lovableProjectInfo, lovableProjectMatchesRepo, publishLovableProject } from './lovable'
import { lovableMcpDeploy } from './lovable-mcp'
import { hubUrl, lovableHasMerge } from './pipeline'
import { detectLovableProjectId } from './repo'
import { seoAlert } from './slack'

/**
 * Hooking every client site up to Search Console without anyone opening it.
 *
 * Once a Google account is connected (SEO → Setup → Connect Search
 * Console), each engine tick takes the sites with no property yet:
 *   1. If that account can already see the site (a domain or URL-prefix
 *      property), use it.
 *   2. Otherwise ask Google for its verification file, commit it to the
 *      site's repo as public/googleXXXX.html — a one-file pull request the
 *      engine merges itself; a static file can't break the build — and
 *      publish in Lovable.
 *   3. Once the file is live: verify, add the property to the account's
 *      Search Console, make Alex and Ethan owners, submit the sitemap and
 *      record the property on the site. Weekly runs then read real search
 *      data, and the sitemap goes to Google after every publish.
 *
 * Progress per site lives in one AppSetting, so a deploy carries on where
 * the last process stopped. A site the Hub can't do (no repo, not on
 * Lovable, Google APIs switched off) says why and is retried now and then
 * in case a person fixed it.
 */

const STATE_KEY = 'seo.gsc.connect'
const STEP_MS = 2 * 60_000
const LOVABLE_QUIET_MS = 30 * 60_000
const PUBLISH_RETRY_MS = 10 * 60_000
const MAX_PUBLISHES = 4
/** Two-minute polls before deciding Lovable never pulled the file from GitHub (~1 hour). */
const MAX_SYNC_POLLS = 30
const MAX_FAILURES = 8
/** How often a site that needs a person is looked at again. */
const RECHECK_MS = 6 * 3_600_000
/** Sites stepped per tick, so the engine's own runs aren't held up. */
const PER_TICK = 2

export type GscConnectState = {
  /** connected: done. working: on its way. needs_person: stopped, `detail` says why. */
  status: 'working' | 'connected' | 'needs_person'
  detail: string
  property?: string
  /** Google's verification file name (also its content). */
  token?: string
  mergeSha?: string
  publishes?: number
  lastPublishAt?: number
  syncPolls?: number
  failures?: number
  nextAt?: number
  /** Slack has already been told this exact thing. */
  alerted?: string
  updatedAt: string
}

type StateMap = Record<string, GscConnectState>

type Site = {
  id: string
  name: string
  liveUrl: string | null
  repoFullName: string | null
  defaultBranch: string | null
  lovableProjectId: string | null
}

export async function gscConnectStates(): Promise<StateMap> {
  const row = await prisma.appSetting.findUnique({ where: { key: STATE_KEY } }).catch(() => null)
  if (!row) return {}
  try {
    const v = JSON.parse(row.value) as unknown
    return v && typeof v === 'object' ? (v as StateMap) : {}
  } catch {
    return {}
  }
}

async function saveStates(m: StateMap): Promise<void> {
  const value = JSON.stringify(m)
  await prisma.appSetting.upsert({ where: { key: STATE_KEY }, create: { key: STATE_KEY, value }, update: { value } })
}

/** Forget a site's progress (it was connected or archived by hand). */
export async function clearGscConnectState(siteId: string): Promise<void> {
  const m = await gscConnectStates()
  if (!(siteId in m)) return
  delete m[siteId]
  await saveStates(m)
}

const originOf = (url: string | null): string | null => {
  if (!url) return null
  try {
    return new URL(url).origin
  } catch {
    return null
  }
}

/** One step for up to PER_TICK sites that are due. Called from the engine tick; never throws. */
export async function advanceSearchConsole(now = Date.now()): Promise<void> {
  try {
    const g = await gscConfigured()
    if (!g.ok) return
    const sites: Site[] = await prisma.seoSite.findMany({
      where: { archivedAt: null, gscProperty: null, liveUrl: { not: null } },
      select: { id: true, name: true, liveUrl: true, repoFullName: true, defaultBranch: true, lovableProjectId: true },
      orderBy: { createdAt: 'asc' },
    })
    if (!sites.length) return
    const states = await gscConnectStates()
    let listed: { siteUrl: string; permissionLevel: string }[] | null = null
    let stepped = 0
    for (const site of sites) {
      const st = states[site.id]
      if (st?.nextAt && st.nextAt > now) continue
      if (stepped >= PER_TICK) break
      stepped++
      try {
        listed ??= await gscListSites()
        states[site.id] = await stepSite(site, st, listed, now)
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        const switchedOff = err instanceof GscError && !!err.enableUrl
        const failures = (st?.failures ?? 0) + 1
        const stuck = switchedOff || failures >= MAX_FAILURES
        states[site.id] = {
          ...(st ?? {}),
          status: stuck ? 'needs_person' : 'working',
          detail: message,
          failures,
          // An API switched off is fixed in a minute by a person — look again soon.
          nextAt: now + (switchedOff ? 15 * 60_000 : stuck ? RECHECK_MS : Math.min(60, 2 ** failures) * 60_000),
          updatedAt: new Date(now).toISOString(),
        }
      }
      const next = states[site.id]
      if (next.status === 'needs_person' && next.alerted !== next.detail) {
        await seoAlert(`:warning: *SEO* — ${site.name}: couldn’t connect Search Console. ${next.detail} ${hubUrl(`/seo/${site.id}`)}`)
        states[site.id] = { ...next, alerted: next.detail }
      }
    }
    await saveStates(states)
  } catch (err) {
    console.error('[seo] Search Console connect tick failed:', err)
  }
}

function working(prev: GscConnectState | undefined, now: number, detail: string, patch: Partial<GscConnectState> = {}): GscConnectState {
  return { ...(prev ?? {}), status: 'working', detail, failures: 0, nextAt: now + STEP_MS, updatedAt: new Date(now).toISOString(), ...patch }
}

function needsPerson(prev: GscConnectState | undefined, now: number, detail: string, recheckMs = RECHECK_MS): GscConnectState {
  return { ...(prev ?? {}), status: 'needs_person', detail, nextAt: now + recheckMs, updatedAt: new Date(now).toISOString() }
}

async function stepSite(site: Site, st: GscConnectState | undefined, listed: { siteUrl: string; permissionLevel: string }[], now: number): Promise<GscConnectState> {
  const origin = originOf(site.liveUrl)
  if (!origin) return needsPerson(st, now, 'The site has no valid URL — set it on the Clients page.')

  // Google verifies the address the site is really served at (apex vs www).
  const home = await fetchPage(`${origin}/`, { timeoutMs: 20_000 })
  if (home.status !== 200 || home.error) {
    return needsPerson(st, now, `${origin} doesn’t load (${home.error ?? `HTTP ${home.status}`}) — check the site’s URL on the Clients page.`, 60 * 60_000)
  }
  const servedOrigin = new URL(home.url).origin
  const property = `${servedOrigin}/`
  const host = bareHost(new URL(servedOrigin).hostname)

  // 1. Already in the account's Search Console? A domain property covers every variant.
  const usable = (e: { siteUrl: string; permissionLevel: string }) => e.permissionLevel !== 'siteUnverifiedUser'
  const existing = listed.find((e) => usable(e) && e.siteUrl === `sc-domain:${host}`) ?? listed.find((e) => usable(e) && e.siteUrl === property)
  if (existing) return finish(site, st, existing.siteUrl, servedOrigin, now)

  if (!site.repoFullName) {
    return needsPerson(st, now, 'No GitHub repo is linked, so the Hub can’t place Google’s verification file. Add the site in Search Console by hand, then set the property in the site’s Settings.')
  }
  if (home.hosting && home.hosting !== 'lovable') {
    return needsPerson(st, now, `${servedOrigin} is served by ${home.hosting === 'wix' ? 'Wix' : 'Squarespace'}, not the Lovable build — check the site’s URL on the Clients page.`)
  }

  // 2. Google's verification file.
  const token = st?.property === property && st.token ? st.token : await siteVerificationFileToken(property)
  const base = { property, token }
  if (await fileIsLive(`${property}${token}`, token)) {
    // 3. Verify, own, add, submit.
    const resource = await siteVerificationVerify(property)
    await siteVerificationAddOwners(property, resource, PAYMENTS_ALLOWED_EMAILS).catch((err) => {
      console.warn(`[seo] ${site.name}: verified, but adding owners failed:`, err)
    })
    await gscAddSite(property)
    return finish(site, st, property, servedOrigin, now)
  }

  const fullName = site.repoFullName
  const branch = site.defaultBranch || 'main'
  const path = `public/${token}`
  const inRepo = await readFile(fullName, path, branch)
  if (inRepo == null) {
    const [last] = await recentCommits(fullName, branch, 1)
    if (last?.byLovable && now - Date.parse(last.date) < LOVABLE_QUIET_MS) {
      return working(st, now, 'Waiting for a quiet moment in Lovable before adding Google’s verification file.', { ...base, nextAt: now + 10 * 60_000 })
    }
    const mergeSha = await commitVerificationFile(site, fullName, branch, path, token)
    return working(st, now, 'Added Google’s verification file to the site’s repo; publishing it next.', {
      ...base,
      mergeSha: mergeSha ?? undefined,
      publishes: 0,
      syncPolls: 0,
      nextAt: now + 3 * 60_000,
    })
  }

  // In the repo but not live yet: publish it.
  const channel = await lovableChannel()
  if (!channel) {
    return needsPerson(
      st,
      now,
      'Google’s verification file is in the repo but not live. Connect Lovable on the SEO dashboard, or click Publish in Lovable — the Hub finishes on its own once it’s live.',
      10 * 60_000,
    )
  }
  const publishes = st?.publishes ?? 0
  if (publishes >= MAX_PUBLISHES) {
    return needsPerson(st, now, `Published ${publishes} times and Google’s verification file (${property}${token}) still isn’t live. Open it in a browser to see what the site serves there.`)
  }
  if (st?.lastPublishAt && now - st.lastPublishAt < PUBLISH_RETRY_MS) {
    return working(st, now, 'Published in Lovable; waiting for the verification file to reach the live site.', base)
  }
  const projectId = await projectFor(site, fullName, branch)
  if (!projectId) {
    return needsPerson(st, now, 'The Hub can’t tell which Lovable project this site is. Paste the project’s link in the site’s Settings.')
  }
  if (!publishes && st?.mergeSha) {
    const info = await lovableProjectInfo(projectId)
    if (!(await lovableHasMerge(fullName, st.mergeSha, info?.latestCommitSha ?? null))) {
      const syncPolls = (st.syncPolls ?? 0) + 1
      if (syncPolls >= MAX_SYNC_POLLS) {
        return needsPerson(st, now, 'Lovable hasn’t picked up the verification file from GitHub after an hour. Open the project in Lovable once (that makes it sync), and the Hub carries on.', 30 * 60_000)
      }
      return working(st, now, 'Waiting for Lovable to pick up the verification file from GitHub.', { ...base, syncPolls })
    }
  }
  if (channel === 'mcp') await lovableMcpDeploy(projectId)
  else await publishLovableProject(projectId)
  return working(st, now, 'Published in Lovable; waiting for the verification file to reach the live site.', {
    ...base,
    publishes: publishes + 1,
    lastPublishAt: now,
  })
}

async function finish(site: Site, st: GscConnectState | undefined, property: string, servedOrigin: string, now: number): Promise<GscConnectState> {
  // Best-effort: the sitemap is submitted again after every publish anyway.
  await gscSubmitSitemap(property, `${servedOrigin}/sitemap.xml`).catch((err) => {
    console.warn(`[seo] ${site.name}: connected, but the sitemap submit failed:`, err)
  })
  await prisma.seoSite.update({ where: { id: site.id }, data: { gscProperty: property } })
  await seoAlert(`:white_check_mark: *SEO* — ${site.name} is connected to Search Console (${property}). Weekly runs now use its search data. ${hubUrl(`/seo/${site.id}`)}`)
  return { status: 'connected', detail: `Connected: ${property}`, property, token: st?.token, failures: 0, updatedAt: new Date(now).toISOString() }
}

async function fileIsLive(url: string, token: string): Promise<boolean> {
  try {
    const res = await fetch(url, { cache: 'no-store', redirect: 'follow', signal: AbortSignal.timeout(20_000) })
    if (res.status !== 200) return false
    const text = (await res.text()).slice(0, 2000)
    return text.includes(`google-site-verification: ${token}`)
  } catch {
    return false
  }
}

/** A one-file PR the engine opens and merges itself. Returns the merge commit, or null when the file was already there. */
async function commitVerificationFile(site: Site, fullName: string, branch: string, path: string, token: string): Promise<string | null> {
  const ghBranch = `seo/search-console-${site.id.slice(-6)}`
  if (await branchExists(fullName, ghBranch)) await deleteBranch(fullName, ghBranch)
  const c = await commitToNewBranch({
    fullName,
    baseBranch: branch,
    branch: ghBranch,
    files: [{ path, content: `google-site-verification: ${token}` }],
    message: 'Search Console verification file\n\nLets Google confirm this site belongs to the Genisys account that reads its search data. Added by the Genisys SEO engine.',
  })
  if (c.unchanged) return null
  const pr = await openPullRequest({
    fullName,
    head: ghBranch,
    base: branch,
    title: 'Search Console verification file',
    body: `Adds \`${path}\`, the file Google checks to verify the site for Search Console. One static file — nothing else changes.\n\n_Merged automatically by the Genisys SEO engine._`,
  })
  const merged = await mergePullRequest(fullName, pr.number, c.commitSha, 'Search Console verification file')
  await deleteBranch(fullName, ghBranch).catch(() => {})
  return merged.sha
}

/** The site's Lovable project: set in Settings, or read from the repo and checked against Lovable. */
async function projectFor(site: Site, fullName: string, branch: string): Promise<string | null> {
  if (site.lovableProjectId) return site.lovableProjectId
  const id = await detectLovableProjectId(fullName).catch(() => null)
  if (!id || (await lovableProjectMatchesRepo(id, fullName, branch)) !== 'yes') return null
  await prisma.seoSite.update({ where: { id: site.id }, data: { lovableProjectId: id } })
  return id
}
