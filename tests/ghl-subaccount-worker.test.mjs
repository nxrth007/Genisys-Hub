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
const snapshotCard = loadTs(join(dir, 'snapshot-card.ts'))
const heartbeat = loadTs(join(dir, 'heartbeat.ts'))

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
const { nextGhlAction, driveUntil, initialRunState, locationIdFromUrl, pageDiagnostics, isAgencyHome, listCandidates, snapshotTabPlan, exactSnapshotCard, isCreateSubAccountButton, isSubAccountListReady, snapshotIdFromUrl } = plan

function env(overrides) {
  return overrides
}

test('a running job with no heartbeat for 3 minutes is stale', () => {
  const { isHeartbeatStale, HEARTBEAT_STALE_MS, ABANDONED_JOB_LOG } = heartbeat
  const now = Date.parse('2026-11-12T01:55:00.000Z')
  assert.equal(isHeartbeatStale(new Date(now - HEARTBEAT_STALE_MS - 1000), new Date(now), now), true)
  assert.equal(isHeartbeatStale(new Date(now - 10_000), new Date(now - HEARTBEAT_STALE_MS - 1000), now), false)
  assert.equal(isHeartbeatStale(null, new Date(now - HEARTBEAT_STALE_MS - 1000), now), true)
  assert.equal(isHeartbeatStale(null, new Date(now - 10_000), now), false)
  assert.equal(ABANDONED_JOB_LOG, 'Recovered a job abandoned by a restarted instance')
  assert.equal(heartbeat.shouldAutoRetest('dry_run', 'needs_human', 'Test: Master'), true)
  assert.equal(heartbeat.shouldAutoRetest('dry_run', 'dry_run', 'Test: Master'), true)
  assert.equal(heartbeat.shouldAutoRetest('create', 'dry_run', 'Test: Master'), false)
  assert.equal(heartbeat.shouldAutoRetest('create', 'needs_human', 'Test: Master'), false)
  assert.equal(heartbeat.shouldAutoRetest('dry_run', 'needs_human', 'Randy: Painting'), false)
  assert.equal(heartbeat.shouldAutoRetest('dry_run', 'failed', 'Test: Master'), false)
  assert.equal(heartbeat.AUTO_RETEST_DELAY_MS, 90_000)
  assert.equal(heartbeat.autoRetestDue(1_000, 1_000 + 89_000), false)
  assert.equal(heartbeat.autoRetestDue(1_000, 1_000 + 90_000), true)
  assert.equal(heartbeat.runningCommit({ RENDER_GIT_COMMIT: '3ba4fbaabcdef' }), '3ba4fba')
  assert.equal(heartbeat.runningCommit({}), 'local')
  assert.equal(heartbeat.stampJobLog('Auto-retest after deploy', '3ba4fba'), '[3ba4fba] Auto-retest after deploy')
  assert.equal(heartbeat.stampJobLog('[3ba4fba] Auto-retest after deploy', '3ba4fba'), '[3ba4fba] Auto-retest after deploy')
  assert.equal(heartbeat.jobLogEntry('Screenshot abc at step details form bottom', new Date('2026-11-12T02:59:19.000Z'), '3ba4fba').msg, '[3ba4fba] Screenshot abc at step details form bottom')
})

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
  assert.equal(listCandidates('https://app.gohighlevel.com/accounts')[0], 'https://app.gohighlevel.com/sub-accounts')
  assert.equal(listCandidates('https://app.gohighlevel.com/accounts').some((url) => url.endsWith('/accounts/sub-accounts')), false)
  const frames = pageDiagnostics(shell)
  assert.match(frames, /frames:/)
  assert.match(frames, /https:\/\/app\.gohighlevel\.com\/accounts/)
})

