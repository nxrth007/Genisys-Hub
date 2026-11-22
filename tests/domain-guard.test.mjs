import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import ts from 'typescript'

// The domain guard's rules (src/lib/seo/domain-guard-plan.ts): what a live
// site tells Google about its own domain, and the file edits that put it
// right. The cases are the ones found on 2026-11-20: Stable Lift's code
// built its domain from a guessed website (foundationrepairindfw.com), three
// sites named the client's old .com, and 27 had SITE_URL blank, so their
// sitemap answered "Public domain pending confirmation".

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const cache = new Map()

function loadTs(absPath) {
  if (cache.has(absPath)) return cache.get(absPath)
  const source = readFileSync(absPath, 'utf8')
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  })
  const m = { exports: {} }
  cache.set(absPath, m.exports)
  const localRequire = createRequire(pathToFileURL(absPath))
  const req = (id) => {
    if (id.startsWith('.')) return loadTs(join(dirname(absPath), id.endsWith('.ts') ? id : `${id}.ts`))
    if (id.startsWith('@/')) {
      const rel = id.slice(2)
      return loadTs(join(root, 'src', rel.endsWith('.ts') ? rel : `${rel}.ts`))
    }
    return localRequire(id)
  }
  new Function('module', 'exports', 'require', outputText)(m, m.exports, req)
  cache.set(absPath, m.exports)
  return m.exports
}

const g = loadTs(join(root, 'src/lib/seo/domain-guard-plan.ts'))

const KEY = '0123456789abcdef0123456789abcdef'

