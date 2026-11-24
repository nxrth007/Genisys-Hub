import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

// Every client in Sites with a live site has an SEO seat (src/lib/seo/link-client.ts): without one the
// domain guard and Search Console never look at the site. A Plus Fence had none until 2026-11-24.

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

/** link-client.ts with a database of clients and seats in memory. */
function load({ clients, seats }) {
  const seatOf = (clientId) => seats.find((s) => s.clientId === clientId) ?? null
  const asked = []
  const prisma = {
    client: {
      findUnique: async ({ where }) => {
        const c = clients.find((x) => x.id === where.id)
        return c ? { ...c, seoSite: seatOf(c.id) } : null
      },
      findMany: async (q) => {
        asked.push(q)
        return clients
          .filter((c) => !c.archivedAt && c.siteUrl && !['churned', 'denied'].includes(c.lifecycle))
          .filter((c) => {
            const s = seatOf(c.id)
            return !s || (!s.archivedAt && s.liveUrl === null)
          })
      },
    },
    seoSite: {
      updateMany: async ({ where, data }) => {
        const hit = seats.filter((s) => s.clientId === where.clientId && s.archivedAt === null)
        hit.forEach((s) => Object.assign(s, data))
        return { count: hit.length }
      },
      update: async ({ where, data }) => Object.assign(seats.find((s) => s.id === where.id), data),
      create: async ({ data }) => {
        const s = { id: `seat-${seats.length + 1}`, archivedAt: null, ...data }
        seats.push(s)
        return { id: s.id }
      },
    },
  }
  const { outputText } = ts.transpileModule(readFileSync(join(root, 'src/lib/seo/link-client.ts'), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  })
  const m = { exports: {} }
  const quiet = { log() {}, warn() {} }
  new Function('module', 'exports', 'require', 'console', outputText)(m, m.exports, (id) => (id === '@/lib/prisma' ? { prisma } : assert.fail(id)), quiet)
  return { ...m.exports, seats, asked }
}

const client = (id, siteUrl, over = {}) => ({ id, name: id, siteUrl, archivedAt: null, lifecycle: 'active', ...over })
const seat = (clientId, liveUrl, over = {}) => ({ id: `s-${clientId}`, clientId, liveUrl, archivedAt: null, ...over })

test('a live site without a seat gets one, in Audit mode; a seat with no address takes the link', async () => {
  const db = load({
    clients: [client('byhand', 'https://a.org'), client('blank', 'https://b.org'), client('fine', 'https://c.org'), client('building', null)],
    seats: [seat('blank', null), seat('fine', 'https://c.org')],
  })
  assert.equal(await db.seatLiveSites(), 2)
  const made = db.seats.find((s) => s.clientId === 'byhand')
  assert.equal(made.liveUrl, 'https://a.org')
  assert.equal(made.mode, 'audit')
  assert.equal(db.seats.find((s) => s.clientId === 'blank').liveUrl, 'https://b.org')
  assert.equal(db.seats.length, 3)
  // Settled: nothing more to do.
  assert.equal(await db.seatLiveSites(), 0)
})

test('it only looks at clients in Sites: on the roster, with a Genisys OS sub-account and a link', async () => {
  const db = load({ clients: [], seats: [] })
  await db.seatLiveSites()
  const w = db.asked[0].where
  assert.equal(w.archivedAt, null)
  assert.deepEqual(w.lifecycle, { notIn: ['churned', 'denied'] })
  assert.deepEqual(w.hlAccount, { is: { archivedAt: null } })
  assert.deepEqual(w.AND, [{ siteUrl: { not: null } }, { siteUrl: { not: '' } }])
})

test('saving a site link makes the missing seat, moves an existing one, and leaves an archived one alone', async () => {
  const db = load({
    clients: [client('byhand', 'https://a.org'), client('fine', 'https://new.org'), client('removed', 'https://r.org')],
    seats: [seat('fine', 'https://old.org'), seat('removed', 'https://r-old.org', { archivedAt: new Date() })],
  })
  await db.syncSeoSiteLiveUrl('byhand', 'https://a.org')
  await db.syncSeoSiteLiveUrl('fine', 'https://new.org')
  await db.syncSeoSiteLiveUrl('removed', 'https://r.org')
  await db.syncSeoSiteLiveUrl('byhand', null)
  assert.equal(db.seats.find((s) => s.clientId === 'byhand').liveUrl, 'https://a.org')
  assert.equal(db.seats.find((s) => s.clientId === 'fine').liveUrl, 'https://new.org')
  assert.equal(db.seats.find((s) => s.clientId === 'removed').liveUrl, 'https://r-old.org')
  assert.equal(db.seats.length, 3)
})
