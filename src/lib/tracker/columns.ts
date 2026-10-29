/**
 * Pure helpers for the DB client tracker (no DB, no Google). Mirrors the
 * "Client Onboarding Tracker" Google Sheet that src/lib/onboarding-tracker.ts
 * writes: one row per client, identity columns plus a ✅ / ❌ column per step.
 *
 * Headers are matched case-insensitively by text (like onboarding-tracker.ts),
 * so a reordered sheet still parses. Any other header is kept in `extra`.
 */

export const TRACKER_STEPS = ['signup', 'intake', 'automations', 'a2p', 'tollfree'] as const
export type TrackerStep = (typeof TRACKER_STEPS)[number]

/** Sheet header per step — same text as onboarding-tracker.ts TRACKER_STEPS. */
export const STEP_HEADERS: Record<TrackerStep, string> = {
  signup: 'Sign-Up Link Completed',
  intake: 'Intake Form Completed',
  automations: 'Automations Configuration',
  a2p: 'A2P Submitted',
  tollfree: 'Toll-Free Submitted',
}

/** Wording a client sees on their status page. */
export const STEP_LABELS: Record<TrackerStep, string> = {
  signup: 'Sign-up',
  intake: 'Onboarding form',
  automations: 'Automations set up',
  a2p: 'Texting registration (A2P) submitted',
  tollfree: 'Toll-free number registration submitted',
}

/** What we tell a client is next when this step is the first one not done. */
export const STEP_NEXT: Record<TrackerStep, string> = {
  signup: 'Complete your sign-up link.',
  intake: 'Fill in the onboarding form.',
  automations: 'Our team is setting up your automations.',
  a2p: 'Our team is preparing your texting (A2P) registration.',
  tollfree: 'Our team is preparing your toll-free registration.',
}

/** DB column per step on ClientTracker. */
export const STEP_FIELDS = {
  signup: 'signupStatus',
  intake: 'intakeStatus',
  automations: 'automationsStatus',
  a2p: 'a2pStatus',
  tollfree: 'tollFreeStatus',
} as const satisfies Record<TrackerStep, string>

export const IDENTITY_HEADERS = {
  clientName: 'Client Name',
  business: 'Business',
  contactEmail: 'Contact Email',
  startDate: 'Start Date',
} as const
export type IdentityKey = keyof typeof IDENTITY_HEADERS

export const TRACKER_STATUSES = ['pending', 'done'] as const
export type TrackerStatus = (typeof TRACKER_STATUSES)[number]

export function isTrackerStep(v: unknown): v is TrackerStep {
  return typeof v === 'string' && (TRACKER_STEPS as readonly string[]).includes(v)
}
export function isTrackerStatus(v: unknown): v is TrackerStatus {
  return typeof v === 'string' && (TRACKER_STATUSES as readonly string[]).includes(v)
}

/**
 * A sheet cell -> step status. The Hub writes ✅; people type ✔, TRUE (a
 * checkbox), yes, done, x. ❌, FALSE, no and blank are pending. Anything
 * else is "pending" too, and the raw text is reported back so it isn't lost.
 */
export function parseStepCell(raw: unknown): { status: TrackerStatus; unrecognised: string | null } {
  const v = String(raw ?? '').trim()
  if (!v) return { status: 'pending', unrecognised: null }
  if (/^(✅|✔️?|☑️?|true|yes|y|done|complete(d)?|x)$/i.test(v)) return { status: 'done', unrecognised: null }
  if (/^(❌|✖️?|false|no|n|pending|-|—)$/i.test(v)) return { status: 'pending', unrecognised: null }
  return { status: 'pending', unrecognised: v }
}

export type ParsedSheetRow = {
  /** 1-based sheet row number (header is row 1). */
  row: number
  clientName: string | null
  business: string | null
  contactEmail: string | null
  startDate: string | null
  steps: Partial<Record<TrackerStep, TrackerStatus>>
  extra: Record<string, string>
}

export type ParsedSheet = {
  headers: string[]
  /** Steps whose column the sheet has (Toll-Free is optional). */
  presentSteps: TrackerStep[]
  missingHeaders: string[]
  rows: ParsedSheetRow[]
}

const clean = (v: unknown) => {
  const s = String(v ?? '').trim()
  return s ? s : null
}