test('the loading empty state is not the list, and create new is not the create button', () => {
  assert.equal(isCreateSubAccountButton('create new'), false)
  assert.equal(isCreateSubAccountButton('Create Sub-Account'), true)
  assert.equal(isCreateSubAccountButton('+ Create Sub-Account'), true)
  const loading = snap({
    url: 'https://app.gohighlevel.com/sub-accounts/accounts',
    buttons: ['create new', 'sub-accounts'],
    body: 'sub-accounts start creating sub-accounts to manage your clients crm, automations',
  })
  assert.equal(isSubAccountListReady(loading), false)
  const step = nextGhlAction(loading, input('create'), { ...initialRunState(), clickedNav: true })
  assert.equal(step.action.type, 'wait_list')
  const still = nextGhlAction(loading, input('create'), step.state)
  assert.notEqual(still.action?.type, 'click')
  assert.equal(still.action?.words?.some((word) => /create new/i.test(word)) || false, false)
  const ready = snap({
    url: 'https://app.gohighlevel.com/sub-accounts/accounts',
    buttons: ['Create Sub-Account', 'create new'],
    body: '60 sub-accounts',
  })
  assert.equal(isSubAccountListReady(ready), true)
  const click = nextGhlAction(ready, input('create'), { ...initialRunState(), clickedNav: true, listWaited: true })
  assert.equal(click.action.type, 'click')
  assert.deepEqual(click.action.words, ['Create Sub-Account'])
  assert.equal(click.action.exact, true)
  assert.equal(click.action.settle, 'modal')
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
  const ready = { ...pick.state, filled: ['name', 'email', 'phone', 'firstName', 'lastName'], missing: [] }
  const scrolled = nextGhlAction(form, named, ready)
  assert.equal(scrolled.action.type, 'scroll_form')
  const recorded = nextGhlAction(form, named, scrolled.state)
  assert.equal(recorded.action.type, 'record_form')
  const dry = nextGhlAction(form, named, recorded.state)
  assert.equal(dry.kind, 'done')
  assert.equal(dry.result.status, 'dry_run')
  assert.match(dry.result.detail, /stopped before Create/)
  assert.match(dry.result.detail, /account name/)
  assert.match(dry.result.detail, /email/)
  assert.equal(dry.result.detail.includes('press Create') || dry.result.detail.includes('MODE=create'), true)
})

test('the snapshot card is the ancestor of the exact title, not the MT avatar', () => {
  const { locateSnapshotCard, redactCardHtml } = snapshotCard
  function textNode(value) {
    return { nodeType: 3, textContent: value, childNodes: [], parentElement: null, contains() { return false } }
  }
  function element(tag, attrs = {}) {
    const el = {
      nodeType: 1,
      tagName: tag.toUpperCase(),
      attrs,
      childNodes: [],
      parentElement: null,
      getAttribute(name) {
        return this.attrs[name] ?? null
      },
      getBoundingClientRect() {
        return { x: 10, y: 20, width: 180, height: 64, left: 10, top: 20, right: 190, bottom: 84 }
      },
      append(...kids) {
        for (const kid of kids) {
          kid.parentElement = this
          this.childNodes.push(kid)
        }
        return this
      },
      get textContent() {
        return this.childNodes.map((node) => node.textContent || '').join('')
      },
      contains(other) {
        let current = other
        while (current) {
          if (current === this) return true
          current = current.parentElement
        }
        return false
      },
      querySelectorAll() {
        const found = []
        const walk = (node) => {
          for (const child of node.childNodes) {
            if (child.nodeType !== 1) continue
            found.push(child)
            walk(child)
          }
        }
        walk(this)
        return found
      },
    }
    return el
  }

  const dialog = element('div', { role: 'dialog' })
  const card = element('div', { class: 'cursor-pointer rounded-lg', role: 'button' })
  const avatar = element('div')
  avatar.append(textNode('MT'))
  const title = element('span')
  title.append(textNode('Master Template'))
  card.append(avatar, title)
  dialog.append(card)

  assert.equal(locateSnapshotCard('master template', dialog), card)
  assert.equal(locateSnapshotCard('not a snapshot', dialog), null)

  const plain = element('div')
  const plainCard = element('div')
  const initials = element('div')
  initials.append(textNode('MT'))
  const label = element('div')
  label.append(textNode('Master Template'))
  plainCard.append(initials, label)
  plain.append(plainCard)
  assert.equal(locateSnapshotCard('Master Template', plain), plainCard)
  const manual = element('div')
  const manualText = element('span')
  manualText.append(textNode('Add manually'))
  manual.append(manualText)
  assert.equal(snapshotCard.locateAddManually(manual), manualText)
  assert.deepEqual(snapshotCard.ADD_MANUALLY_ATTEMPTS, ['innermost click', 'clickable ancestor', 'mouse centre'])
  assert.equal(redactCardHtml('<div>code 654321</div>' + 'x'.repeat(1600)).length, 1500)
  assert.equal(redactCardHtml('<div>code 654321</div>').includes('654321'), false)
})