const sitemapOf = (host, paths = ['/', '/about', '/services']) =>
  `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${paths
    .map((p) => `  <url>\n    <loc>https://${host}${p}</loc>\n  </url>`)
    .join('\n')}\n</urlset>\n`

function look(over = {}) {
  return {
    siteUrl: 'https://stableliftfoundationrepair.org',
    status: 200,
    error: null,
    finalUrl: 'https://stableliftfoundationrepair.org/',
    hosting: 'lovable',
    canonical: 'https://stableliftfoundationrepair.org/',
    ogUrl: 'https://stableliftfoundationrepair.org/',
    title: 'Stable Lift Foundation Repair | foundation repair in Irving, TX',
    siteName: 'Stable Lift Foundation Repair',
    sitemap: { status: 200, body: sitemapOf('stableliftfoundationrepair.org') },
    ...over,
  }
}

// ---------------------------------------------------------------------------
// replaceHost
// ---------------------------------------------------------------------------

test('replaceHost moves a domain everywhere it is the host, never inside an email address', () => {
  const text = [
    'export const SITE_URL = "https://builtbykj.com";',
    '  "email": "info@builtbykj.com",',
    '  "website": "https://www.builtbykj.com",',
    'Visit builtbykj.com. Or mailto:info@builtbykj.com',
  ].join('\n')
  const r = g.replaceHost(text, 'builtbykj.com', 'builtbykj.org')
  assert.equal(r.count, 3)
  assert.ok(r.text.includes('export const SITE_URL = "https://builtbykj.org";'))
  assert.ok(r.text.includes('"website": "https://builtbykj.org"'), 'www. goes with the old host')
  assert.ok(r.text.includes('Visit builtbykj.org.'))
  assert.equal((r.text.match(/info@builtbykj\.com/g) ?? []).length, 2, 'both email addresses stay as they are')
})

test('replaceHost leaves other hosts that merely contain the name alone, and is idempotent', () => {
  const text = 'mybuiltbykj.com mail.builtbykj.com builtbykj.com.au builtbykj.community https://builtbykj.com/x'
  const once = g.replaceHost(text, 'www.builtbykj.com', 'builtbykj.org')
  assert.equal(once.text, 'mybuiltbykj.com mail.builtbykj.com builtbykj.com.au builtbykj.community https://builtbykj.org/x')
  assert.equal(g.replaceHost(once.text, 'builtbykj.com', 'builtbykj.org').count, 0)
  assert.equal(g.replaceHost('https://acme.org', 'acme.org', 'www.acme.org').count, 0, 'never "moves" a host onto itself')
})

// ---------------------------------------------------------------------------
// readLook
// ---------------------------------------------------------------------------

test('Stable Lift: canonical links and sitemap on a domain that is not the site → wrong_domain', () => {
  const v = g.readLook(
    look({
      canonical: 'https://foundationrepairindfw.com/',
      ogUrl: 'https://foundationrepairindfw.com/',
      sitemap: { status: 200, body: sitemapOf('foundationrepairindfw.com') },
    }),
  )
  assert.equal(v.kind, 'fix')
  assert.equal(v.problem, 'wrong_domain')
  assert.deepEqual(v.wrongHosts, ['foundationrepairindfw.com'])
  assert.equal(v.servedOrigin, 'https://stableliftfoundationrepair.org')
  assert.match(v.summary, /foundationrepairindfw\.com, not stableliftfoundationrepair\.org/)
})

test('a sitemap on the old .com with no canonical link → sitemap_wrong_host', () => {
  const v = g.readLook(
    look({
      siteUrl: 'https://heavyonthemove.org',
      finalUrl: 'https://heavyonthemove.org/',
      canonical: null,
      ogUrl: null,
      sitemap: { status: 200, body: sitemapOf('heavyonthemove.com') },
    }),
  )
  assert.equal(v.kind, 'fix')
  assert.equal(v.problem, 'sitemap_wrong_host')
  assert.deepEqual(v.wrongHosts, ['heavyonthemove.com'])
  assert.match(v.summary, /URL not allowed/)
})

test('SITE_URL blank: "Public domain pending confirmation" → sitemap_pending', () => {
  const v = g.readLook(look({ canonical: null, ogUrl: null, sitemap: { status: 503, body: 'Public domain pending confirmation.' } }))
  assert.equal(v.kind, 'fix')
  assert.equal(v.problem, 'sitemap_pending')
  assert.deepEqual(v.wrongHosts, [])
})

test('any other answer for /sitemap.xml → sitemap_broken', () => {
  const v = g.readLook(look({ canonical: null, ogUrl: null, sitemap: { status: 404, body: '<!DOCTYPE html><html>Not found</html>' } }))
  assert.equal(v.kind, 'fix')
  assert.equal(v.problem, 'sitemap_broken')
})

test('a site naming its own domain is ok; www and apex are one site', () => {
  const ok = g.readLook(look())
  assert.equal(ok.kind, 'ok')
  assert.equal(ok.pages, 3)
  const www = g.readLook(
    look({ siteUrl: 'https://acme.org', finalUrl: 'https://www.acme.org/', canonical: 'https://acme.org/', ogUrl: null, sitemap: { status: 200, body: sitemapOf('www.acme.org') } }),
  )
  assert.equal(www.kind, 'ok')
  assert.equal(www.servedOrigin, 'https://www.acme.org')
})

test('the Hub never touches a site that is down, redirects elsewhere, or is not our Lovable build', () => {
  assert.equal(g.readLook(look({ status: 0, error: 'fetch failed' })).kind, 'person')
  assert.equal(g.readLook(look({ status: 404 })).kind, 'person')
  const moved = g.readLook(look({ finalUrl: 'https://someoneelse.com/' }))
  assert.equal(moved.kind, 'person')
  assert.match(moved.summary, /Set the client’s Site link to https:\/\/someoneelse\.com/)
  assert.equal(g.readLook(look({ hosting: 'wix' })).kind, 'person')
  assert.equal(g.readLook(look({ hosting: null })).kind, 'person')
  assert.equal(g.readLook(look({ siteUrl: 'not a url' })).kind, 'person')
})

// ---------------------------------------------------------------------------
// Whose site
// ---------------------------------------------------------------------------

const STABLE_SITE_TS = `import hero from '@/assets/stable/hero.jpg';

export const business = {
 name: 'Stable Lift Foundation Repair', displayName: 'Stable Lift Foundation Repair', owner: 'Felix Rogers',
 phone: '(214) 433-4141', email: 'owner@example.com',
 website: 'foundationrepairindfw.com', location: 'Irving, TX',
};

