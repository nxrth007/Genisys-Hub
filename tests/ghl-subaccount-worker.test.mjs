import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import ts from 'typescript'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const cache = new Map()

function loadTs(absPath) {
  if (cache.has(absPath)) return cache.get(absPath)
  const source = readFileSync(absPath, 'utf8')
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  })
  const m = { exports: {} }
  const localRequire = createRequire(pathToFileURL(absPath))
  const req = (id) => {
    if (id.startsWith('.')) {
      const target = join(dirname(absPath), id.endsWith('.ts') ? id : `${id}.ts`)
      return loadTs(target)
    }
    if (id.startsWith('@/')) {
      const rel = id.slice(2)
      const target = join(root, 'src', rel.endsWith('.ts') ? rel : `${rel}.ts`)
      return loadTs(target)
    }
    return localRequire(id)
  }
  new Function('module', 'exports', 'require', outputText)(m, m.exports, req)
  cache.set(absPath, m.exports)
  return m.exports
}

const dir = join(root, 'src/lib/ghl-subaccount-worker')
const config = loadTs(join(dir, 'config.ts'))
const labelsMod = loadTs(join(dir, 'labels.ts'))
const fieldsMod = loadTs(join(dir, 'fields.ts'))
const eligibility = loadTs(join(dir, 'eligibility.ts'))
const trigger = loadTs(join(dir, 'trigger.ts'))
const session = loadTs(join(dir, 'session.ts'))
const plan = loadTs(join(dir, 'plan.ts'))
const pageSource = loadTs(join(dir, 'page-source.ts'))
const chromiumHost = loadTs(join(dir, 'chromium-host.ts'))
const otpMail = loadTs(join(dir, 'otp-mail.ts'))

const {
  workerEnabled,
  workerRunsBrowser,
  workerMode,
  retryDelayMs,
  MAX_ATTEMPTS,
  subAccountListUrl,
  listUrlOverride,
  parseAgencyLogin,
} = config
const { ghlLabels } = labelsMod
const { browserFieldsFromLocation, readBrowserFields } = fieldsMod
const { autoEnqueueAllowed, intakeTimeKnown } = eligibility
const { secretMatches, parseTriggerBody } = trigger
const { sealString, openString } = session
const { nextGhlAction, driveUntil, initialRunState, locationIdFromUrl, pageDiagnostics, isAgencyHome, listCandidates, snapshotTabPlan, exactSnapshotCard } = plan

function env(overrides) {
  return overrides
}

test('worker stays off, and dry-run, until the env says otherwise', () => {
  assert.equal(workerEnabled(env({})), false)
  assert.equal(workerEnabled(env({ GHL_SUBACCOUNT_WORKER_ENABLED: ' On ' })), true)
  assert.equal(workerEnabled(env({ GHL_SUBACCOUNT_WORKER_ENABLED: 'yes' })), true)
  assert.equal(workerEnabled(env({ GHL_SUBACCOUNT_WORKER_ENABLED: '0' })), false)
  assert.equal(workerRunsBrowser(env({})), false)
  assert.equal(workerRunsBrowser(env({ GHL_SUBACCOUNT_WORKER_ENABLED: '1' })), true)
  assert.equal(workerRunsBrowser(env({ GHL_SUBACCOUNT_WORKER_ENABLED: '1', GHL_SUBACCOUNT_WORKER_RUN: '0' })), false)
  assert.equal(workerMode(env({ GHL_SUBACCOUNT_WORKER_ENABLED: '1' })), 'dry_run')
  assert.equal(workerMode(env({ GHL_SUBACCOUNT_WORKER_MODE: 'create' })), 'create')
  assert.equal(workerMode(env({ GHL_SUBACCOUNT_WORKER_MODE: 'CREATE' })), 'create')
  assert.equal(subAccountListUrl('https://app.gohighlevel.com/agency'), 'https://app.gohighlevel.com/sub-accounts')
  assert.equal(subAccountListUrl('not a url'), 'https://app.gohighlevel.com/sub-accounts')
  assert.equal(listUrlOverride({}), '')
  assert.equal(listUrlOverride({ GHL_SUBACCOUNT_LIST_URL: ' https://app.gohighlevel.com/agency/sub-accounts ' }), 'https://app.gohighlevel.com/agency/sub-accounts')
})