test('the business search step opens Add manually and a dry run records the form', async () => {
  const search = snap({
    url: 'https://app.gohighlevel.com/accounts/search?snapshot=PsOYVeuIfXR7soMIiMcI&s_type=imported',
    fields: [{ key: 'search', tag: 'input', type: 'text', value: '', text: 'search', placeholder: 'search' }],
    buttons: ['back to sub-accounts'],
    body: 'add manually google maps',
  })
  assert.equal(snapshotIdFromUrl(search.url), 'PsOYVeuIfXR7soMIiMcI')
  const opened = { ...initialRunState(), openedCreate: true, snapshotChosen: true }
  const step = nextGhlAction(search, input('dry_run'), opened)
  assert.equal(step.action.type, 'add_manually')
  const form = snap({
    url: 'https://app.gohighlevel.com/accounts/create',
    buttons: ['Save', 'create new'],
    fields: [
      { key: 'name', tag: 'input', type: 'text', value: '', text: 'business name', placeholder: 'acme painting' },
      { key: 'email', tag: 'input', type: 'email', value: '', text: 'email', placeholder: '' },
      { key: 'phone', tag: 'input', type: 'tel', value: '', text: 'phone', placeholder: '' },
    ],
  })
  let manual = false
  const actions = []
  const result = await driveUntil(
    {
      snapshot: async () => (manual ? form : search),
      perform: async (action) => {
        actions.push(action)
        if (action.type === 'add_manually') manual = true
      },
      pullOtp: async () => null,
      onOtpPrompt: async () => {},
    },
    input('dry_run'),
    { maxSteps: 20 },
  )
  assert.equal(actions.some((action) => action.type === 'fill' && action.key === 'search'), false)
  assert.equal(actions.some((action) => action.type === 'fill' && action.key === 'name'), true)
  assert.equal(actions.some((action) => action.type === 'click' && action.exact), false)
  assert.equal(result.status, 'dry_run')
  assert.match(result.detail, /business name/)
  assert.match(result.detail, /acme painting/)
  assert.match(result.detail, /Save/)
  assert.equal(result.observedSnapshotId, 'PsOYVeuIfXR7soMIiMcI')
})

test('a failed Add manually on the search page logs every try and writes a shot', async () => {
  const { ADD_MANUALLY_ATTEMPTS, runSearchAddManually } = snapshotCard
  const logs = []
  const shots = []
  const clicks = []
  await assert.rejects(
    () =>
      runSearchAddManually({
        attempts: ADD_MANUALLY_ATTEMPTS.map((name) => ({
          name,
          run: async () => {
            clicks.push(name)
          },
        })),
        opened: async () => false,
        log: (line) => {
          logs.push(line)
        },
        capture: (step) => {
          shots.push(step)
        },
      }),
    /Tried innermost click, clickable ancestor, mouse centre/,
  )
  assert.deepEqual(clicks, ['innermost click', 'clickable ancestor', 'mouse centre'])
  assert.ok(logs.includes('Add manually try: innermost click'))
  assert.ok(logs.includes('Add manually try failed: innermost click'))
  assert.ok(logs.includes('Add manually try: clickable ancestor'))
  assert.ok(logs.includes('Add manually try failed: clickable ancestor'))
  assert.ok(logs.includes('Add manually try: mouse centre'))
  assert.ok(logs.includes('Add manually try failed: mouse centre'))
  assert.deepEqual(shots, ['failure:add-manually'])
})