export const services = [{ name: 'Foundation repair', slug: 'foundation-repair' }];
`

test('repoBusinessNames reads the business block, not a service, in both spellings of site data', () => {
  assert.deepEqual(g.repoBusinessNames(STABLE_SITE_TS), ['Stable Lift Foundation Repair'])
  const json = 'export const business = {\n  "name": "IJ Switchgear LLC",\n  "displayName": "IJ Switchgear",\n  "shortname": "IJ"\n}'
  assert.deepEqual(g.repoBusinessNames(json), ['IJ Switchgear LLC', 'IJ Switchgear'])
  assert.deepEqual(g.repoBusinessNames(null), [])
  // An apostrophe in the name; social links and services after it have a `name` too (Gary's and Jake's sites).
  const gary = [
    'export const business = {',
    '  "name": "Gary\'s Shining Cleaning Services",',
    '  "legalName": "Gary Shining Cleaning Services LLC",',
    '  "socials": [',
    '    { "name": "Instagram", "url": "https://www.instagram.com/x/" }',
    '  ]',
    '};',
  ].join('\n')
  assert.deepEqual(g.repoBusinessNames(gary), ["Gary's Shining Cleaning Services", 'Gary Shining Cleaning Services LLC'])
  const jakes = 'export const business = {\n  "name": "Jake\'s Property Maintenance LLC",\n  "website": ""\n};\nexport const services = [\n  { "slug": "cleanouts", "name": "Cleanouts" }\n];\n'
  assert.deepEqual(g.repoBusinessNames(jakes), ["Jake's Property Maintenance LLC"])
  assert.deepEqual(g.repoBusinessNames("export const business = {\n name: 'Jake\\'s Property Maintenance',\n};\n"), ["Jake's Property Maintenance"])
})

test('sameBusiness: short names, entities in a page title, and the LLC on one side only', () => {
  assert.ok(g.sameBusiness('BNB Contractors', 'BNB Contractors'))
  assert.ok(g.sameBusiness('GTC Services', 'GTC Services LLC'))
  assert.ok(g.sameBusiness('Jake&#x27;s Property Maintenance LLC', "Jake's property maintenance LLC"))
  assert.ok(g.sameBusiness('C&amp;J Concrete Coatings', 'C&J CONCRETE COATINGS LLC'))
  assert.ok(!g.sameBusiness('BNB Contractors', 'GTC Services'))
  assert.ok(!g.sameBusiness('R&F Painting LLC', 'All Appliance Repair'))
  assert.ok(!g.sameBusiness('No', 'No'), 'a two-letter name proves nothing')
})

test('identityProblem: the live page must show the repo’s business, and the repo must be the client’s', () => {
  const base = {
    repo: 'nxrth007/felix-rogers-home-helpers',
    repoNames: ['Stable Lift Foundation Repair'],
    live: { title: 'Stable Lift Foundation Repair | foundation repair in Irving, TX', siteName: 'Stable Lift Foundation Repair' },
    hubNames: ['Stable Lift Foundation Repair'],
    origin: 'https://stableliftfoundationrepair.org',
  }
  assert.equal(g.identityProblem(base), null)
  // The "No" record: a client whose Site link points at another client's site.
  assert.match(g.identityProblem({ ...base, repoNames: ['Reed Home Services'] }), /Repo picked for this client may be the wrong one/)
  assert.match(g.identityProblem({ ...base, hubNames: ['No'] }), /doesn’t look like No/)
  assert.match(g.identityProblem({ ...base, repoNames: [] }), /no business name/)
  // Spelling differences between the Hub and the site are fine.
  assert.equal(g.identityProblem({ ...base, repoNames: ['Done Rite Appliance Repair Co.'], live: { title: null, siteName: 'Done Rite Appliance Repair Co.' }, hubNames: ['Done Rite Appliance Repair CO'] }), null)
})

// ---------------------------------------------------------------------------
// planDomainFix
// ---------------------------------------------------------------------------

const TEMPLATE_SEO = `import { business } from "@/data/site";

// Set only after the business confirms its public domain.
export const SITE_URL = "";