test('retries back off and then stop', () => {
  assert.equal(retryDelayMs(1), 2 * 60_000)
  assert.equal(retryDelayMs(2), 4 * 60_000)
  assert.equal(retryDelayMs(5), 32 * 60_000)
  assert.equal(retryDelayMs(10), 60 * 60_000)
  assert.equal(MAX_ATTEMPTS, 5)
})

test('webhook secret compare does not treat a shorter secret as a prefix', () => {
  assert.equal(secretMatches('abc', 'abc'), true)
  assert.equal(secretMatches('abc', 'abd'), false)
  assert.equal(secretMatches('abc', 'abcd'), false)
  assert.equal(secretMatches('', 'abc'), false)
  assert.equal(secretMatches('abc', ''), false)
})

test('trigger body accepts a client, a code, an intake, or a Supabase insert', () => {
  assert.deepEqual(parseTriggerBody({ clientId: 'c1', force: true }), { kind: 'client', clientId: 'c1', force: true })
  assert.equal(parseTriggerBody({ clientId: 'c1' }).force, false)
  assert.deepEqual(parseTriggerBody({ otp: ' 123456 ', clientId: 'c1' }), { kind: 'otp', code: '123456', clientId: 'c1' })
  const intake = parseTriggerBody({ event: 'intake.submitted', answers: { businessName: 'J&R' } })
  assert.equal(intake.kind, 'intake')
  const supa = parseTriggerBody({ type: 'INSERT', record: { businessName: 'J&R', created_at: '2026-11-11T00:00:00Z' } })
  assert.equal(supa.kind, 'intake')
  assert.equal(supa.body.answers.businessName, 'J&R')
  assert.equal(supa.body.submittedAt, '2026-11-11T00:00:00Z')
  assert.equal(parseTriggerBody({ hello: true }).kind, 'invalid')
  assert.equal(parseTriggerBody(null).kind, 'invalid')
})

test('only a new, dated submission after the cutoff is queued', () => {
  const since = new Date('2026-11-11T12:00:00Z')
  const base = {
    receivedAt: new Date('2026-11-11T12:05:00Z'),
    since,
    timeKnown: true,
    createdNewClient: true,
    hasLocation: false,
    phoneNamed: false,
  }
  assert.equal(autoEnqueueAllowed(base).ok, true)
  assert.equal(autoEnqueueAllowed({ ...base, receivedAt: new Date('2026-11-01T00:00:00Z') }).ok, false)
  assert.equal(autoEnqueueAllowed({ ...base, timeKnown: false }).ok, false)
  assert.equal(autoEnqueueAllowed({ ...base, createdNewClient: false }).ok, false)
  assert.equal(autoEnqueueAllowed({ ...base, hasLocation: true }).ok, false)
  assert.equal(autoEnqueueAllowed({ ...base, phoneNamed: true }).ok, false)
  assert.equal(intakeTimeKnown({ event: 'intake.submitted' }), true)
  assert.equal(intakeTimeKnown({ submittedAt: '2026-11-11T00:00:00Z' }), true)
  assert.equal(intakeTimeKnown({}), false)
  assert.equal(intakeTimeKnown(null), false)
})

test('form fields follow the API payload, with United States spelled out', () => {
  const fields = browserFieldsFromLocation(
    {
      name: 'Randy: J&R Painting',
      snapshotId: 'snap1',
      phone: '+15551230000',
      country: 'US',
      city: 'Tampa',
      prospectInfo: { firstName: 'Randy', lastName: 'Smith', email: 'randy@example.com' },
    },
    { snapshotName: 'Onboarding' },
  )
  assert.equal(fields.country, 'United States')
  assert.equal(fields.name, 'Randy: J&R Painting')
  assert.equal(fields.email, 'randy@example.com')
  assert.equal(fields.snapshotName, 'Onboarding')
  assert.equal(readBrowserFields(fields).phone, '+15551230000')
  assert.equal(readBrowserFields({ snapshotId: 'x' }), null)
  assert.equal(readBrowserFields(null), null)
})