test('a failed search-page Add manually keeps the extended diagnostics', async () => {
  const search = snap({
    url: 'https://app.gohighlevel.com/accounts/search?snapshot=PsOYVeuIfXR7soMIiMcI&s_type=imported',
    fields: [{ key: 'search', tag: 'input', type: 'text', value: '', text: 'search', placeholder: 'find a business' }],
    buttons: ['back to sub-accounts'],
    overlays: ['drawer: add manually'],
    body: 'add manually',
  })
  const result = await driveUntil(
    {
      snapshot: async () => search,
      perform: async (action) => {
        if (action.type === 'add_manually') throw new Error('Add manually did not open a details form, dialog, or new page.')
      },
      pullOtp: async () => null,
      onOtpPrompt: async () => {},
    },
    input('dry_run'),
    { maxSteps: 6 },
  )
  assert.equal(result.status, 'needs_human')
  assert.match(result.detail, /overlays: drawer: add manually/)
  assert.match(result.detail, /placeholder=find a business/)
})

test('the create button tolerates a leading plus, then the snapshot choice is taken', () => {
  const list = snap({
    url: 'https://app.gohighlevel.com/accounts/sub-accounts',
    buttons: ['+ Create Sub-Account', 'sub-accounts'],
  })
  const step = nextGhlAction(list, input('create'), initialRunState())
  assert.equal(step.action.type, 'click')
  assert.equal(step.action.exact, true)
  assert.equal(step.action.settle, 'modal')
  assert.deepEqual(step.action.words, ['+ Create Sub-Account'])
  const modal = snap({
    url: 'https://app.gohighlevel.com/accounts/sub-accounts',
    buttons: ['Start from scratch', 'From snapshot'],
  })
  const next = nextGhlAction(modal, input('create'), step.state)
  assert.equal(next.action.type, 'click')
  assert.match(next.action.words[0], /snapshot/i)
  assert.equal(next.state.choseSnapshot, true)
})

