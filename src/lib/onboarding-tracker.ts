import { prisma } from '@/lib/prisma'
import { getSheetsClient, getWriterAccountEmail } from '@/lib/drive'

/**
 * Ethan's "Client Onboarding Tracker" Google Sheet: one row per client,
 * with ✅ / ❌ columns for each onboarding step. The Hub ticks the steps it
 * knows happened:
 *
 *   Sign-Up Link Completed     ← a new Whop membership (whop-signup-alerts.ts)
 *   Intake Form Completed      ← a finished onboarding form (client-intake-ingest.ts)
 *   Automations Configuration  ← "Mark Completed" on the Automation Copy board
 *   A2P Submitted              ← "Mark Complete" on the A2P board
 *
 * Rows are matched by Contact Email first, then Business, then Client
 * Name. A client with no row yet gets one appended. Columns are found by
 * their header text, so reordering the sheet doesn't break this. Writes
 * go through the Hub's Google sign-in (alex@leadgenisys.com), which needs
 * edit access to the sheet.
 */

const DEFAULT_SHEET_ID = '1-xDJVi6HpntUJUWrZWi6rPTmDamyHytKi_aLttL-UU4'
const SHEET_ID_KEY = 'onboardingTracker.sheetId'
const DONE = '✅'

export const TRACKER_STEPS = {
  signup: 'Sign-Up Link Completed',
  intake: 'Intake Form Completed',
  automations: 'Automations Configuration',
  a2p: 'A2P Submitted',
} as const
export type TrackerStep = keyof typeof TRACKER_STEPS

export type TrackerWho = {
  emails?: (string | null | undefined)[]
  business?: string | null
  name?: string | null
}

export type TrackerResult = {
  ok: boolean
  /** 'updated' = ticked; 'already' = was ticked; 'added' = new row with the tick; 'not_found' = no row and none added. */
  action: 'updated' | 'already' | 'added' | 'not_found' | 'error'
  row: number | null
  detail: string
}

