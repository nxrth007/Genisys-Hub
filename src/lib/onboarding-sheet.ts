import { prisma } from '@/lib/prisma'
import { getSheetsClient, getWriterAccountEmail } from '@/lib/drive'
import { ingestIntake, str } from '@/lib/client-intake-ingest'

/**
 * The onboarding form's Google Sheet, read by the Hub itself.
 *
 * The form writes every submission to this sheet first and only then
 * tries to forward it to the Hub's webhook — a step that silently does
 * nothing when the form's forwarding address isn't set. So the sheet is
 * the record that can't be missed: every few minutes the Hub reads it and
 * takes in any row it doesn't already have. The webhook stays the fast
 * path; this is the net under it.
 */

const SHEET_ID_KEY = 'onboarding.sheetId'
const STATUS_KEY = 'onboarding.sheetSync'
/** The sheet the form at clientonboarding.leadgenisys.com appends to. */
const DEFAULT_SHEET_ID = '1NGkkUtVM0tf1J8G8ibCLQ0LIB9RK_EtnXgipHizYCIs'
const TAB = 'Sheet1'
/** Leave very fresh rows to the webhook, so the two paths don't race. */
const SETTLE_MS = 3 * 60_000

type ColumnId =
  | 'timestamp' | 'ein' | 'fullName' | 'businessName' | 'businessContact' | 'businessAddress'
  | 'customerPhone' | 'areaCode' | 'timeZone' | 'leadEmail' | 'cities' | 'website'
  | 'aboutBusiness' | 'mainServices' | 'promotions' | 'socialLinks' | 'whyChooseYou'
  | 'brandColors' | 'faqs' | 'files' | 'bringingOwnDomain' | 'domainName'

/** The order the form writes columns in — the fallback when a header isn't recognised. */
const COLUMN_ORDER: ColumnId[] = [
  'timestamp', 'ein', 'fullName', 'businessName', 'businessContact', 'businessAddress',
  'customerPhone', 'areaCode', 'timeZone', 'leadEmail', 'cities', 'website',
  'aboutBusiness', 'mainServices', 'promotions', 'socialLinks', 'whyChooseYou',
  'brandColors', 'faqs', 'files', 'bringingOwnDomain', 'domainName',
]

/** Header wording changes ("Business Name" became "Legal Business Name"); match on what stays. */
const HEADER_HINTS: [RegExp, ColumnId][] = [
  [/^timestamp/i, 'timestamp'],
  [/\bein\b/i, 'ein'],
  [/^full name/i, 'fullName'],
  [/business name/i, 'businessName'],
  [/business contact/i, 'businessContact'],
  [/business address/i, 'businessAddress'],
  [/best phone number/i, 'customerPhone'],
  [/area code/i, 'areaCode'],
  [/time zone/i, 'timeZone'],
  [/best email/i, 'leadEmail'],
  [/cities/i, 'cities'],
  [/website link/i, 'website'],
  [/about the business/i, 'aboutBusiness'],
  [/main services/i, 'mainServices'],
  [/promotions/i, 'promotions'],
  [/social media/i, 'socialLinks'],
  [/why customers/i, 'whyChooseYou'],
  [/brand colors/i, 'brandColors'],
  [/faqs/i, 'faqs'],
  [/marketing content/i, 'files'],
  [/bringing your own domain/i, 'bringingOwnDomain'],
  [/what is your domain/i, 'domainName'],
]

export type SheetSyncStatus = {
  ok: boolean
  checkedAt: string
  /** Submissions in the sheet (blank rows excluded). */
  sheetRows: number
  /** Rows taken into the Hub on this pass. */
  imported: { businessName: string | null; at: string | null }[]
  /** Total rows ever recovered from the sheet rather than delivered by the webhook. */
  recoveredTotal: number
  error: string | null
  account: string | null
}

async function sheetId(): Promise<string> {
  const row = await prisma.appSetting.findUnique({ where: { key: SHEET_ID_KEY } })
  return row?.value.trim() || DEFAULT_SHEET_ID
}

export async function getSheetSyncStatus(): Promise<SheetSyncStatus | null> {
  const row = await prisma.appSetting.findUnique({ where: { key: STATUS_KEY } })
  if (!row) return null
  try {
    return JSON.parse(row.value) as SheetSyncStatus
  } catch {
    return null
  }
}

async function saveStatus(status: SheetSyncStatus): Promise<void> {
  await prisma.appSetting.upsert({
    where: { key: STATUS_KEY },
    create: { key: STATUS_KEY, value: JSON.stringify(status) },
    update: { value: JSON.stringify(status) },
  })
}

