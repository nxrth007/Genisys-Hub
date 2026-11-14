import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

// Transpile a src module; relative imports load the neighbouring .ts file (type-only imports vanish).
const cache = new Map()
function loadTs(absPath) {
  if (cache.has(absPath)) return cache.get(absPath)
  const { outputText } = ts.transpileModule(readFileSync(absPath, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  })
  const m = { exports: {} }
  cache.set(absPath, m.exports)
  const req = (name) => {
    if (name.startsWith('./')) return loadTs(join(dirname(absPath), `${name.slice(2)}.ts`))
    throw new Error(`Unexpected dependency: ${name}`)
  }
  new Function('module', 'exports', 'require', outputText)(m, m.exports, req)
  cache.set(absPath, m.exports)
  return m.exports
}

const plan = loadTs(join(root, 'src/lib/hl/site-plan.ts'))
const template = loadTs(join(root, 'src/lib/hl/site-template.ts'))
const embed = loadTs(join(root, 'src/components/hell-level/embed.ts'))
const mapping = loadTs(join(root, 'src/lib/office/mapping.ts'))

const ORIGIN = 'https://genisys-hub.onrender.com'
const quote = { id: 'form_quote_1', kind: 'form', name: 'Website Quote Form' }
const chat = { id: 'form_chat_1', kind: 'chat', name: 'Website Chat Widget' }
const embeds = { formId: quote.id, formEmbed: embed.embedCode(ORIGIN, quote), chatId: chat.id, chatEmbed: embed.embedCode(ORIGIN, chat) }

const photo = (name) => `https://ebuayuxsfoiyxuxrvlfj.supabase.co/storage/v1/object/sign/intake-uploads/1794-ab/${name}?token=abc.def.ghi`

function facts(over = {}) {
  return {
    clientName: 'Panacea homes llc.',
    legalName: 'Panacea homes llc.',
    businessName: 'Panacea Homes',
    ownerName: 'Joseph Barnett',
    phone: plan.phoneParts('+14843627127'),
    phoneSource: 'own',
    email: 'owner@example.com',
    address: '3104 Plymouth Rock Rd, Plymouth Meeting, PA 19462',
    cities: 'Montgomery, Bucks, Chester and Delaware counties',
    timeZoneAnswer: 'Eastern',
    timeZoneHint: 'Eastern',
    currentWebsite: '',
    domain: null,
    about: 'We are a full service kitchen design build firm',
    mainServices: 'Kitchen remodeling',
    whyChooseYou: 'Financing and 38 years of experience',
    promotions: '',
    brandColors: 'black and gold',
    faqs: '',
    yearStarted: '',
    licenseInfo: '',
    socialLinks: [],
    gbpLink: null,
    photos: [{ url: photo('IMG_1.jpeg'), name: 'IMG_1.jpeg' }, { url: photo('IMG_2.jpeg'), name: 'IMG_2.jpeg' }, { url: photo('IMG_3.jpeg'), name: 'IMG_3.jpeg' }],
    skipped: [],
    ...over,
  }
}

function fill(over = {}) {
  return {
    legalName: 'Panacea Homes LLC',
    displayName: 'Panacea Homes',
    cityState: 'Plymouth Meeting, PA',
    fullAddress: '3104 Plymouth Rock Rd, Plymouth Meeting, PA 19462',
    serviceAreaSummary: 'Montgomery, Bucks, Chester, and Delaware Counties, Pennsylvania',
    serviceAreaList: ['Montgomery County, PA', 'Bucks County, PA', 'Chester County, PA', 'Delaware County, PA'],
    timeZone: 'Eastern',
    yearStarted: '',
    experienceLine: '38 years of experience',
    licenseLine: '',
    about: 'Panacea Homes is a full-service kitchen design-build firm.',
    whyChooseUs: ['38 years of experience', 'Financing available'],
    promo: '',
    extraFacts: ['Financing available, ask us for details'],
    brandColors: 'black and gold',
    colorDirection: 'Build an upscale black-and-gold palette.',
    trade: 'kitchen remodeling',
    regionContext: 'older colonial and stone homes in the Philadelphia suburbs',
    heroHeadline: 'Kitchen Design & Remodeling in the Philadelphia Suburbs',
    heroCopy: 'Panacea Homes handles your kitchen from design through installation.',
    heroImage: 'a remodeled kitchen with black and brass fixtures',
    primaryCta: 'Request an Estimate',
    services: [{ name: 'Kitchen Remodeling', note: 'design through completion' }, { name: 'Custom Cabinetry', note: '' }, { name: 'Countertops & Backsplashes', note: '' }],
    photos: [
      { photo: 1, keep: true, shows: 'a finished kitchen island', useFor: 'Kitchen Remodeling' },
      { photo: 2, keep: false, shows: 'a screenshot of a text message', useFor: '' },
      { photo: 3, keep: true, shows: 'new cabinets being installed', useFor: 'Custom Cabinetry' },
    ],
    aiImageScenes: 'hands sketching a kitchen layout; a stone countertop with a tile backsplash',
    mapInstructions: 'Center near Plymouth Meeting, PA, zoomed out to show all four counties.',
    faqs: [{ question: 'Do you offer financing?', answer: 'Yes. Ask us for details.' }],
    blogTopics: Array.from({ length: 9 }, (_, i) => `Topic ${i + 1}`),
    tradeClaimRules: [],
    notes: [],
    ...over,
  }
}