export function absoluteUrl(path: string) {
  return \`\${SITE_URL}\${path}\`;
}
`
const TEMPLATE_CONFIG = `{
  "owner": "Genisys SEO engine",
  "siteUrl": "https://varietypros.org",
  "contentDir": "src/content/blog",
  "indexNowKey": "b808062842de73f8748694385d53e755"
}
`

test('a blank SITE_URL (sitemap pending): SITE_URL, robots.txt, the SEO config and its own IndexNow key', () => {
  const plan = g.planDomainFix({
    files: [
      { path: 'src/lib/seo.ts', content: TEMPLATE_SEO },
      { path: 'public/robots.txt', content: 'User-agent: *\nAllow: /\n' },
      { path: 'src/content/seo.config.json', content: TEMPLATE_CONFIG },
      { path: 'src/data/site.ts', content: STABLE_SITE_TS.replace("website: 'foundationrepairindfw.com', ", '') },
    ],
    repoPaths: ['src/lib/seo.ts', 'public/robots.txt', 'src/content/seo.config.json', 'src/data/site.ts', 'public/b808062842de73f8748694385d53e755.txt'],
    servedOrigin: 'https://taborhomes.org',
    wrongHosts: [],
    indexNowKey: KEY,
  })
  assert.equal(plan.unresolved, null)
  const byPath = Object.fromEntries(plan.changes.map((c) => [c.path, c]))
  assert.deepEqual(Object.keys(byPath).sort(), ['public/0123456789abcdef0123456789abcdef.txt', 'public/robots.txt', 'src/content/seo.config.json', 'src/lib/seo.ts'])
  assert.ok(byPath['src/lib/seo.ts'].content.includes('export const SITE_URL = "https://taborhomes.org";'))
  assert.ok(byPath['public/robots.txt'].content.endsWith('\n\nSitemap: https://taborhomes.org/sitemap.xml\n'))
  const config = JSON.parse(byPath['src/content/seo.config.json'].content)
  assert.equal(config.siteUrl, 'https://taborhomes.org')
  assert.equal(config.indexNowKey, KEY)
  assert.equal(config.owner, 'Genisys SEO engine', 'the rest of the config stays')
  assert.equal(byPath[`public/${KEY}.txt`].content, KEY)
  assert.equal(byPath[`public/${KEY}.txt`].existed, false)
  assert.match(plan.notes.join(' '), /SITE_URL was blank/)
})

test('Stable Lift: SITE_URL built from business.website — the site data, its test and Lovable’s notes move to the real domain', () => {
  const seo = TEMPLATE_SEO.replace('export const SITE_URL = "";', 'export const SITE_URL = `https://${business.website}`;')
  const testFile = "test('domain', () => { expect(site.business.website).toBe('foundationrepairindfw.com'); });\n"
  const notes = '# North star\n\nDomain: foundationrepairindfw.com. Email the owner at owner@foundationrepairindfw.com.\n'
  const plan = g.planDomainFix({
    files: [
      { path: 'src/lib/seo.ts', content: seo },
      { path: 'src/data/site.ts', content: STABLE_SITE_TS },
      { path: 'tests/business.test.ts', content: testFile },
      { path: '.lovable/north-star/brief.md', content: notes },
      { path: 'public/robots.txt', content: 'User-agent: *\nAllow: /\n' },
    ],
    repoPaths: [],
    servedOrigin: 'https://stableliftfoundationrepair.org',
    wrongHosts: ['foundationrepairindfw.com'],
    indexNowKey: KEY,
  })
  assert.equal(plan.unresolved, null)
  const byPath = Object.fromEntries(plan.changes.map((c) => [c.path, c.content]))
  assert.equal(byPath['src/lib/seo.ts'], undefined, 'the expression stays: it follows the site data')
  assert.ok(byPath['src/data/site.ts'].includes("website: 'stableliftfoundationrepair.org'"))
  assert.ok(byPath['tests/business.test.ts'].includes("toBe('stableliftfoundationrepair.org')"))
  assert.ok(byPath['.lovable/north-star/brief.md'].includes('Domain: stableliftfoundationrepair.org.'))
  assert.ok(byPath['.lovable/north-star/brief.md'].includes('owner@foundationrepairindfw.com'), 'an email address is never rewritten')
  assert.ok(byPath['public/robots.txt'].includes('Sitemap: https://stableliftfoundationrepair.org/sitemap.xml'))
})

test('IJ Switchgear: a www. SITE_URL on the old .com moves to the live .org; the business email stays', () => {
  const seo = TEMPLATE_SEO.replace('export const SITE_URL = "";', 'export const SITE_URL = "https://www.ijswitchgear.com";')
  const site = 'export const business = {\n  name: "IJ Switchgear LLC",\n  email: "info@ijswitchgear.com",\n  website: "https://www.ijswitchgear.com",\n};\n'
  const plan = g.planDomainFix({
    files: [
      { path: 'src/lib/seo.ts', content: seo },
      { path: 'src/data/site.ts', content: site },
      { path: 'public/robots.txt', content: 'User-agent: *\nAllow: /\n\nSitemap: https://www.ijswitchgear.com/sitemap.xml\n' },
    ],
    repoPaths: [],
    servedOrigin: 'https://ijswitchgear.org',
    wrongHosts: ['ijswitchgear.com'],
    indexNowKey: KEY,
  })
  assert.equal(plan.unresolved, null)
  const byPath = Object.fromEntries(plan.changes.map((c) => [c.path, c.content]))
  assert.ok(byPath['src/lib/seo.ts'].includes('export const SITE_URL = "https://ijswitchgear.org";'))
  assert.ok(byPath['src/data/site.ts'].includes('email: "info@ijswitchgear.com"'))
  assert.ok(byPath['src/data/site.ts'].includes('website: "https://ijswitchgear.org"'))
  assert.equal(byPath['public/robots.txt'], 'User-agent: *\nAllow: /\n\nSitemap: https://ijswitchgear.org/sitemap.xml\n')
})

test('nothing to change when the code already names the domain (the live site is an older publish)', () => {
  const seo = TEMPLATE_SEO.replace('export const SITE_URL = "";', 'export const SITE_URL = "https://cnctransportationservices.org";')
  const plan = g.planDomainFix({
    files: [
      { path: 'src/lib/seo.ts', content: seo },
      { path: 'public/robots.txt', content: 'User-agent: *\nAllow: /\n\nSitemap: https://cnctransportationservices.org/sitemap.xml\n' },
    ],
    repoPaths: [],
    servedOrigin: 'https://cnctransportationservices.org',
    wrongHosts: [],
    indexNowKey: KEY,
  })
  assert.deepEqual(plan.changes, [])
  assert.equal(plan.unresolved, null)
})

test('unresolved when the code gives nowhere to set the domain', () => {
  const none = g.planDomainFix({ files: [{ path: 'public/robots.txt', content: 'User-agent: *\n' }], repoPaths: [], servedOrigin: 'https://acme.org', wrongHosts: [], indexNowKey: KEY })
  assert.match(none.unresolved, /no src\/lib\/seo\.ts/)
  const expr = g.planDomainFix({
    files: [{ path: 'src/lib/seo.ts', content: 'export const SITE_URL = `https://${business.website}`;\n' }],
    repoPaths: [],
    servedOrigin: 'https://acme.org',
    wrongHosts: ['acme.com'],
    indexNowKey: KEY,
  })
  assert.match(expr.unresolved, /couldn’t find where/)
})

test('scanCandidates: the text files that can name a domain, not images, lockfiles or Lovable’s image metadata', () => {
  const entries = [
    ['src/data/site.ts', 4000],
    ['src/routes/terms.tsx', 9000],
    ['src/routes/sitemap[.]xml.ts', 1500],
    ['tests/business.test.ts', 3000],
    ['.lovable/north-star/brief.md', 2000],
    ['AGENTS.md', 1000],
    ['index.html', 800],
    ['public/robots.txt', 40],
    ['src/assets/stable/hero.jpg', 300000],
    ['src/assets/stable/hero.jpg.asset.json', 500],
    ['bun.lock', 90000],
    ['src/routeTree.gen.ts', 20000],
    ['src/data/huge.json', 900000],
    ['node_modules/x/index.js', 100],
  ].map(([path, size]) => ({ path, type: 'blob', size }))
  assert.deepEqual(g.scanCandidates(entries), [
    'src/data/site.ts',
    'src/routes/terms.tsx',
    'src/routes/sitemap[.]xml.ts',
    'tests/business.test.ts',
    '.lovable/north-star/brief.md',
    'AGENTS.md',
    'index.html',
    'public/robots.txt',
  ])
})
