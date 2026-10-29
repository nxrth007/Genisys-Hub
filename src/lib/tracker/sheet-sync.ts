/**
 * One-way Google Sheet -> DB backfill/sync for the client tracker.
 * Reads the same sheet src/lib/onboarding-tracker.ts writes (AppSetting
 * `onboardingTracker.sheetId`, first tab). Never writes to the sheet, never
 * creates clients. Idempotent (see planBackfill) and dry-run capable.
 *
 * The scheduled pass runs only when TRACKER_SHEET_SYNC=1 (off by default);
 * the staff "Sync from sheet" button and the API can run it on demand.
 */
import { prisma } from '@/lib/prisma'
import { Prisma } from '@/generated/prisma/client'
import { getSheetsClient, getWriterAccountEmail } from '@/lib/drive'
import { parseTrackerSheet, planBackfill, type BackfillOp, type ClientCandidate, type ParsedSheet, type TrackerRowState } from './columns'

const DEFAULT_SHEET_ID = '1-xDJVi6HpntUJUWrZWi6rPTmDamyHytKi_aLttL-UU4'
const SHEET_ID_KEY = 'onboardingTracker.sheetId'
const STATUS_KEY = 'tracker.sheetSync'

export const sheetSyncEnabled = () => /^(1|true|on|yes)$/i.test((process.env.TRACKER_SHEET_SYNC ?? '').trim())

export async function readTrackerSheet(): Promise<ParsedSheet> {
  const row = await prisma.appSetting.findUnique({ where: { key: SHEET_ID_KEY } })
  const spreadsheetId = row?.value.trim() || DEFAULT_SHEET_ID
  const sheets = await getSheetsClient(await getWriterAccountEmail())
  const meta = await sheets.spreadsheets.get({ spreadsheetId, fields: 'sheets(properties(title,index))' })
  const tab = meta.data.sheets?.find((s) => s.properties?.index === 0)?.properties?.title ?? 'Sheet1'
  const res = await sheets.spreadsheets.values.get({ spreadsheetId, range: `'${tab}'!A1:Z3000`, valueRenderOption: 'FORMATTED_VALUE' })
  return parseTrackerSheet((res.data.values ?? []) as unknown[][])
}

export async function clientCandidates(): Promise<ClientCandidate[]> {
  const clients = await prisma.client.findMany({
    select: { id: true, name: true, contactName: true, contactEmail: true, intakes: { select: { leadEmail: true, businessName: true, fullName: true } } },
  })
  return clients.map((c) => ({
    id: c.id,
    emails: [c.contactEmail, ...c.intakes.map((i) => i.leadEmail)],
    businesses: [c.name, ...c.intakes.map((i) => i.businessName)],
    names: [c.contactName, ...c.intakes.map((i) => i.fullName)],
  }))
}

export type BackfillSummary = {
  dryRun: boolean
  at: string
  headers: string[]
  missingHeaders: string[]
  counts: Record<BackfillOp['kind'], number>
  ops: BackfillOp[]
  error: string | null
}

export async function backfillFromSheet(opts: { dryRun?: boolean; actor?: string | null; sheet?: ParsedSheet } = {}): Promise<BackfillSummary> {
  const dryRun = opts.dryRun ?? true
  const summary: BackfillSummary = { dryRun, at: new Date().toISOString(), headers: [], missingHeaders: [], counts: { create: 0, update: 0, unchanged: 0, unmatched: 0 }, ops: [], error: null }
  try {
    const sheet = opts.sheet ?? (await readTrackerSheet())
    summary.headers = sheet.headers
    summary.missingHeaders = sheet.missingHeaders
    const existing = (await prisma.clientTracker.findMany()).map((t): TrackerRowState => ({ ...t, extra: (t.extra as Record<string, string> | null) ?? null }))
    const ops = planBackfill(sheet, await clientCandidates(), existing)
    summary.ops = ops
    for (const op of ops) summary.counts[op.kind]++
    if (!dryRun) await applyBackfill(ops, opts.actor ?? 'sheet-sync')
    if (!dryRun) {
      const value = JSON.stringify({ ...summary, ops: undefined })
      await prisma.appSetting.upsert({ where: { key: STATUS_KEY }, create: { key: STATUS_KEY, value }, update: { value } })
    }
  } catch (err) {
    summary.error = err instanceof Error ? err.message : String(err)
    console.error('[tracker] sheet backfill failed:', summary.error)
  }
  return summary
}

async function applyBackfill(ops: BackfillOp[], actor: string) {
  const now = new Date()
  for (const op of ops) {
    if (op.kind !== 'create' && op.kind !== 'update') continue
    const events = op.doneSteps.map((s) => prisma.clientJourneyEvent.create({
      data: { clientId: op.clientId, stage: `tracker.${s}`, fromStatus: op.kind === 'create' ? null : 'pending', toStatus: 'done', note: `From sheet row ${op.sheetRow}`, actor },
    }))
    const { extra, ...rest } = op.data
    const extraValue = extra === undefined ? undefined : extra === null ? Prisma.DbNull : (extra as Prisma.InputJsonValue)
    if (op.kind === 'create') {
      await prisma.$transaction([
        prisma.clientTracker.create({ data: { ...(rest as Omit<typeof rest, 'extra'>), extra: extraValue, clientId: op.clientId, source: 'sheet', sheetSyncedAt: now } as Prisma.ClientTrackerUncheckedCreateInput }),
        ...events,
      ])
    } else {
      await prisma.$transaction([
        prisma.clientTracker.update({ where: { clientId: op.clientId }, data: { ...rest, extra: extraValue, sheetSyncedAt: now } as Prisma.ClientTrackerUncheckedUpdateInput }),
        ...events,
      ])
    }
  }
}

export async function lastSheetSync(): Promise<Omit<BackfillSummary, 'ops'> | null> {
  const row = await prisma.appSetting.findUnique({ where: { key: STATUS_KEY } })
  try {
    return row ? JSON.parse(row.value) : null
  } catch {
    return null
  }
}