test('the filled one-shot carries the Hell-level form and chat exactly, and no GHL embed', () => {
  const out = plan.buildOneShot(facts(), fill(), embeds, { shown: [0, 1, 2] })
  assert.ok(out.startsWith('# LOVABLE ONE-SHOT — Panacea Homes LLC\n'))
  assert.ok(out.includes(embeds.formEmbed), 'the quote form embed, verbatim')
  assert.ok(out.includes(embeds.chatEmbed), 'the chat widget script, verbatim')
  assert.ok(out.includes(`iframe id hl-form-${quote.id}`))
  assert.ok(out.includes(`data-form="${chat.id}"`))
  assert.doesNotMatch(out, /leadconnectorhq\.com\/widget\/form|data-height=|min-height of at least/)
  assert.doesNotMatch(out, /\{\{[A-Z_]+\}\}|\[\/?IF\b/)
  // Every legal page keeps its contact line with the real details.
  assert.ok(out.includes('Panacea Homes LLC, 3104 Plymouth Rock Rd, Plymouth Meeting, PA 19462. (484) 362-7127. Email: owner@example.com'))
  // No domain yet: the SMS terms say "on this website", and there's no canonical URL.
  assert.ok(out.includes('the quote form on this website'))
  assert.doesNotMatch(out, /Canonical URL/)
})

test('[IF] blocks follow what was supplied', () => {
  const bare = plan.buildOneShot(facts(), fill({ experienceLine: '' }), embeds, { shown: [] })
  assert.match(bare, /\*\*Year established:\*\* Not provided\./)
  assert.match(bare, /\*\*License information:\*\* None provided\./)
  assert.match(bare, /\*\*Social media:\*\* None\. Remove any social icons/)
  assert.match(bare, /\*\*Special offer:\*\* None\./)
  assert.doesNotMatch(bare, /Experience:\*\*|### Reviews|1B\. TRADE CLAIM RULES|Social and Google Business Profile links/)

  const full = plan.buildOneShot(
    facts({ domain: 'panaceahomesllc.com', socialLinks: [{ label: 'Facebook', url: 'https://facebook.com/panacea' }], gbpLink: 'https://g.page/panacea' }),
    fill({ yearStarted: '1988', licenseLine: 'PA HIC #PA123456', promo: '10% off cabinets', tradeClaimRules: ['No "lifetime" claims'] }),
    embeds,
    { shown: [0, 1, 2] },
  )
  assert.match(full, /\*\*Year established:\*\* 1988\. Display as "Serving Montgomery, Bucks, Chester, and Delaware Counties, Pennsylvania since 1988\."/)
  assert.match(full, /\*\*License\/registration:\*\* PA HIC #PA123456\./)
  assert.match(full, /- "PA HIC #PA123456"/)
  assert.match(full, /\*\*Social media:\*\* Facebook: https:\/\/facebook\.com\/panacea/)
  assert.match(full, /### Reviews\n/)
  assert.match(full, /## 1B\. TRADE CLAIM RULES — STRICT\n- No "lifetime" claims/)
  assert.match(full, /- Promo callout: "10% off cabinets"/)
  assert.match(full, /- Social and Google Business Profile links/)
  assert.match(full, /- Canonical URL: https:\/\/panaceahomesllc\.com/)
  assert.ok(full.includes('the quote form at panaceahomesllc.com'))
  assert.doesNotMatch(full, /Not provided|None provided|\*\*Special offer:\*\* None/)
  // No run of blank lines left where blocks dropped out.
  assert.doesNotMatch(bare, /\n\n\n/)
})

test('photos: the ones Claude kept, with what they show; ones it could not see go in as they are', () => {
  const out = plan.buildOneShot(facts(), fill(), embeds, { shown: [0, 1, 2] })
  assert.ok(out.includes(`- ${photo('IMG_1.jpeg')} — a finished kitchen island (use for: Kitchen Remodeling)`))
  assert.ok(out.includes(`- ${photo('IMG_3.jpeg')} — new cabinets being installed (use for: Custom Cabinetry)`))
  assert.ok(!out.includes(photo('IMG_2.jpeg')), 'the screenshot stays out')

  // Photo 2 was too big to show Claude: Claude's "Photo 2" is then IMG_3, and IMG_2 goes in unchecked.
  const kept = plan.keptPhotos(facts().photos, { photos: [{ photo: 1, keep: true, shows: 'a kitchen', useFor: '' }, { photo: 2, keep: true, shows: 'cabinets', useFor: '' }] }, [0, 2])
  assert.deepEqual(kept.map((k) => [k.url.includes('IMG_1') ? 1 : k.url.includes('IMG_2') ? 2 : 3, k.shows]), [[1, 'a kitchen'], [3, 'cabinets'], [2, '']])
  // A photo Claude saw but didn't answer for, or a number out of range, stays out.
  const strict = plan.keptPhotos(facts().photos, { photos: [{ photo: 9, keep: true, shows: 'x', useFor: '' }] }, [0, 1, 2])
  assert.deepEqual(strict, [])

  const none = plan.buildOneShot(facts({ photos: [] }), fill({ photos: [] }), embeds, { shown: [] })
  assert.match(none, /The client has not supplied photos\./)
})

test('a missing phone, email or required answer stops the build before Lovable', () => {
  assert.throws(() => plan.buildOneShot(facts({ phone: null }), fill(), embeds, { shown: [] }), /No phone number/)
  assert.throws(() => plan.buildOneShot(facts({ email: '' }), fill(), embeds, { shown: [] }), /No email address/)
  assert.throws(() => plan.buildOneShot(facts(), fill({ heroHeadline: ' ' }), embeds, { shown: [] }), /missing: hero headline \(HERO_HEADLINE\)/)
  // No location from the answers: said in plain words, once.
  assert.throws(
    () => plan.buildOneShot(facts(), fill({ cityState: '', fullAddress: '', serviceAreaSummary: '', serviceAreaList: [] }), embeds, { shown: [] }),
    /missing: city and state, service area \(FULL_ADDRESS, CITY_STATE, SERVICE_AREA_SUMMARY, SERVICE_AREA_LIST\)/,
  )
})

test('the hero image is named by what it shows, not by a photo number Lovable never sees', () => {
  const vars = plan.oneShotVars(facts(), fill({ heroImage: 'Their photo of a finished bathroom with a corner tub under a window (photo 13).' }), embeds, { shown: [] })
  assert.equal(vars.HERO_IMAGE, 'Their photo of a finished bathroom with a corner tub under a window.')
  assert.equal(plan.oneShotVars(facts(), fill({ heroImage: 'a deck at dusk (photos 2 and 5)' }), embeds, { shown: [] }).HERO_IMAGE, 'a deck at dusk')
})

test('Claude may fix the legal name’s capitals, never its words', () => {
  assert.equal(plan.oneShotVars(facts(), fill(), embeds, { shown: [] }).LEGAL_NAME, 'Panacea Homes LLC')
  assert.equal(plan.oneShotVars(facts(), fill({ legalName: 'Panacea Kitchens LLC' }), embeds, { shown: [] }).LEGAL_NAME, 'Panacea homes llc.')
})

test('uploads: EIN letters, documents and HEIC files are left out by name', () => {
  const { photos, skipped } = plan.pickPhotos([
    photo('IMG_5618.jpeg'),
    photo('cp575-image.jpg'),
    photo('cp575-EIN_Letter_-_Esparza_Solutions_LLC.pdf'),
    photo('JB_BUILDERS.pdf'),
    photo('IMG_0504.heic'),
    photo('image0__3_.png'),
    photo('IMG_5618.jpeg'),
    'not a link',
  ])
  assert.deepEqual(photos.map((p) => p.name), ['IMG_5618.jpeg', 'image0__3_.png'])
  assert.deepEqual(skipped.map((s) => [s.name, s.why.split(' ')[0]]), [
    ['cp575-image.jpg', 'an'],
    ['cp575-EIN_Letter_-_Esparza_Solutions_LLC.pdf', 'an'],
    ['JB_BUILDERS.pdf', 'a'],
    ['IMG_0504.heic', 'an'],
  ])
  assert.equal(plan.pickPhotos([photo('a.jpg'), photo('b.jpg'), photo('c.jpg')], 2).skipped.length, 1)
})

test('phone, domain and link helpers', () => {
  assert.deepEqual(plan.phoneParts('484-362-7127'), { display: '(484) 362-7127', e164: '+14843627127' })
  assert.equal(plan.phoneParts('12345'), null)
  // Two numbers in one answer: the first goes on the site.
  assert.deepEqual(plan.phoneParts('540-555-0101 and 703-555-0199'), { display: '(540) 555-0101', e164: '+15405550101' })
  assert.deepEqual(plan.phoneParts('+1 (540) 555-0101 / cell'), { display: '(540) 555-0101', e164: '+15405550101' })
  assert.equal(plan.firstEmail('owner@acme.com and office@acme.com'), 'owner@acme.com')
  assert.equal(plan.firstEmail('none'), '')
  assert.equal(plan.cleanDomain('https://www.Acme-Roofing.com/contact'), 'acme-roofing.com')
  assert.equal(plan.cleanDomain('no'), null)
  assert.deepEqual(plan.socialLinksFrom('FB: facebook.com/acme.roofing, ig https://instagram.com/acme and none'), [
    { label: 'Facebook', url: 'https://facebook.com/acme.roofing' },
    { label: 'Instagram', url: 'https://instagram.com/acme' },
  ])
  assert.deepEqual(plan.socialLinksFrom('no'), [])
  assert.equal(plan.gbpLinkFrom('here: https://maps.app.goo.gl/abc123.'), 'https://maps.app.goo.gl/abc123')
  assert.equal(plan.gbpLinkFrom('Not sure'), null)
  assert.equal(plan.projectNameFor('  Joseph   Barnett ', 'Panacea Homes'), 'Joseph Barnett')
  assert.equal(plan.projectNameFor('', 'Panacea Homes'), 'Panacea Homes')
  assert.equal(plan.zoneWord('America/Chicago'), 'Central')
})

test('who Forge asks', () => {
  const since = new Date('2026-11-13T12:00:00Z')
  const base = { archived: false, accountId: 'acc', siteLive: false, ghlLinked: false, request: null, trigger: 'onboarding', accountCreatedAt: new Date('2026-11-13T13:00:00Z'), since }
  assert.equal(plan.siteAskDecision(base).ask, true)
  assert.equal(plan.siteAskDecision({ ...base, ghlLinked: true }).ask, false, 'set up in GHL')
  assert.equal(plan.siteAskDecision({ ...base, ghlLinked: true, trigger: 'manual' }).ask, false, 'by hand needs the override')
  assert.equal(plan.siteAskDecision({ ...base, ghlLinked: true, trigger: 'manual', overrideGhl: true }).ask, true)
  assert.equal(plan.siteAskDecision({ ...base, siteLive: true }).ask, false)
  assert.equal(plan.siteAskDecision({ ...base, accountId: null }).ask, false)
  assert.equal(plan.siteAskDecision({ ...base, trigger: 'sweep', accountCreatedAt: new Date('2026-11-01T00:00:00Z') }).ask, false, 'older sub-accounts aren’t swept in')
  for (const status of ['awaiting_approval', 'filling', 'copying', 'sending', 'building', 'waiting_on_lovable', 'publishing']) {
    assert.equal(plan.siteAskDecision({ ...base, trigger: 'manual', request: { status } }).ask, false, status)
  }
  for (const status of ['declined', 'failed', 'built', 'held', 'published']) {
    assert.equal(plan.siteAskDecision({ ...base, request: { status } }).ask, false, `${status} isn't asked again by itself`)
    assert.equal(plan.siteAskDecision({ ...base, trigger: 'manual', request: { status } }).ask, true, `${status} can be asked again by hand`)
  }
})

test('the question says what the site will get', () => {
  assert.equal(
    plan.siteQuestionDetail({ photos: 12, skipped: 1, domain: null, phoneSource: 'own', numberAsked: true, domainAsked: true, missing: [] }),
    '12 photos from onboarding (1 other upload left out). No domain yet: answer Forge’s domain question first to put it in the site. Their own phone goes on the site: answer Echo’s toll-free question first to use that number.',
  )
  assert.match(plan.siteQuestionDetail({ photos: 0, skipped: 0, domain: 'acme.com', phoneSource: 'toll_free', numberAsked: false, domainAsked: false, missing: [] }), /^No photos: Lovable makes them all\. Domain acme\.com\. Their toll-free number goes on the site\.$/)
  assert.match(plan.siteQuestionDetail({ photos: 3, skipped: 0, domain: null, phoneSource: null, numberAsked: false, domainAsked: false, missing: ['phone number'] }), /^Can’t build yet: no phone number on file/)
})

test('the form embed sizes each copy on the page from its own frame', () => {
  const code = embed.embedCode(ORIGIN, quote)
  assert.match(code, /<iframe src="https:\/\/genisys-hub\.onrender\.com\/hl\/f\/form_quote_1" id="hl-form-form_quote_1"/)
  assert.match(code, /querySelectorAll\('iframe\[id="hl-form-form_quote_1"\]'\)/)
  assert.match(code, /el\.contentWindow===e\.source/)
  assert.equal(embed.embedCode(ORIGIN, chat), '<script src="https://genisys-hub.onrender.com/hl/widget.js" data-form="form_chat_1" async></script>')
})

test('the template has no unknown variables and every block closes', () => {
  const names = [...template.ONE_SHOT_TEMPLATE.matchAll(/\{\{([A-Z0-9_]+)\}\}/g)].map((m) => m[1])
  for (const n of names) assert.ok(template.ONE_SHOT_VARIABLES.includes(n), n)
  const opens = (template.ONE_SHOT_TEMPLATE.match(/\[IF /g) ?? []).length
  const closes = (template.ONE_SHOT_TEMPLATE.match(/\[\/IF\]/g) ?? []).length
  assert.equal(opens, closes)
})

// ---------------------------------------------------------------------------
// The Office
// ---------------------------------------------------------------------------

const NOW = new Date('2026-11-13T20:00:00Z')
const ago = (min) => new Date(NOW.getTime() - min * 60_000)

test('Forge asks "Build X’s website?" in the Office, apart from Echo', () => {
  const input = mapping.emptyInput()
  input.approvals = [{ id: 'sr1', kind: 'site', clientName: 'Acme Roofing', at: ago(5), stage: 'ask', detail: '3 photos from onboarding.', reviewLink: '/sites/c1' }]
  const s = mapping.deriveOffice(input, NOW)
  const a = s.approvals.find((x) => x.id === 'sr1')
  assert.equal(a.botId, 'forge')
  assert.equal(a.kind, 'site')
  assert.equal(a.question, 'Build Acme Roofing’s website?')
  assert.equal(a.reviewLink, '/sites/c1')
  assert.equal(s.bots.find((b) => b.id === 'forge').status, 'needs_you')
  assert.equal(s.bots.find((b) => b.id === 'echo').status, 'idle')
})

test('Forge shows the build as it goes, and what a person does next', () => {
  const row = (over) => ({ id: 'sr1', clientId: 'c1', clientName: 'Acme Roofing', status: 'building', detail: null, editorUrl: 'https://lovable.dev/projects/p1', siteLive: false, stepAt: ago(3), finishedAt: null, updatedAt: ago(1), ...over })
  const forge = (r) => {
    const input = mapping.emptyInput()
    input.siteRequests = [r]
    const s = mapping.deriveOffice(input, NOW)
    return { bot: s.bots.find((b) => b.id === 'forge'), requests: s.requests, activity: s.activity }
  }
  assert.equal(forge(row({ status: 'filling' })).bot.status, 'thinking')
  assert.equal(forge(row({ status: 'copying' })).bot.status, 'browsing')
  const building = forge(row({}))
  assert.equal(building.bot.status, 'coding')
  assert.match(building.bot.task, /Lovable is building Acme Roofing’s website/)

  const waiting = forge(row({ status: 'waiting_on_lovable', detail: 'Lovable paused for a person.' }))
  assert.equal(waiting.bot.status, 'needs_you')
  assert.equal(waiting.requests[0].link, 'https://lovable.dev/projects/p1')

  // Built: the next step is Forge's Publish question (an approval), not a request.
  const built = forge(row({ status: 'built', finishedAt: ago(2) }))
  assert.equal(built.requests.length, 0)
  assert.match(built.bot.task, /Built Acme Roofing’s website in Lovable/)

  const publishing = forge(row({ status: 'publishing', stepAt: ago(1) }))
  assert.equal(publishing.bot.status, 'browsing')
  assert.match(publishing.bot.task, /Publishing Acme Roofing’s website/)

  const published = forge(row({ status: 'published', liveUrl: 'https://acme-roofing.lovable.app', publishedAt: ago(2), detail: 'Live at https://acme-roofing.lovable.app.' }))
  assert.equal(published.requests.length, 1)
  assert.equal(published.requests[0].kind, 'stuck')
  assert.match(published.requests[0].text, /live at https:\/\/acme-roofing\.lovable\.app but has no domain yet\. Answer Forge’s domain question for them, or add theirs in Hell-level → Domains/)
  assert.ok(published.activity.some((x) => /Published Acme Roofing’s website at https:\/\/acme-roofing\.lovable\.app/.test(x.text)))
  assert.equal(forge(row({ status: 'published', liveUrl: 'https://acme-roofing.lovable.app', publishedAt: ago(2), siteLive: true })).requests.length, 0, 'gone once the link is saved')
  const noPages = forge(row({ status: 'published', liveUrl: 'https://acme-roofing.lovable.app', publishedAt: ago(2), detail: 'Live at https://acme-roofing.lovable.app. Its /privacy page didn’t load, and the form and chat link them: look in Lovable.' }))
  assert.ok(noPages.requests.some((x) => x.kind === 'error' && /privacy or terms page didn’t load/.test(x.text)))

  const failed = forge(row({ status: 'failed', detail: 'Lovable couldn’t copy the template.' }))
  assert.equal(failed.bot.status, 'error')
  assert.equal(failed.requests[0].kind, 'error')
})

test('Forge asks "Publish X’s website?" once Lovable built it', () => {
  const input = mapping.emptyInput()
  input.approvals = [
    { id: 'sr1', kind: 'site', clientName: 'Acme Roofing', at: ago(5), stage: 'publish', detail: 'Claude’s notes to check: two photos show a person.', reviewLink: 'https://lovable.dev/projects/p1' },
  ]
  const s = mapping.deriveOffice(input, NOW)
  const a = s.approvals.find((x) => x.id === 'sr1')
  assert.equal(a.botId, 'forge')
  assert.equal(a.kind, 'site')
  assert.equal(a.stage, 'publish')
  assert.equal(a.question, 'Publish Acme Roofing’s website?')
  assert.match(a.note, /Look it over in Lovable first/)
  assert.equal(a.reviewLink, 'https://lovable.dev/projects/p1')
  assert.match(s.bots.find((b) => b.id === 'forge').task, /Asking: publish Acme Roofing’s website\?/)
  assert.equal(s.bots.find((b) => b.id === 'echo').status, 'idle')
})

test('the lovable.app name is the business name', () => {
  assert.equal(plan.publishSlug('Acme Roofing & Gutters, LLC'), 'acme-roofing-and-gutters')
  assert.equal(plan.publishSlug('American Home Innovations'), 'american-home-innovations')
  assert.equal(plan.publishSlug('Bob’s Décor Co.'), 'bobs-decor')
  assert.equal(plan.publishSlug('J.R. Painting (Tampa)'), 'j-r-painting')
  assert.equal(plan.publishSlug('LLC'), null)
  assert.ok(plan.publishSlug('A'.repeat(80)).length <= 48)
})

test('on the site Forge built, the form and chat link that site’s own policy pages', () => {
  const own = ['americanhomeinnovations.com']
  const hub = ['genisys-hub.onrender.com']
  // The copy's preview, its published lovable.app address, and their own domain (with or without www).
  assert.deepEqual(plan.builtSiteLegal('https://id-preview--d0db55f2-a49e-4355-95fc-83f47958d5e6.lovable.app/', own, hub), {
    privacy: 'https://id-preview--d0db55f2-a49e-4355-95fc-83f47958d5e6.lovable.app/privacy',
    terms: 'https://id-preview--d0db55f2-a49e-4355-95fc-83f47958d5e6.lovable.app/terms',
  })
  assert.equal(plan.builtSiteLegal('https://american-home-innovations.lovable.app/contact?x=1', own, hub).privacy, 'https://american-home-innovations.lovable.app/privacy')
  assert.equal(plan.builtSiteLegal('https://www.americanhomeinnovations.com/', own, hub).terms, 'https://www.americanhomeinnovations.com/terms')
  assert.equal(plan.builtSiteLegal('https://d0db55f2.lovableproject.com/', own, hub).terms, 'https://d0db55f2.lovableproject.com/terms')
  // Anywhere else, or no Referer: the usual links.
  assert.equal(plan.builtSiteLegal('https://someone-else.com/', own, hub), null)
  assert.equal(plan.builtSiteLegal('https://genisys-hub.onrender.com/hl/f/abc', own, hub), null)
  assert.equal(plan.builtSiteLegal('https://lovable.dev/projects/p1', own, hub), null)
  assert.equal(plan.builtSiteLegal('https://notlovable.app.evil.com/', own, hub), null)
  assert.equal(plan.builtSiteLegal(null, own, hub), null)
  assert.equal(plan.builtSiteLegal('not a url', own, hub), null)
  assert.equal(plan.bareHost('https://WWW.Acme.com/x'), 'acme.com')
  assert.equal(plan.bareHost('acme.com'), 'acme.com')
  assert.equal(plan.bareHost(''), null)
})

test('forms and chat never link the Hub’s policy pages', () => {
  const isHub = (u) => /genisys-hub\.onrender\.com/.test(u)
  const hub = { privacy: 'https://genisys-hub.onrender.com/hl/legal/acc/privacy', terms: 'https://genisys-hub.onrender.com/hl/legal/acc/terms' }
  const site = { privacy: 'https://acme.com/privacy', terms: 'https://acme.com/terms' }
  // The form's own links first, then the site it's on, the profile, the published site.
  assert.deepEqual(plan.firstOwnLinks([{ privacy: 'https://own.com/p', terms: '' }, site], isHub), { privacy: 'https://own.com/p', terms: 'https://acme.com/terms' })
  assert.deepEqual(plan.firstOwnLinks([null, undefined, site], isHub), site)
  // A Hub page is skipped wherever it comes from; with nothing else, no link.
  assert.deepEqual(plan.firstOwnLinks([hub, site], isHub), site)
  assert.deepEqual(plan.firstOwnLinks([hub], isHub), { privacy: null, terms: null })
  assert.deepEqual(plan.firstOwnLinks([{ privacy: 'not a link', terms: '  ' }], isHub), { privacy: null, terms: null })
})

test('the domain Forge connects: one held here first, then one whose DNS is elsewhere', () => {
  assert.deepEqual(plan.siteDomainChoice([]), null)
  assert.deepEqual(plan.siteDomainChoice([{ name: 'acme.com', origin: 'bought', status: 'active' }]), { name: 'acme.com', managed: true })
  assert.deepEqual(plan.siteDomainChoice([{ name: 'acme.com', origin: 'transfer', status: 'held' }]), { waiting: 'acme.com' })
  assert.deepEqual(plan.siteDomainChoice([{ name: 'old.com', origin: 'external', status: 'active' }]), { name: 'old.com', managed: false })
  assert.deepEqual(
    plan.siteDomainChoice([
      { name: 'old.com', origin: 'external', status: 'active' },
      { name: 'acme.com', origin: 'bought', status: 'active' },
    ]),
    { name: 'acme.com', managed: true },
    'one held here wins',
  )
  assert.deepEqual(plan.siteDomainChoice([{ name: 'acme.com', origin: 'bought', status: 'failed' }]), null)
})

test('Lovable is asked to connect the domain without buying anything, and its codes are read back', () => {
  const m = plan.domainConnectMessage('acme.com', true)
  assert.match(m, /Connect my custom domain acme\.com/)
  assert.match(m, /don't buy a domain, don't move its nameservers/)
  assert.match(m, /Porkbun/)
  assert.doesNotMatch(plan.domainConnectMessage('acme.com', false), /Porkbun/)

  const table = ['| Type | Host | Value |', '| A | @ | 185.158.133.1 |', '| TXT | _lovable | lovable_verify=abc123 |', '| TXT | _lovable.www | lovable_verify=www456 |'].join('\n')
  assert.deepEqual(plan.lovableVerifyCodes(table), { rootTxt: 'lovable_verify=abc123', wwwTxt: 'lovable_verify=www456' })
  assert.deepEqual(plan.lovableVerifyCodes('Add a TXT record with lovable_verify=onlyone.'), { rootTxt: 'lovable_verify=onlyone', wwwTxt: null }, 'a full stop isn’t part of the code')
  assert.deepEqual(plan.lovableVerifyCodes('| TXT | _lovable | lovable_verify=a1.b2 |'), { rootTxt: 'lovable_verify=a1.b2', wwwTxt: null })
  assert.deepEqual(plan.lovableVerifyCodes('first lovable_verify=a1 then lovable_verify=b2'), { rootTxt: 'lovable_verify=a1', wwwTxt: 'lovable_verify=b2' })
  assert.deepEqual(plan.lovableVerifyCodes('Done! Your domain is connecting.'), { rootTxt: null, wwwTxt: null })

  // Only a connect of exactly that domain is approved for the person who said Yes.
  assert.equal(plan.approvesDomainConnect('connect_custom_domain', { domain: 'acme.com' }, 'acme.com'), true)
  assert.equal(plan.approvesDomainConnect('buy_domain', { domain: 'acme.com' }, 'acme.com'), false)
  assert.equal(plan.approvesDomainConnect('connect_custom_domain', { domain: 'other.com' }, 'acme.com'), false)
  assert.equal(plan.approvesDomainConnect('connect_custom_domain', { domain: 'acme.com', nameservers: 'lovable' }, 'acme.com'), false)
  assert.equal(plan.approvesDomainConnect('set_secret', { name: 'acme.com' }, 'acme.com'), false)
})

test('Forge asks to connect the domain once the site is live, and shows it through', () => {
  const ask = mapping.emptyInput()
  ask.approvals = [{ id: 'sr1', kind: 'site', clientName: 'Acme Roofing', at: ago(5), stage: 'domain', reviewLink: '/hell-level/acc1/settings?tab=domains', siteDomain: { name: 'acme.com', managed: true } }]
  const a = mapping.deriveOffice(ask, NOW).approvals.find((x) => x.id === 'sr1')
  assert.equal(a.stage, 'domain')
  assert.equal(a.question, 'Connect acme.com to Acme Roofing’s website?')
  assert.match(a.note, /sets its DNS at Porkbun/)
  assert.match(a.note, /saves it as their site link in Clients/)

  const pub = mapping.emptyInput()
  pub.approvals = [{ id: 'sr2', kind: 'site', clientName: 'Acme Roofing', at: ago(5), stage: 'publish', reviewLink: 'https://lovable.dev/projects/p1', siteDomain: { name: 'acme.com', managed: true } }]
  assert.match(mapping.deriveOffice(pub, NOW).approvals.find((x) => x.id === 'sr2').note, /then connects acme\.com/)

  const row = (over) => ({ id: 'sr1', clientId: 'c1', accountId: 'acc1', clientName: 'Acme Roofing', status: 'connecting', detail: null, editorUrl: 'https://lovable.dev/projects/p1', siteLive: false, stepAt: ago(30), finishedAt: ago(40), updatedAt: ago(1), domain: 'acme.com', domainStepAt: ago(2), ...over })
  const forge = (r) => {
    const input = mapping.emptyInput()
    input.siteRequests = [r]
    const s = mapping.deriveOffice(input, NOW)
    return { bot: s.bots.find((b) => b.id === 'forge'), requests: s.requests, activity: s.activity }
  }
  const lovable = forge(row({ domainStep: 'lovable' }))
  assert.equal(lovable.bot.status, 'browsing')
  assert.match(lovable.bot.task, /Connecting acme\.com to Acme Roofing’s website in Lovable/)
  const records = forge(row({ domainStep: 'records', detail: 'Add these DNS records for acme.com where its DNS is managed: A acme.com → 185.158.133.1.' }))
  assert.equal(records.bot.status, 'needs_you')
  assert.equal(records.requests[0].link, '/hell-level/acc1/settings?tab=domains')
  assert.match(records.requests[0].text, /Add these DNS records for acme\.com/)
  const live = forge(row({ domainStep: 'live' }))
  assert.match(live.bot.task, /Waiting for acme\.com to show Acme Roofing’s website/)
  const connected = forge(row({ status: 'connected', domainStep: null, domainAt: ago(3), siteLive: true }))
  assert.ok(connected.activity.some((x) => /acme\.com now shows Acme Roofing’s website/.test(x.text)))
  assert.ok(connected.requests.some((x) => /Connect GitHub in Lovable/.test(x.text)))
  assert.equal(forge(row({ status: 'connected', domainStep: null, domainAt: ago(3), siteLive: true, repoLinked: true })).requests.length, 0, 'nothing left once GitHub is in')
  const failed = forge(row({ status: 'published', domainStep: null, liveUrl: 'https://acme-roofing.lovable.app', publishedAt: ago(60), detail: 'Connecting acme.com didn’t finish: Lovable stopped.', readyDomain: { name: 'acme.com', managed: true } }))
  assert.ok(failed.requests.some((x) => x.kind === 'error' && /Connecting acme\.com didn’t finish/.test(x.text)))
})
