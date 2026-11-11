import assert from 'node:assert/strict'
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

const {
  workerEnabled,
  workerRunsBrowser,
  workerMode,
  retryDelayMs,
  MAX_ATTEMPTS,
  subAccountListUrl,
  parseAgencyLogin,
} = config
const { ghlLabels } = labelsMod
const { browserFieldsFromLocation, readBrowserFields } = fieldsMod
const { autoEnqueueAllowed, intakeTimeKnown } = eligibility
const { secretMatches, parseTriggerBody } = trigger
const { sealString, openString } = session
const { nextGhlAction, driveUntil, initialRunState, locationIdFromUrl } = plan

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
  assert.equal(actions.some((a) => a.type === 'fill' && a.key === 'otp'), true)
  assert.equal(result.status, 'needs_human')
  assert.match(result.detail, /did not accept/)
})

test('the in-page script is plain JavaScript with no host imports', () => {
  const fn = new Function(`return (${pageSource.GHL_PAGE_SOURCE})`)()
  assert.equal(typeof fn, 'function')
  assert.equal(pageSource.GHL_PAGE_SOURCE.includes('require('), false)
  assert.equal(pageSource.GHL_PAGE_SOURCE.includes('process.env'), false)
})