/** Parse the sheet's values (row 0 = headers). Rows with no name, business or email are skipped. */
export function parseTrackerSheet(values: unknown[][]): ParsedSheet {
  const headers = (values[0] ?? []).map((h) => String(h ?? '').trim())
  const idx = (name: string) => headers.findIndex((h) => h.toLowerCase() === name.toLowerCase())
  const known = new Set<number>()
  const idCols = {} as Record<IdentityKey, number>
  for (const k of Object.keys(IDENTITY_HEADERS) as IdentityKey[]) {
    idCols[k] = idx(IDENTITY_HEADERS[k])
    if (idCols[k] >= 0) known.add(idCols[k])
  }
  const stepCols = {} as Record<TrackerStep, number>
  for (const s of TRACKER_STEPS) {
    stepCols[s] = idx(STEP_HEADERS[s])
    if (stepCols[s] >= 0) known.add(stepCols[s])
  }
  const presentSteps = TRACKER_STEPS.filter((s) => stepCols[s] >= 0)
  const missingHeaders = [
    ...(Object.keys(IDENTITY_HEADERS) as IdentityKey[]).filter((k) => idCols[k] < 0).map((k) => IDENTITY_HEADERS[k]),
    ...TRACKER_STEPS.filter((s) => stepCols[s] < 0).map((s) => STEP_HEADERS[s]),
  ]

  const rows: ParsedSheetRow[] = []
  values.slice(1).forEach((cells, i) => {
    const get = (c: number) => (c >= 0 ? clean(cells?.[c]) : null)
    const r: ParsedSheetRow = {
      row: i + 2,
      clientName: get(idCols.clientName),
      business: get(idCols.business),
      contactEmail: get(idCols.contactEmail)?.toLowerCase() ?? null,
      startDate: get(idCols.startDate),
      steps: {},
      extra: {},
    }
    if (!r.clientName && !r.business && !r.contactEmail) return
    for (const s of presentSteps) {
      const { status, unrecognised } = parseStepCell(cells?.[stepCols[s]])
      r.steps[s] = status
      if (unrecognised) r.extra[STEP_HEADERS[s]] = unrecognised
    }
    headers.forEach((h, c) => {
      if (!h || known.has(c)) return
      const v = clean(cells?.[c])
      if (v) r.extra[h] = v
    })
    rows.push(r)
  })
  return { headers, presentSteps, missingHeaders, rows }
}

/** Same normalisation as onboarding-tracker.ts so matches agree with the sheet writer. */
export const normName = (s: string | null | undefined) =>
  (s ?? '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\b(llc|inc|co|corp|the|com|org|net)\b/g, ' ')
    .replace(/\s+/g, '')

export type ClientCandidate = {
  id: string
  emails: (string | null | undefined)[]
  businesses: (string | null | undefined)[]
  names: (string | null | undefined)[]
}

export type MatchResult = { clientId: string; by: 'email' | 'business' | 'name' } | { clientId: null; reason: 'none' | 'ambiguous'; ids?: string[] }

/**
 * Find the existing Hub client for a sheet row: email, then business, then
 * name (same order as the sheet writer). Never guesses between two clients,
 * and never creates one — unmatched rows are only reported, so the sync
 * can't make duplicate clients (or, downstream, duplicate sub-accounts).
 */
export function matchClient(row: Pick<ParsedSheetRow, 'contactEmail' | 'business' | 'clientName'>, clients: ClientCandidate[]): MatchResult {
  const tryBy = (by: 'email' | 'business' | 'name', key: string, pick: (c: ClientCandidate) => string[]): MatchResult | null => {
    if (!key) return null
    const ids = [...new Set(clients.filter((c) => pick(c).includes(key)).map((c) => c.id))]
    if (ids.length === 1) return { clientId: ids[0], by }
    if (ids.length > 1) return { clientId: null, reason: 'ambiguous', ids }
    return null
  }
  const email = (row.contactEmail ?? '').trim().toLowerCase()
  return (
    tryBy('email', email, (c) => c.emails.map((e) => (e ?? '').trim().toLowerCase()).filter(Boolean)) ??
    tryBy('business', normName(row.business), (c) => c.businesses.map(normName).filter(Boolean)) ??
    tryBy('name', normName(row.clientName), (c) => c.names.map(normName).filter(Boolean)) ?? { clientId: null, reason: 'none' }
  )
}

export type TrackerRowState = {
  clientId: string
  clientName: string | null
  business: string | null
  contactEmail: string | null
  startDate: string | null
  signupStatus: string
  intakeStatus: string
  automationsStatus: string
  a2pStatus: string
  tollFreeStatus: string
  extra: Record<string, string> | null
  sheetRow: number | null
}

export type BackfillOp =
  | { kind: 'create'; clientId: string; data: Omit<TrackerRowState, 'clientId'>; doneSteps: TrackerStep[]; sheetRow: number }
  | { kind: 'update'; clientId: string; data: Partial<Omit<TrackerRowState, 'clientId'>>; doneSteps: TrackerStep[]; sheetRow: number }
  | { kind: 'unchanged'; clientId: string; sheetRow: number }
  | { kind: 'unmatched'; sheetRow: number; label: string; reason: 'none' | 'ambiguous' | 'duplicate_row' }

const sameJson = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null)