const norm = (s: string | null | undefined) =>
  (s ?? '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\b(llc|inc|co|corp|the|com|org|net)\b/g, ' ')
    // "Alwaystherelawncare" = "Always there lawn care".
    .replace(/\s+/g, '')

const colLetter = (i: number) => {
  let n = i + 1
  let s = ''
  while (n > 0) {
    const m = (n - 1) % 26
    s = String.fromCharCode(65 + m) + s
    n = Math.floor((n - 1) / 26)
  }
  return s
}

async function sheet() {
  const row = await prisma.appSetting.findUnique({ where: { key: SHEET_ID_KEY } })
  const spreadsheetId = row?.value.trim() || DEFAULT_SHEET_ID
  const account = await getWriterAccountEmail()
  const sheets = await getSheetsClient(account)
  // The first tab, whatever it's called.
  const meta = await sheets.spreadsheets.get({ spreadsheetId, fields: 'sheets(properties(title,index))' })
  const tab = meta.data.sheets?.find((s) => s.properties?.index === 0)?.properties?.title ?? 'Sheet1'
  const res = await sheets.spreadsheets.values.get({ spreadsheetId, range: `'${tab}'!A1:Z3000`, valueRenderOption: 'FORMATTED_VALUE' })
  const values = (res.data.values ?? []) as string[][]
  const headers = (values[0] ?? []).map((h) => String(h ?? '').trim())
  const col = (name: string) => headers.findIndex((h) => h.toLowerCase() === name.toLowerCase())
  return { sheets, spreadsheetId, tab, account, values, headers, col }
}

function findRow(values: string[][], col: (n: string) => number, who: TrackerWho): number | null {
  const emailCol = col('Contact Email')
  const bizCol = col('Business')
  const nameCol = col('Client Name')
  const emails = new Set((who.emails ?? []).map((e) => (e ?? '').trim().toLowerCase()).filter(Boolean))
  const biz = norm(who.business)
  const name = norm(who.name)
  const rows = values.slice(1)
  const pick = (test: (r: string[]) => boolean) => {
    const i = rows.findIndex(test)
    return i === -1 ? null : i + 2 // 1-based, after the header
  }
  return (
    (emails.size && emailCol >= 0 ? pick((r) => emails.has(String(r[emailCol] ?? '').trim().toLowerCase())) : null) ??
    (biz && bizCol >= 0 ? pick((r) => norm(r[bizCol]) === biz) : null) ??
    (name && nameCol >= 0 ? pick((r) => norm(r[nameCol]) === name) : null)
  )
}

const today = () => new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', month: '2-digit', day: '2-digit', year: 'numeric' }).format(new Date())

/**
 * Tick one step for a client. Never unticks, never touches other columns
 * of an existing row. `addIfMissing` appends a row (name, business, email,
 * start date, the tick) when nobody matches.
 */
export async function markTrackerStep(step: TrackerStep, who: TrackerWho, opts: { addIfMissing?: boolean } = {}): Promise<TrackerResult> {
  const header = TRACKER_STEPS[step]
  try {
    const s = await sheet()
    const c = s.col(header)
    if (c < 0) return { ok: false, action: 'error', row: null, detail: `The sheet has no "${header}" column.` }
    const row = findRow(s.values, s.col, who)
    if (row) {
      // Fill a blank name / business / email on the row (a row added at Whop sign-up has no business yet). Never overwrites.
      const blanks: [string, string | null | undefined][] = [
        ['Client Name', who.name],
        ['Business', who.business],
        ['Contact Email', (who.emails ?? []).find((e) => !!e?.trim())],
      ]
      for (const [h, v] of blanks) {
        const i = s.col(h)
        if (i >= 0 && v?.trim() && !String(s.values[row - 1]?.[i] ?? '').trim()) {
          await s.sheets.spreadsheets.values.update({
            spreadsheetId: s.spreadsheetId,
            range: `'${s.tab}'!${colLetter(i)}${row}`,
            valueInputOption: 'USER_ENTERED',
            requestBody: { values: [[v.trim()]] },
          })
        }
      }
      if ((s.values[row - 1]?.[c] ?? '').trim() === DONE) return { ok: true, action: 'already', row, detail: `Row ${row} already ticked` }
      await s.sheets.spreadsheets.values.update({
        spreadsheetId: s.spreadsheetId,
        range: `'${s.tab}'!${colLetter(c)}${row}`,
        valueInputOption: 'USER_ENTERED',
        requestBody: { values: [[DONE]] },
      })
      return { ok: true, action: 'updated', row, detail: `Ticked "${header}" on row ${row}` }
    }
    if (!opts.addIfMissing) return { ok: false, action: 'not_found', row: null, detail: 'No row in the onboarding tracker matches this client (by email, business or name).' }
    const cells: string[] = new Array(s.headers.length).fill('')
    const set = (h: string, v: string | null | undefined) => {
      const i = s.col(h)
      if (i >= 0 && v) cells[i] = v
    }
    set('Client Name', who.name ?? null)
    set('Business', who.business ?? null)
    set('Contact Email', (who.emails ?? []).find((e) => !!e?.trim()) ?? null)
    set('Start Date', today())
    cells[c] = DONE
    // Below the last row that has anything in it.
    const last = s.values.reduce((n, r, i) => (r.some((x) => String(x ?? '').trim()) ? i + 1 : n), 1)
    const at = last + 1
    await s.sheets.spreadsheets.values.update({
      spreadsheetId: s.spreadsheetId,
      range: `'${s.tab}'!A${at}:${colLetter(cells.length - 1)}${at}`,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [cells] },
    })
    return { ok: true, action: 'added', row: at, detail: `Added row ${at} with "${header}" ticked` }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    const hint = /permission|403|not have access|caller does not/i.test(msg)
      ? ' The Hub’s Google account (alex@leadgenisys.com) needs edit access to the onboarding tracker sheet.'
      : ''
    console.error(`[onboarding-tracker] ${header}: ${msg}`)
    return { ok: false, action: 'error', row: null, detail: `${msg}${hint}` }
  }
}

/** Where a client stands in the tracker, for the Automation Copy board. Read-only. */
export async function trackerRowFor(who: TrackerWho): Promise<{ ok: boolean; row: number | null; steps: Record<string, string>; detail: string | null }> {
  try {
    const s = await sheet()
    const row = findRow(s.values, s.col, who)
    if (!row) return { ok: true, row: null, steps: {}, detail: 'No row for this client in the onboarding tracker yet.' }
    const steps: Record<string, string> = {}
    s.headers.forEach((h, i) => {
      if (h) steps[h] = String(s.values[row - 1]?.[i] ?? '')
    })
    return { ok: true, row, steps, detail: null }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return { ok: false, row: null, steps: {}, detail: msg }
  }
}

/** How a Hub client is found in the tracker: their onboarding email and contact email, business and owner name. */
export async function trackerWhoForClient(clientId: string): Promise<TrackerWho | null> {
  const client = await prisma.client.findUnique({
    where: { id: clientId },
    select: {
      name: true,
      contactName: true,
      contactEmail: true,
      intakes: { orderBy: { receivedAt: 'desc' }, take: 1, select: { leadEmail: true, fullName: true, businessName: true } },
    },
  })
  if (!client) return null
  const intake = client.intakes[0]
  return {
    emails: [intake?.leadEmail, client.contactEmail],
    business: intake?.businessName || client.name,
    name: intake?.fullName || client.contactName,
  }
}