test('agency login parses JSON or two lines and rejects a bare password', () => {
  assert.deepEqual(parseAgencyLogin('{"email":"a@b.co","password":"s3cret"}'), { email: 'a@b.co', password: 's3cret' })
  assert.deepEqual(parseAgencyLogin('a@b.co\ns3cret'), { email: 'a@b.co', password: 's3cret' })
  assert.equal(parseAgencyLogin('not-an-email'), null)
  assert.equal(parseAgencyLogin(''), null)
})

test('label overrides replace a key and a bad blob keeps the defaults', () => {
  const custom = ghlLabels('{"submit":["Make it"]}')
  assert.deepEqual(custom.submit, ['Make it'])
  assert.ok(custom.name.includes('Business Name'))
  assert.deepEqual(ghlLabels('{'), ghlLabels(null))
  assert.deepEqual(ghlLabels('{"submit":"Create"}').submit, ghlLabels().submit)
})

test('the browser session round-trips through the vault cipher', () => {
  process.env.VAULT_MASTER_KEY = Buffer.alloc(32, 7).toString('base64')
  const sealed = sealString('{"cookies":[{"name":"sid","value":"abc"}]}')
  assert.equal(sealed.includes('abc'), false)
  assert.equal(openString(sealed), '{"cookies":[{"name":"sid","value":"abc"}]}')
  assert.equal(openString('nope'), null)
  assert.equal(openString(''), null)
})

function input(mode = 'dry_run') {
  return {
    fields: browserFieldsFromLocation(
      {
        name: 'Randy: J&R Painting',
        snapshotId: 'pHagdFFJPsZBnn8ACSHK',
        phone: '+15551230000',
        country: 'US',
        prospectInfo: { firstName: 'Randy', lastName: 'Smith', email: 'randy@example.com' },
      },
      { snapshotName: 'Onboarding' },
    ),
    mode,
    labels: ghlLabels(),
    hasCredentials: true,
    loginEmail: 'agency@leadgenisys.com',
    hasOtp: false,
    listUrl: 'https://app.gohighlevel.com/sub-accounts',
  }
}

function snap(over) {
  return {
    url: 'https://app.gohighlevel.com/sub-accounts',
    fields: [],
    buttons: [],
    texts: [],
    links: [],
    body: '',
    ...over,
  }
}

test('a signed-out page asks for the login and never puts the password in the plan', () => {
  const login = snap({
    url: 'https://app.gohighlevel.com/login',
    fields: [
      { key: 'email', tag: 'input', type: 'email', value: '', text: 'email' },
      { key: 'password', tag: 'input', type: 'password', value: '', text: 'password' },
    ],
    buttons: ['Sign in'],
    body: 'sign in to your account',
  })
  const blocked = nextGhlAction(login, { ...input(), hasCredentials: false }, initialRunState())
  assert.equal(blocked.kind, 'done')
  assert.equal(blocked.result.status, 'needs_human')
  const step = nextGhlAction(login, input(), initialRunState())
  assert.equal(step.kind, 'action')
  assert.equal(step.action.type, 'fill')
  assert.equal(step.action.key, 'email')
  assert.equal(step.action.value, 'agency@leadgenisys.com')
  const next = nextGhlAction(login, input(), step.state)
  assert.equal(next.action.key, 'password')
  assert.equal(next.action.value, undefined)
  assert.equal(JSON.stringify(next.action).includes('password-value'), false)
})

test('a verification prompt waits instead of guessing', () => {
  const otp = snap({
    url: 'https://app.gohighlevel.com/login/verify',
    fields: [{ key: 'otp', tag: 'input', type: 'text', value: '', text: 'code' }],
    body: 'enter the verification code we sent',
  })
  const step = nextGhlAction(otp, input(), initialRunState())
  assert.equal(step.action.type, 'wait_otp')
})

test('an existing sub-account with the same name is not created again', () => {
  const list = snap({
    buttons: ['Create Sub-Account'],
    links: [{ text: 'Randy: J&R Painting', href: 'https://app.gohighlevel.com/v2/location/AbCdEfGhIj12/dashboard' }],
  })
  const step = nextGhlAction(list, input('create'), initialRunState())
  assert.equal(step.kind, 'done')
  assert.equal(step.result.status, 'already')
  assert.equal(step.result.locationId, 'AbCdEfGhIj12')
  assert.equal(locationIdFromUrl(list.links[0].href), 'AbCdEfGhIj12')
})