test('the details form names unlabeled inputs, scrolls to the save button, and fills without saving', async () => {
  const browserSrc = readFileSync(join(dir, 'browser.ts'), 'utf8')
  assert.match(browserSrc, /capture\('details form bottom'\)/)
  assert.match(browserSrc, /capture\('details form filled'\)/)

  class El {
    constructor(tag, props = {}) {
      this.nodeType = 1
      this.tagName = tag.toUpperCase()
      this.id = props.id || ''
      this.className = props.className || ''
      this.type = props.type || ''
      this.placeholder = props.placeholder || ''
      this.value = props.value || ''
      this.nameAttr = props.name || ''
      this.role = props.role || ''
      this.aria = props.aria || ''
      this.width = props.width ?? 140
      this.height = props.height ?? 32
      this.scrollHeight = props.scrollHeight ?? 48
      this.clientHeight = props.clientHeight ?? 48
      this.scrollTop = 0
      this.parentElement = null
      this.childNodes = []
      if (props.text) this.childNodes.push({ nodeType: 3, textContent: props.text, parentElement: this })
      for (const child of props.children || []) this.append(child)
    }
    append(child) {
      child.parentElement = this
      this.childNodes.push(child)
    }
    get textContent() {
      return this.childNodes.map((node) => node.textContent || '').join('')
    }
    get innerText() {
      return this.textContent
    }
    get children() {
      return this.childNodes.filter((node) => node.nodeType === 1)
    }
    get previousElementSibling() {
      const kids = this.parentElement ? this.parentElement.children : []
      const index = kids.indexOf(this)
      return index > 0 ? kids[index - 1] : null
    }
    get nextElementSibling() {
      const kids = this.parentElement ? this.parentElement.children : []
      const index = kids.indexOf(this)
      return index >= 0 && index < kids.length - 1 ? kids[index + 1] : null
    }
    getAttribute(name) {
      if (name === 'class') return this.className
      if (name === 'id') return this.id
      if (name === 'name') return this.nameAttr || null
      if (name === 'role') return this.role || null
      if (name === 'type') return this.type || null
      if (name === 'aria-label') return this.aria || null
      return null
    }
    getBoundingClientRect() {
      return { width: this.width, height: this.height, top: 0, left: 0 }
    }
    querySelectorAll(selector) {
      const out = []
      const walk = (node) => {
        for (const child of node.children) {
          if (matches(child, selector)) out.push(child)
          walk(child)
        }
      }
      walk(this)
      return out
    }
    querySelector(selector) {
      return this.querySelectorAll(selector)[0] || null
    }
    closest(selector) {
      if (this.nodeType === 1 && matches(this, selector)) return this
      return this.parentElement ? this.parentElement.closest(selector) : null
    }
    contains(other) {
      return other === this || (!!other && !!other.parentElement && this.contains(other.parentElement))
    }
  }
  function matches(el, selector) {
    return selector.split(',').some((part) => matchesOne(el, part.trim()))
  }
  function matchesOne(el, sel) {
    if (!el || el.nodeType !== 1) return false
    const tag = /^[a-z]+/i.exec(sel)
    if (tag && el.tagName !== tag[0].toUpperCase()) return false
    const attrs = [...sel.matchAll(/\[([^\]=*^$~|]+)(?:([*^$~|]?=)([^\]]+))?\]/g)]
    for (const attr of attrs) {
      const name = attr[1]
      const op = attr[2]
      const raw = String(attr[3] || '').replace(/^["']|["']$/g, '')
      const have = el.getAttribute(name)
      if (!op) {
        if (have == null) return false
        continue
      }
      const left = String(have || '')
      if (op === '=' && left !== raw) return false
      if (op === '*=' && !left.toLowerCase().includes(raw.toLowerCase())) return false
    }
    for (const found of sel.matchAll(/\.([A-Za-z0-9_-]+)/g)) {
      if (!el.className.split(/\s+/).includes(found[1])) return false
    }
    if (!tag && attrs.length === 0 && !sel.includes('.')) return false
    return true
  }
  const field = (label, control) => new El('div', { children: [new El('span', { text: label }), control] })
  const dialog = new El('div', {
    role: 'dialog',
    className: 'drawer',
    scrollHeight: 1600,
    clientHeight: 500,
    children: [
      field('Business name', new El('input', { name: 'business_name' })),
      new El('input', { name: 'business_email' }),
      new El('input', { id: 'website' }),
      new El('input', { aria: 'Business phone' }),
      field('Zip', new El('input')),
      field('Country', new El('div', { className: 'n-select', role: 'combobox' })),
      field('Time Zone', new El('div', { role: 'combobox', className: 'n-select' })),
      field('State', new El('div', { role: 'combobox', className: 'n-select' })),
      new El('button', { text: 'Save Changes', width: 0, height: 0 }),
    ],
  })
  const body = new El('body', { children: [dialog] })
  const documentMock = {
    body,
    documentElement: body,
    scrollingElement: body,
    querySelector(selector) {
      return body.querySelector(selector)
    },
    querySelectorAll(selector) {
      const own = matches(body, selector) ? [body] : []
      return [...own, ...body.querySelectorAll(selector)]
    },
    getElementById(id) {
      const all = body.querySelectorAll('*')
      return all.find((node) => node.id === id) || (body.id === id ? body : null)
    },
  }
  const previous = { document: global.document, window: global.window, location: global.location }
  global.document = documentMock
  global.window = {
    getComputedStyle() {
      return { overflowY: 'auto', display: 'block', visibility: 'visible' }
    },
    scrollTo() {},
  }
  global.location = { href: 'https://app.gohighlevel.com/accounts/create' }
  const page = new Function(`return (${pageSource.GHL_PAGE_SOURCE})`)()
  let shot
  try {
    shot = page({ op: 'snapshot', labels: ghlLabels() })
    const scrolled = page({ op: 'scrollForm' })
    assert.equal(dialog.scrollTop, dialog.scrollHeight)
    assert.ok(scrolled.buttons.some((label) => label === 'Save Changes'))
  } finally {
    global.document = previous.document
    global.window = previous.window
    global.location = previous.location
  }
  const byKey = Object.fromEntries(shot.fields.filter((item) => item.key).map((item) => [item.key, item]))
  assert.equal(byKey.email.name, 'business_email')
  assert.equal(byKey.website.id, 'website')
  assert.equal(byKey.phone.aria, 'business phone')
  assert.equal(byKey.postalCode.nearby, 'zip')
  assert.equal(byKey.country.type, 'dropdown')
  assert.equal(byKey.timezone.type, 'dropdown')
  assert.equal(byKey.state.type, 'dropdown')
  assert.ok(shot.buttons.includes('Save Changes'))

  const form = {
    ...shot,
    url: 'https://app.gohighlevel.com/accounts/create?snapshot=PsOYVeuIfXR7soMIiMcI',
    links: shot.links || [],
    texts: shot.texts || [],
    checks: [],
  }
  const actions = []
  const result = await driveUntil(
    {
      snapshot: async () => form,
      perform: async (action) => {
        actions.push(action.type === 'click' ? action : { type: action.type, key: action.key, value: action.value })
      },
      pullOtp: async () => null,
      onOtpPrompt: async () => {},
    },
    {
      ...input('dry_run'),
      fields: browserFieldsFromLocation(
        {
          name: 'Test: Acme',
          snapshotId: 'pHagdFFJPsZBnn8ACSHK',
          phone: '+15551230000',
          address: '1 Main',
          city: 'Tampa',
          state: 'FL',
          postalCode: '33602',
          country: 'US',
          website: 'https://acme.example',
          timezone: 'America/New_York',
          prospectInfo: { firstName: 'Ada', lastName: 'Lovelace', email: 'ada@example.com' },
        },
        { snapshotName: 'Master Template' },
      ),
    },
    { maxSteps: 30 },
  )
  assert.equal(actions[0].type, 'scroll_form')
  assert.equal(actions.some((action) => action.type === 'record_form'), true)
  assert.equal(actions.some((action) => action.type === 'click'), false)
  assert.equal(actions.some((action) => action.type === 'fill' && action.key === 'email' && action.value === 'ada@example.com'), true)
  assert.equal(actions.some((action) => action.type === 'fill' && action.key === 'name' && action.value === 'Test: Acme'), true)
  assert.equal(actions.some((action) => action.type === 'pick' && action.key === 'country' && action.value === 'United States'), true)
  assert.equal(actions.some((action) => action.type === 'pick' && action.key === 'timezone' && action.value === 'America/New_York'), true)
  assert.equal(actions.some((action) => action.type === 'pick' && action.key === 'state' && action.value === 'FL'), true)
  assert.equal(result.status, 'dry_run')
  assert.match(result.detail, /Save Changes/)
  assert.match(result.detail, /country="United States" \(dropdown/)
  assert.match(result.detail, /timezone="America\/New_York" \(dropdown/)
  assert.match(result.detail, /email="ada@example.com"/)
  const fieldsLine = result.detail.match(/Fields: ([^.]+)\./)[1]
  assert.equal(fieldsLine.split(', ').includes('input'), false)
})