/**
 * Plan a sheet -> DB pass. Pure and idempotent: running it again on the
 * result plans only `unchanged`. Rules:
 *   - steps only move pending -> done (a ✅ in the sheet); a Hub "done" is
 *     never undone by a blank cell, same as the sheet writer never unticks;
 *   - identity columns fill blanks only, Hub edits win;
 *   - extra columns and the sheet row number track the sheet;
 *   - a second sheet row for an already-matched client is reported, not merged.
 */
export function planBackfill(sheet: ParsedSheet, clients: ClientCandidate[], existing: TrackerRowState[]): BackfillOp[] {
  const byClient = new Map(existing.map((e) => [e.clientId, e]))
  const seen = new Set<string>()
  const ops: BackfillOp[] = []
  for (const row of sheet.rows) {
    const label = row.business || row.clientName || row.contactEmail || `row ${row.row}`
    const m = matchClient(row, clients)
    if (m.clientId === null) {
      ops.push({ kind: 'unmatched', sheetRow: row.row, label, reason: m.reason })
      continue
    }
    if (seen.has(m.clientId)) {
      ops.push({ kind: 'unmatched', sheetRow: row.row, label, reason: 'duplicate_row' })
      continue
    }
    seen.add(m.clientId)
    const doneInSheet = TRACKER_STEPS.filter((s) => row.steps[s] === 'done')
    const extra = Object.keys(row.extra).length ? row.extra : null
    const cur = byClient.get(m.clientId)
    if (!cur) {
      const data: Omit<TrackerRowState, 'clientId'> = {
        clientName: row.clientName,
        business: row.business,
        contactEmail: row.contactEmail,
        startDate: row.startDate,
        signupStatus: 'pending',
        intakeStatus: 'pending',
        automationsStatus: 'pending',
        a2pStatus: 'pending',
        tollFreeStatus: 'pending',
        extra,
        sheetRow: row.row,
      }
      for (const s of doneInSheet) data[STEP_FIELDS[s]] = 'done'
      ops.push({ kind: 'create', clientId: m.clientId, data, doneSteps: doneInSheet, sheetRow: row.row })
      continue
    }
    const data: Partial<Omit<TrackerRowState, 'clientId'>> = {}
    for (const k of ['clientName', 'business', 'contactEmail', 'startDate'] as const) {
      if (!cur[k] && row[k]) data[k] = row[k]
    }
    const doneSteps = doneInSheet.filter((s) => cur[STEP_FIELDS[s]] !== 'done')
    for (const s of doneSteps) data[STEP_FIELDS[s]] = 'done'
    if (!sameJson(cur.extra, extra)) data.extra = extra
    if (cur.sheetRow !== row.row) data.sheetRow = row.row
    ops.push(Object.keys(data).length ? { kind: 'update', clientId: m.clientId, data, doneSteps, sheetRow: row.row } : { kind: 'unchanged', clientId: m.clientId, sheetRow: row.row })
  }
  return ops
}

export type SafeStatus = {
  business: string
  steps: { label: string; status: TrackerStatus }[]
  /** First step not done, or null when all are done. */
  currentStage: string | null
  nextStep: string
  updatedAt: string
}

/** The only fields a client's status link shows. No notes, emails, extra columns or ids. */
export function safeStatusView(row: Pick<TrackerRowState, 'signupStatus' | 'intakeStatus' | 'automationsStatus' | 'a2pStatus' | 'tollFreeStatus'> & { business: string; updatedAt: Date }): SafeStatus {
  const steps = TRACKER_STEPS.map((s) => ({ step: s, status: (row[STEP_FIELDS[s]] === 'done' ? 'done' : 'pending') as TrackerStatus }))
  const current = steps.find((s) => s.status !== 'done')?.step ?? null
  return {
    business: row.business,
    steps: steps.map((s) => ({ label: STEP_LABELS[s.step], status: s.status })),
    currentStage: current ? STEP_LABELS[current] : null,
    nextStep: current ? STEP_NEXT[current] : 'All onboarding steps are complete.',
    updatedAt: row.updatedAt.toISOString(),
  }
}