test('dry run fills the form and does not press Create', async () => {
  const form = snap({
    buttons: ['Create Sub-Account', 'Create'],
    fields: [
      { key: 'name', tag: 'input', type: 'text', value: '', text: 'business name' },
      { key: 'email', tag: 'input', type: 'email', value: '', text: 'email' },
      { key: 'phone', tag: 'input', type: 'tel', value: '', text: 'phone' },
      { key: 'snapshot', tag: 'input', type: 'text', value: '', text: 'snapshot' },
    ],
  })
  const actions = []
  const result = await driveUntil(
    {
      snapshot: async () => form,
      perform: async (action) => {
        actions.push(action)
      },
      pullOtp: async () => null,
      onOtpPrompt: async () => {},
    },
    input('dry_run'),
  )
  assert.equal(result.status, 'dry_run')
  assert.equal(result.detail.includes('Randy: J&R Painting'), true)
  assert.equal(actions.some((a) => a.type === 'fill' && a.key === 'name' && a.value === 'Randy: J&R Painting'), true)
  assert.equal(actions.some((a) => a.type === 'pick' && a.key === 'snapshot' && a.value === 'Onboarding'), true)
  assert.equal(actions.some((a) => a.type === 'click' && a.exact), false)
})

test('create mode presses Create, and a location url afterwards is success', async () => {
  let submitted = false
  const form = () =>
    snap({
      url: submitted
        ? 'https://app.gohighlevel.com/v2/location/NewLocation1/dashboard'
        : 'https://app.gohighlevel.com/sub-accounts',
      buttons: ['Create'],
      fields: submitted
        ? []
        : [
            { key: 'name', tag: 'input', type: 'text', value: 'Randy: J&R Painting', text: 'business name' },
            { key: 'snapshot', tag: 'input', type: 'text', value: 'Onboarding', text: 'snapshot' },
          ],
    })
  const actions = []
  const result = await driveUntil(
    {
      snapshot: async () => form(),
      perform: async (action) => {
        actions.push(action)
        if (action.type === 'click' && action.exact) submitted = true
      },
      pullOtp: async () => null,
      onOtpPrompt: async () => {},
    },
    input('create'),
  )
  assert.equal(result.status, 'created')
  assert.equal(result.locationId, 'NewLocation1')
  assert.equal(actions.some((a) => a.type === 'click' && a.exact && a.words.includes('Create')), true)
})