function columnsFor(headers: string[]): (ColumnId | null)[] {
  const used = new Set<ColumnId>()
  const out: (ColumnId | null)[] = headers.map((h) => {
    const hit = HEADER_HINTS.find(([re, id]) => re.test(h.trim()) && !used.has(id))
    if (hit) used.add(hit[1])
    return hit?.[1] ?? null
  })
  // Anything unrecognised falls back to the form's known column order.
  out.forEach((id, i) => {
    const fallback = COLUMN_ORDER[i]
    if (!id && fallback && !used.has(fallback)) {
      out[i] = fallback
      used.add(fallback)
    }
  })
  return out
}

function parseTimestamp(raw: string | undefined): Date | null {
  const v = raw?.trim()
  if (!v) return null
  const d = new Date(v)
  return Number.isNaN(d.getTime()) ? null : d
}

const norm = (s: string | null | undefined) => (s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()

function friendlyError(err: unknown, account: string | null): string {
  const e = err as { code?: number; status?: number; message?: string }
  const code = e?.code ?? e?.status
  if (code === 403 || code === 404) {
    return `The Hub's Google account${account ? ` (${account})` : ''} can't open the onboarding sheet. Share the sheet with that address (Viewer is enough).`
  }
  if (code === 401 || /invalid_grant|invalid credentials/i.test(e?.message ?? '')) {
    return `The Hub's Google connection${account ? ` for ${account}` : ''} has expired. Reconnect it under Settings → Drive accounts.`
  }
  return e?.message ?? 'Could not read the onboarding sheet.'
}

/**
 * Read the sheet and take in every submission the Hub doesn't have yet.
 * Never throws — the outcome (including why it couldn't read the sheet)
 * is returned and saved for the Clients page to show.
 */
export async function reconcileOnboardingSheet(): Promise<SheetSyncStatus> {
  const previous = await getSheetSyncStatus().catch(() => null)
  const status: SheetSyncStatus = {
    ok: false,
    checkedAt: new Date().toISOString(),
    sheetRows: previous?.sheetRows ?? 0,
    imported: [],
    recoveredTotal: previous?.recoveredTotal ?? 0,
    error: null,
    account: null,
  }

  try {
    status.account = await getWriterAccountEmail()
    const sheets = await getSheetsClient(status.account)
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: await sheetId(),
      range: `${TAB}!A1:AZ5000`,
      valueRenderOption: 'FORMATTED_VALUE',
    })
    const values = (res.data.values ?? []) as string[][]
    const headers = (values[0] ?? []).map((h) => String(h ?? ''))
    const cols = columnsFor(headers)

    const rows = values.slice(1).map((cells) => {
      const answers: Record<string, string> = {}
      const labels: Record<string, string> = {}
      let timestamp: string | undefined
      let files: string[] = []
      cols.forEach((id, i) => {
        const value = String(cells[i] ?? '').trim()
        if (headers[i]) labels[headers[i]] = value
        if (!id) return
        if (id === 'timestamp') timestamp = value
        else if (id === 'files') files = value.split(/\s*\n\s*/).filter((f) => /^https?:\/\//i.test(f))
        else answers[id] = value
      })
      return { answers, labels, files, at: parseTimestamp(timestamp) }
    })
    // A row with no name, business or email isn't a submission.
    const submissions = rows.filter((r) => str(r.answers.businessName) || str(r.answers.fullName) || str(r.answers.leadEmail))
    status.sheetRows = submissions.length

    const existing = await prisma.clientIntake.findMany({ select: { receivedAt: true, businessName: true, leadEmail: true } })
    const now = Date.now()
    for (const row of submissions) {
      if (row.at && now - row.at.getTime() < SETTLE_MS) continue
      const business = norm(row.answers.businessName)
      const email = norm(row.answers.leadEmail)
      const already = existing.some((e) => {
        const dt = row.at ? Math.abs(e.receivedAt.getTime() - row.at.getTime()) : null
        if (dt !== null && dt <= 90_000) return true
        // Timestamps can be re-formatted by the sheet; the same business
        // (or lead email) within a day and a half is the same submission.
        const sameWho = (business && norm(e.businessName) === business) || (email && norm(e.leadEmail) === email)
        return !!sameWho && (dt === null || dt <= 36 * 3_600_000)
      })
      if (already) continue

      const result = await ingestIntake(
        {
          event: 'intake.submitted',
          ...(row.at ? { submittedAt: row.at.toISOString() } : {}),
          source: 'onboarding-sheet',
          answers: row.answers,
          labels: row.labels,
          files: row.files,
        },
        'sheet',
      )
      if (!result.duplicate) {
        status.imported.push({ businessName: str(row.answers.businessName), at: row.at?.toISOString() ?? null })
        existing.push({ receivedAt: row.at ?? new Date(), businessName: row.answers.businessName ?? null, leadEmail: row.answers.leadEmail ?? null })
      }
    }
    status.recoveredTotal += status.imported.length
    status.ok = true
  } catch (err) {
    status.error = friendlyError(err, status.account)
    console.error('[onboarding-sheet] reconcile failed:', err)
  }

  await saveStatus(status).catch((err) => console.error('[onboarding-sheet] could not save status:', err))
  return status
}