test('a page with none of the form stops for a person', async () => {
  const result = await driveUntil(
    {
      snapshot: async () => snap({ url: 'https://app.gohighlevel.com/sub-accounts', body: 'welcome' }),
      perform: async () => {},
      pullOtp: async () => null,
      onOtpPrompt: async () => {},
    },
    input('create'),
  )
  assert.equal(result.status, 'needs_human')
  assert.match(result.detail, /Couldn't find the create-sub-account form/)
  assert.match(result.detail, /https:\/\/app\.gohighlevel\.com\/sub-accounts/)
  assert.match(result.detail, /buttons:/)
})

test('a code that arrives while the prompt is up gets typed', async () => {
  let polls = 0
  const prompted = []
  const otpPage = snap({
    url: 'https://app.gohighlevel.com/login/verify',
    fields: [{ key: 'otp', tag: 'input', type: 'text', value: '', text: 'code' }],
    body: 'enter the verification code',
  })
  const actions = []
  let now = 0
  const result = await driveUntil(
    {
      snapshot: async () => otpPage,
      perform: async (action) => {
        actions.push(action)
      },
      pullOtp: async () => {
        polls += 1
        now += 1000
        return polls >= 2 ? '654321' : null
      },
      onOtpPrompt: async (detail) => {
        prompted.push(detail)
      },
    },
    input('create'),
    { now: () => now },
  )
  assert.equal(prompted.length, 1)
  assert.equal(actions.some((a) => a.type === 'fill_otp'), true)
  assert.equal(actions.some((a) => a.type === 'press_enter'), true)
  assert.equal(actions.some((a) => a.type === 'click_verify'), true)
  assert.equal(result.status, 'needs_human')
  assert.match(result.detail, /did not leave the code screen/)
  assert.match(result.detail, /buttons:/)
  assert.doesNotMatch(result.detail, /654321/)
})

test('bundled Chromium libraries are prepended, and the launch stays small', () => {
  const { prependLibraryPath, missingBundledSonames, chromiumLaunchArgs, systemChromium, prepareChromiumEnv } = chromiumHost
  assert.equal(prependLibraryPath(undefined, []), undefined)
  assert.equal(prependLibraryPath('/usr/lib', ['/app/.chromium-libs/usr/lib']), '/app/.chromium-libs/usr/lib:/usr/lib')
  assert.equal(prependLibraryPath('/app/.chromium-libs/usr/lib', ['/app/.chromium-libs/usr/lib']), '/app/.chromium-libs/usr/lib')
  assert.deepEqual(missingBundledSonames(['libc.so.6', 'libnss3.so'], new Set()), ['libnss3.so'])
  assert.deepEqual(missingBundledSonames(['libnss3.so'], new Set(['libnss3.so'])), [])
  assert.ok(chromiumLaunchArgs().includes('--disable-dev-shm-usage'))
  assert.ok(chromiumLaunchArgs().includes('--renderer-process-limit=1'))
  assert.equal(systemChromium({}), false)
  assert.equal(systemChromium({ GHL_SUBACCOUNT_CHROMIUM: 'system' }), true)
  const env = {}
  prepareChromiumEnv('/tmp/does-not-exist-chromium-libs', env)
  assert.equal(env.PLAYWRIGHT_BROWSERS_PATH, '0')
  assert.equal(env.LD_LIBRARY_PATH, undefined)
  const system = { GHL_SUBACCOUNT_CHROMIUM: 'system' }
  prepareChromiumEnv(process.cwd(), system)
  assert.equal(system.PLAYWRIGHT_BROWSERS_PATH, undefined)
})

test('chromium install does nothing off Render, and nothing when the worker is off', () => {
  const script = join(root, 'scripts/install-render-chromium.mjs')
  const run = (extra) =>
    spawnSync(process.execPath, [script], {
      encoding: 'utf8',
      env: { ...process.env, RENDER: '', GHL_SUBACCOUNT_WORKER_ENABLED: '', GHL_SUBACCOUNT_CHROMIUM: '', ...extra },
    })
  const local = run({ RENDER: '', GHL_SUBACCOUNT_WORKER_ENABLED: '1' })
  assert.equal(local.status, 0)
  assert.match(local.stdout, /not a Render build/)
  const off = run({ RENDER: 'true', GHL_SUBACCOUNT_WORKER_ENABLED: '' })
  assert.equal(off.status, 0)
  assert.match(off.stdout, /ENABLED is off/)
  const system = run({ RENDER: 'true', GHL_SUBACCOUNT_WORKER_ENABLED: '1', GHL_SUBACCOUNT_CHROMIUM: 'system' })
  assert.equal(system.status, 0)
  assert.match(system.stdout, /system/)
})

test('a Send security code page is the 2FA step, not a missing form', () => {
  const gate = snap({
    url: 'https://app.gohighlevel.com/?url=%252Fsub-accounts%252Faccounts',
    buttons: ['Send security code'],
    body: 'we will email a security code to a***@leadgenisys.com',
  })
  const step = nextGhlAction(gate, input('create'), initialRunState())
  assert.equal(step.kind, 'action')
  assert.equal(step.action.type, 'click')
  assert.ok(step.action.words.some((w) => /send security code/i.test(w)))
  assert.match(step.state.codeChannel, /email/)
  const waiting = nextGhlAction(gate, input('create'), step.state)
  assert.equal(waiting.action.type, 'pause')
  const box = snap({
    url: gate.url,
    buttons: [],
    fields: [{ key: 'otp', tag: 'input', type: 'text', value: '', text: 'security code' }],
    body: 'enter the security code emailed to a***@leadgenisys.com',
  })
  const otp = nextGhlAction(box, input('create'), waiting.state)
  assert.equal(otp.action.type, 'wait_otp')
  assert.match(otp.action.channel, /email/)
})

test('email is chosen when GHL offers email and text', () => {
  const gate = snap({
    url: 'https://app.gohighlevel.com/login/verify',
    buttons: ['Email', 'Text message', 'Send security code'],
    body: 'choose how to receive your security code',
  })
  const step = nextGhlAction(gate, input('create'), initialRunState())
  assert.equal(step.action.type, 'click')
  assert.deepEqual(step.action.words, ['Email'])
  assert.equal(step.action.exact, true)
})

test('the in-page script is plain JavaScript with no host imports', () => {
  const fn = new Function(`return (${pageSource.GHL_PAGE_SOURCE})`)()
  assert.equal(typeof fn, 'function')
  assert.equal(pageSource.GHL_PAGE_SOURCE.includes('require('), false)
  assert.equal(pageSource.GHL_PAGE_SOURCE.includes('process.env'), false)
})

test('a remember-this-device box is ticked before the code is typed', () => {
  const page = snap({
    url: 'https://app.gohighlevel.com/login/verify',
    fields: [{ key: 'otp', tag: 'input', type: 'text', value: '', text: 'code' }],
    checks: [{ text: 'Remember this device for 30 days', checked: false }],
    body: 'enter the verification code',
  })
  const step = nextGhlAction(page, { ...input('create'), hasOtp: true }, initialRunState())
  assert.equal(step.action.type, 'remember')
  assert.match(step.state.trustNote, /30 days/)
  const typed = nextGhlAction(page, { ...input('create'), hasOtp: true }, step.state)
  assert.equal(typed.action.type, 'fill_otp')
})

test('the login interstitial is not treated as the agency dashboard', () => {
  const interstitial = snap({
    url: 'https://app.gohighlevel.com/?url=%252Fsub-accounts%252Faccounts',
    buttons: ['send security code'],
    body: 'send security code to continue',
  })
  assert.equal(isAgencyHome(interstitial), false)
  const home = snap({ url: 'https://app.gohighlevel.com/sub-accounts', body: 'accounts' })
  assert.equal(isAgencyHome(home), true)
})

test('code-page diagnostics blank out digit codes', () => {
  const text = pageDiagnostics(snap({
    url: 'https://app.gohighlevel.com/login/verify',
    buttons: ['Confirm Code'],
    fields: [{ key: 'otp', tag: 'input', type: 'text', value: '', text: 'code 654321' }],
    body: 'the code 654321 was not accepted',
  }))
  assert.match(text, /Confirm Code/)
  assert.doesNotMatch(text, /654321/)
})

test('only a HighLevel security-code email after Send is used', () => {
  const { extractSecurityCode, senderLooksHighLevel, classifySecurityMail, pickSecurityCode, imapSettings } = otpMail
  assert.equal(extractSecurityCode('Your security code is 654321'), '654321')
  assert.equal(extractSecurityCode('Hello from the team'), null)
  assert.equal(extractSecurityCode('<td>6</td><td>5</td><td>4</td><td>3</td><td>2</td><td>1</td>'), '654321')
  assert.equal(extractSecurityCode('November 2026 newsletter'), null)
  assert.equal(senderLooksHighLevel('HighLevel <noreply@gohighlevel.com>'), true)
  assert.equal(senderLooksHighLevel('alerts@msgsndr.com'), true)
  assert.equal(senderLooksHighLevel('no-reply@leadconnectorhq.com'), true)
  assert.equal(senderLooksHighLevel('Ethan <ethan@leadgenisys.com>'), false)
  const sent = new Date('2026-11-11T22:07:00.000Z')
  const early = classifySecurityMail(
    {
      from: 'noreply@msgsndr.com',
      subject: 'code',
      body: '482910',
      receivedAt: new Date('2026-11-11T22:04:00.000Z'),
    },
    sent,
  )
  assert.equal(early.accept, false)
  assert.match(early.reason, /before the send click/)
  const html = classifySecurityMail(
    {
      from: 'HighLevel <notifications@example.com>',
      subject: 'Security code',
      body: '<div>Your security code is</div><b>482910</b>',
      receivedAt: new Date('2026-11-11T22:05:30.000Z'),
    },
    sent,
  )
  assert.equal(html.accept, true)
  assert.equal(html.code, '482910')
  const news = classifySecurityMail(
    {
      from: 'noreply@gohighlevel.com',
      subject: 'Your November newsletter',
      body: 'new features for 2026',
      receivedAt: new Date('2026-11-11T22:08:00.000Z'),
    },
    sent,
  )
  assert.equal(news.accept, false)
  const code = pickSecurityCode(
    [
      {
        from: 'noreply@gohighlevel.com',
        subject: 'Your security code',
        body: 'Your security code is 111111',
        receivedAt: new Date('2026-11-11T22:06:00.000Z'),
      },
      {
        from: 'billing@example.com',
        subject: 'Invoice 222222',
        body: 'amount due',
        receivedAt: new Date('2026-11-11T22:08:00.000Z'),
      },
      {
        from: 'HighLevel <noreply@leadconnectorhq.com>',
        subject: 'Login code',
        body: 'Your login code is 654321',
        receivedAt: new Date('2026-11-11T22:07:20.000Z'),
      },
    ],
    sent,
  )
  assert.equal(code, '654321')
  assert.equal(imapSettings({}), null)
  assert.equal(
    imapSettings({ GHL_OTP_IMAP_HOST: 'imap.gmail.com', GHL_OTP_IMAP_USER: 'ethan@leadgenisys.com', GHL_OTP_IMAP_PASSWORD: 'app-password' }).port,
    993,
  )
})

test('the agency shell clicks Sub-Accounts, then records the page after it settles', async () => {
  const shell = snap({
    url: 'https://app.gohighlevel.com/accounts',
    buttons: ['ai suite new', 'ask ai', 'launchpad', 'agency dashboard', 'prospecting', 'sub-accounts', 'account snapshots', 'reselling'],
    frames: [{ url: 'https://app.gohighlevel.com/accounts', buttons: ['sub-accounts'], fieldCount: 0 }],
  })
  const list = snap({
    url: 'https://app.gohighlevel.com/sub-accounts',
    buttons: ['Create Sub-Account', 'sub-accounts'],
    navHref: 'https://app.gohighlevel.com/sub-accounts',
    body: '60 sub-accounts',
    frames: [{ url: 'https://app.gohighlevel.com/sub-accounts', buttons: ['Create Sub-Account'], fieldCount: 0 }],
  })
  const first = nextGhlAction(shell, input('create'), initialRunState())
  assert.equal(first.action.type, 'click')
  assert.equal(first.action.settle, true)
  assert.equal(first.action.words.some((word) => /sub-account/i.test(word)), true)
  assert.equal(first.state.navTrail.length, 0)
  assert.equal(first.state.pendingStep, 'click Sub-Accounts')
  let clicked = false
  const actions = []
  const result = await driveUntil(
    {
      snapshot: async () => (clicked ? list : shell),
      perform: async (action) => {
        actions.push(action)
        if (action.type === 'click' && action.settle) clicked = true
      },
      pullOtp: async () => null,
      onOtpPrompt: async () => {},
    },
    input('create'),
    { maxSteps: 8 },
  )
  assert.equal(actions[0].type, 'click')
  assert.equal(actions[0].settle, true)
  assert.equal(actions[1].type, 'click')
  assert.match(actions[1].words[0], /Create Sub-Account/)
  assert.equal(actions.some((action) => action.type === 'goto'), false)
  assert.equal(result.status, 'needs_human')
  assert.match(result.detail, /click Sub-Accounts: https:\/\/app\.gohighlevel\.com\/sub-accounts/)
  assert.match(result.detail, /href=https:\/\/app\.gohighlevel\.com\/sub-accounts/)
  assert.match(result.detail, /frames=\[https:\/\/app\.gohighlevel\.com\/sub-accounts\]/)
  assert.equal(listCandidates('https://app.gohighlevel.com/accounts')[0], 'https://app.gohighlevel.com/accounts/sub-accounts')
  const frames = pageDiagnostics(shell)
  assert.match(frames, /frames:/)
  assert.match(frames, /https:\/\/app\.gohighlevel\.com\/accounts/)
})

test('a configured list URL is tried before any guessed path', () => {
  const shell = snap({
    url: 'https://app.gohighlevel.com/accounts',
    buttons: ['sub-accounts'],
  })
  const opened = nextGhlAction(shell, { ...input('create'), listUrlOverride: 'https://app.gohighlevel.com/v2/agency/sub-accounts' }, initialRunState())
  const next = nextGhlAction(shell, { ...input('create'), listUrlOverride: 'https://app.gohighlevel.com/v2/agency/sub-accounts' }, opened.state)
  assert.equal(next.action.type, 'goto')
  assert.equal(next.action.url, 'https://app.gohighlevel.com/v2/agency/sub-accounts')
  assert.equal(next.action.settle, true)
  assert.match(next.state.navTrail[0], /click Sub-Accounts: https:\/\/app\.gohighlevel\.com\/accounts/)
  assert.doesNotMatch(next.state.navTrail[0], /v2\/agency/)
})

test('the snapshot modal opens Imported first and selects the card by its exact name', () => {
  assert.deepEqual(snapshotTabPlan(''), ['Imported Snapshots', 'My Snapshots', 'Snapshot Templates'])
  assert.deepEqual(snapshotTabPlan('My Snapshots'), ['My Snapshots', 'Imported Snapshots', 'Snapshot Templates'])
  assert.equal(exactSnapshotCard(['Master Template Extra', 'Master Template'], 'master template'), 'Master Template')
  assert.equal(exactSnapshotCard(['Master Template Extra'], 'Master Template'), null)
  const modal = snap({
    url: 'https://app.gohighlevel.com/sub-accounts',
    buttons: ['Snapshot Templates (123)', 'My Snapshots (34)', 'Imported Snapshots (16)', 'Cancel'],
    tabs: ['Snapshot Templates (123)', 'My Snapshots (34)', 'Imported Snapshots (16)'],
    cards: ['Final Master Client Sub Acc Snapshot'],
    body: 'select snapshot template',
  })
  const opened = { ...initialRunState(), openedCreate: true }
  const named = {
    ...input('dry_run'),
    fields: { ...input('dry_run').fields, snapshotName: 'Master Template' },
  }
  const tab = nextGhlAction(modal, named, opened)
  assert.equal(tab.action.type, 'click')
  assert.match(tab.action.words[0], /Imported Snapshots/)
  const withCard = snap({ ...modal, cards: ['Master Template', 'Another Template'] })
  const pick = nextGhlAction(withCard, named, tab.state)
  assert.equal(pick.action.type, 'select_card')
  assert.equal(pick.action.name, 'Master Template')
  const form = snap({
    url: 'https://app.gohighlevel.com/sub-accounts',
    buttons: ['Create Sub-Account'],
    fields: [
      { key: 'name', tag: 'input', type: 'text', value: '', text: 'account name' },
      { key: 'email', tag: 'input', type: 'email', value: '', text: 'email' },
    ],
  })
  const dry = nextGhlAction(form, named, { ...pick.state, filled: ['name', 'email', 'phone', 'firstName', 'lastName'], missing: [] })
  assert.equal(dry.kind, 'done')
  assert.equal(dry.result.status, 'dry_run')
  assert.match(dry.result.detail, /stopped before Create/)
  assert.match(dry.result.detail, /account name/)
  assert.match(dry.result.detail, /email/)
  assert.equal(dry.result.detail.includes('press Create') || dry.result.detail.includes('MODE=create'), true)
})

test('the create button tolerates a leading plus, then the snapshot choice is taken', () => {
  const list = snap({
    url: 'https://app.gohighlevel.com/accounts/sub-accounts',
    buttons: ['+ Create Sub-Account', 'sub-accounts'],
  })
  const step = nextGhlAction(list, input('create'), initialRunState())
  assert.equal(step.action.type, 'click')
  assert.equal(step.action.contains, true)
  assert.match(step.action.words[0], /Create Sub-Account/)
  const modal = snap({
    url: 'https://app.gohighlevel.com/accounts/sub-accounts',
    buttons: ['Start from scratch', 'From snapshot'],
  })
  const next = nextGhlAction(modal, input('create'), step.state)
  assert.equal(next.action.type, 'click')
  assert.match(next.action.words[0], /snapshot/i)
  assert.equal(next.state.choseSnapshot, true)
})
