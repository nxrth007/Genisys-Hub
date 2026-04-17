/**
 * Google Drive helper — mirrors the Gmail integration pattern.
 *
 * Uses the same Google OAuth client as Auth.js SSO (AUTH_GOOGLE_ID/SECRET)
 * with its own redirect URI at /api/drive/callback so we can request
 * Drive-specific scopes independently of Gmail. Google handles incremental
 * consent — clicking "Connect Drive" only surfaces the new scope.
 *
 * Each connected mailbox is stored in DriveAccount. Access tokens auto-refresh
 * via googleapis' token listener.
 *
 * The public list functions operate over ALL connected accounts and merge
 * the results so the UI can show everything accessible to Alex + Ethan in
 * one place.
 */
import { google, type drive_v3 } from 'googleapis'
import { prisma } from './prisma'

export type DriveFile = {
  id: string
  name: string
  mimeType: string
  // Which connected mailbox the file came from (so the UI can label it).
  // When multiple accounts can see the same file, this is the first one
  // that returned it — useful for a default "viewing as" choice.
  sourceAccount: string
  // Every connected mailbox whose Drive listing returned this file. Used by the
  // preview modal to offer an account switcher via ?authuser=<email>, which
  // fixes "you need editor access" errors that show up when Chrome's default
  // Google session differs from the one that actually has permission.
  visibleToAccounts: string[]
  iconLink?: string | null
  webViewLink?: string | null
  thumbnailLink?: string | null
  size?: string | null
  modifiedTime?: string | null
  createdTime?: string | null
  owners?: Array<{ displayName?: string | null; emailAddress?: string | null }>
  lastModifyingUser?: { displayName?: string | null; emailAddress?: string | null } | null
  shared?: boolean | null
  starred?: boolean | null
  trashed?: boolean | null
  parents?: string[] | null
}

const FILE_FIELDS =
  'nextPageToken, files(id, name, mimeType, iconLink, webViewLink, thumbnailLink, size, modifiedTime, createdTime, owners(displayName,emailAddress), lastModifyingUser(displayName,emailAddress), shared, starred, trashed, parents)'

function getRedirectUri(baseUrl?: string): string {
  const base = baseUrl || process.env.AUTH_URL || 'http://localhost:3000'
  return `${base}/api/drive/callback`
}

export function getPublicOrigin(req: {
  headers: { get(name: string): string | null }
}): string {
  const proto = req.headers.get('x-forwarded-proto') || 'https'
  const host = req.headers.get('host')
  if (host) return `${proto}://${host}`
  return process.env.AUTH_URL || 'http://localhost:3000'
}

function getOAuth2Client(baseUrl?: string) {
  return new google.auth.OAuth2(
    process.env.AUTH_GOOGLE_ID,
    process.env.AUTH_GOOGLE_SECRET,
    getRedirectUri(baseUrl)
  )
}

export function getAuthUrl(baseUrl?: string, state?: string) {
  const oauth2Client = getOAuth2Client(baseUrl)
  return oauth2Client.generateAuthUrl({
    access_type: 'offline',
    // Force consent so we always get a refresh_token on re-connects.
    prompt: 'consent',
    scope: [
      // Full Drive access — required for create/rename/trash/upload operations
      // and for Sheets API read/write on arbitrary existing files. Previously
      // drive.readonly; anyone who connected before this change must reconnect
      // for write features to work.
      'https://www.googleapis.com/auth/drive',
      // Explicit Sheets scope so the Sheets API calls don't rely on Drive
      // scope inheritance (and so future scope narrowing is easier).
      'https://www.googleapis.com/auth/spreadsheets',
      'https://www.googleapis.com/auth/userinfo.email',
    ],
    state,
  })
}

export async function exchangeCode(code: string, baseUrl?: string) {
  const oauth2Client = getOAuth2Client(baseUrl)
  const { tokens } = await oauth2Client.getToken(code)
  oauth2Client.setCredentials(tokens)

  const oauth2 = google.oauth2({ version: 'v2', auth: oauth2Client })
  const { data: userInfo } = await oauth2.userinfo.get()

  if (!userInfo.email) throw new Error('No email returned from Google')
  if (!tokens.access_token) throw new Error('No access token')

  const account = await prisma.driveAccount.upsert({
    where: { email: userInfo.email },
    update: {
      accessToken: tokens.access_token,
      ...(tokens.refresh_token ? { refreshToken: tokens.refresh_token } : {}),
      tokenExpiry: new Date(tokens.expiry_date || Date.now() + 3600_000),
    },
    create: {
      email: userInfo.email,
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token || '',
      tokenExpiry: new Date(tokens.expiry_date || Date.now() + 3600_000),
    },
  })

  return account
}

export async function getAuthenticatedClient(accountEmail: string) {
  const account = await prisma.driveAccount.findUnique({ where: { email: accountEmail } })
  if (!account) throw new Error(`No Drive account found for ${accountEmail}`)

  const oauth2Client = getOAuth2Client()
  oauth2Client.setCredentials({
    access_token: account.accessToken,
    refresh_token: account.refreshToken,
    expiry_date: account.tokenExpiry.getTime(),
  })

  oauth2Client.on('tokens', async (newTokens) => {
    await prisma.driveAccount.update({
      where: { email: accountEmail },
      data: {
        accessToken: newTokens.access_token || account.accessToken,
        tokenExpiry: newTokens.expiry_date
          ? new Date(newTokens.expiry_date)
          : account.tokenExpiry,
      },
    })
  })

  return { drive: google.drive({ version: 'v3', auth: oauth2Client }), account }
}

function normalize(file: drive_v3.Schema$File, sourceAccount: string): DriveFile | null {
  if (!file.id || !file.name || !file.mimeType) return null
  return {
    id: file.id,
    name: file.name,
    mimeType: file.mimeType,
    sourceAccount,
    visibleToAccounts: [sourceAccount],
    iconLink: file.iconLink ?? null,
    webViewLink: file.webViewLink ?? null,
    thumbnailLink: file.thumbnailLink ?? null,
    size: file.size ?? null,
    modifiedTime: file.modifiedTime ?? null,
    createdTime: file.createdTime ?? null,
    owners: file.owners ?? undefined,
    lastModifyingUser: file.lastModifyingUser ?? null,
    shared: file.shared ?? null,
    starred: file.starred ?? null,
    trashed: file.trashed ?? null,
    parents: file.parents ?? null,
  }
}

export type ListOptions = {
  /** Free-text search. Matches name + fullText. */
  query?: string
  /** 'all' (default) | 'folders' | 'docs' | 'sheets' | 'slides' | 'pdf' | 'images' */
  kind?: string
  /** 'any' (default) | 'mine' | 'shared' | 'starred' */
  ownership?: string
  /** Drive parent folder ID — list children of this folder. */
  parentId?: string
  /** Max files per account. */
  pageSize?: number
  /** Limit to a single connected account, else query all. */
  accountEmail?: string
}

function buildQ(opts: ListOptions): string {
  const clauses: string[] = ['trashed = false']

  if (opts.query) {
    const escaped = opts.query.replace(/\\/g, '\\\\').replace(/'/g, "\\'")
    clauses.push(`(name contains '${escaped}' or fullText contains '${escaped}')`)
  }

  if (opts.parentId) {
    clauses.push(`'${opts.parentId}' in parents`)
  }

  switch (opts.kind) {
    case 'folders':
      clauses.push("mimeType = 'application/vnd.google-apps.folder'")
      break
    case 'docs':
      clauses.push("mimeType = 'application/vnd.google-apps.document'")
      break
    case 'sheets':
      clauses.push("mimeType = 'application/vnd.google-apps.spreadsheet'")
      break
    case 'slides':
      clauses.push("mimeType = 'application/vnd.google-apps.presentation'")
      break
    case 'pdf':
      clauses.push("mimeType = 'application/pdf'")
      break
    case 'images':
      clauses.push("mimeType contains 'image/'")
      break
  }

  switch (opts.ownership) {
    case 'mine':
      clauses.push("'me' in owners")
      break
    case 'shared':
      clauses.push('sharedWithMe = true')
      break
    case 'starred':
      clauses.push('starred = true')
      break
  }

  return clauses.join(' and ')
}

/**
 * List files for a single connected Drive account.
 */
export async function listFilesForAccount(
  accountEmail: string,
  opts: ListOptions = {}
): Promise<DriveFile[]> {
  const { drive } = await getAuthenticatedClient(accountEmail)
  const q = buildQ(opts)

  const res = await drive.files.list({
    q,
    pageSize: opts.pageSize || 50,
    fields: FILE_FIELDS,
    orderBy: 'modifiedTime desc',
    // Include files from shared drives the user can access.
    includeItemsFromAllDrives: true,
    supportsAllDrives: true,
    corpora: 'user',
  })

  const files = res.data.files || []
  return files.map((f) => normalize(f, accountEmail)).filter((f): f is DriveFile => f !== null)
}

export type AccountError = { account: string; message: string }
export type ListAllResult = { files: DriveFile[]; errors: AccountError[] }

/**
 * Extract the most useful bit of a googleapis error. The SDK throws a GaxiosError
 * whose `.message` is often the full HTML; the real message lives in
 * `.response.data.error.message`. Fall back through increasingly generic fields.
 */
function extractErrorMessage(err: unknown): string {
  if (typeof err === 'object' && err !== null) {
    const e = err as {
      response?: { data?: { error?: { message?: string; errors?: Array<{ message?: string }> } } }
      errors?: Array<{ message?: string }>
      message?: string
    }
    const fromResponse = e.response?.data?.error?.message
    if (fromResponse) return fromResponse
    const fromErrors = e.response?.data?.error?.errors?.[0]?.message || e.errors?.[0]?.message
    if (fromErrors) return fromErrors
    if (e.message) return e.message
  }
  return 'Unknown error'
}

/**
 * List files across ALL connected Drive accounts, merged and deduped by file id.
 * When the same file is visible to both Alex and Ethan, the first hit wins — so
 * sourceAccount reflects whichever account returned it first.
 *
 * Per-account failures are collected in `errors` so the UI can explain why a
 * mailbox returned zero files (scope issue, revoked consent, quota, etc.)
 * instead of showing a blank list.
 */
export async function listFilesAll(opts: ListOptions = {}): Promise<ListAllResult> {
  const accounts = await prisma.driveAccount.findMany({
    where: opts.accountEmail ? { email: opts.accountEmail } : undefined,
    select: { email: true },
  })

  if (accounts.length === 0) return { files: [], errors: [] }

  const settled = await Promise.allSettled(
    accounts.map((a) => listFilesForAccount(a.email, opts))
  )

  const merged = new Map<string, DriveFile>()
  const errors: AccountError[] = []

  settled.forEach((r, i) => {
    const email = accounts[i].email
    if (r.status === 'fulfilled') {
      for (const f of r.value) {
        const existing = merged.get(f.id)
        if (existing) {
          // Same file visible to a second account — track it so the preview
          // modal can offer an account switcher.
          if (!existing.visibleToAccounts.includes(email)) {
            existing.visibleToAccounts.push(email)
          }
        } else {
          merged.set(f.id, f)
        }
      }
    } else {
      const message = extractErrorMessage(r.reason)
      console.error(`[drive] list failed for ${email}:`, message)
      errors.push({ account: email, message })
    }
  })

  const files = Array.from(merged.values()).sort((a, b) => {
    const ma = a.modifiedTime ? new Date(a.modifiedTime).getTime() : 0
    const mb = b.modifiedTime ? new Date(b.modifiedTime).getTime() : 0
    return mb - ma
  })

  return { files, errors }
}

export async function getFile(accountEmail: string, fileId: string): Promise<DriveFile | null> {
  const { drive } = await getAuthenticatedClient(accountEmail)
  const res = await drive.files.get({
    fileId,
    fields:
      'id, name, mimeType, iconLink, webViewLink, thumbnailLink, size, modifiedTime, createdTime, owners(displayName,emailAddress), lastModifyingUser(displayName,emailAddress), shared, starred, trashed, parents',
    supportsAllDrives: true,
  })
  return normalize(res.data, accountEmail)
}

export async function listConnectedAccounts() {
  return prisma.driveAccount.findMany({
    select: {
      id: true,
      email: true,
      createdAt: true,
      updatedAt: true,
      lastSyncedAt: true,
    },
    orderBy: { email: 'asc' },
  })
}

export async function disconnectAccount(email: string) {
  return prisma.driveAccount.delete({ where: { email } })
}

// ---------------------------------------------------------------------------
// File management — create / rename / star / trash / breadcrumbs.
// Each op takes the accountEmail whose token will perform it; the caller
// should pick an account that the target file is visible to.
// ---------------------------------------------------------------------------

const NEW_FILE_MIME: Record<string, string> = {
  document: 'application/vnd.google-apps.document',
  spreadsheet: 'application/vnd.google-apps.spreadsheet',
  presentation: 'application/vnd.google-apps.presentation',
  folder: 'application/vnd.google-apps.folder',
}

export async function createFile(
  accountEmail: string,
  params: { kind: keyof typeof NEW_FILE_MIME; name: string; parentId?: string }
) {
  const { drive } = await getAuthenticatedClient(accountEmail)
  const mimeType = NEW_FILE_MIME[params.kind]
  if (!mimeType) throw new Error(`Unknown file kind: ${params.kind}`)

  const res = await drive.files.create({
    requestBody: {
      name: params.name,
      mimeType,
      parents: params.parentId ? [params.parentId] : undefined,
    },
    fields: 'id, name, mimeType, webViewLink',
    supportsAllDrives: true,
  })
  return res.data
}

export async function renameFile(
  accountEmail: string,
  fileId: string,
  name: string
) {
  const { drive } = await getAuthenticatedClient(accountEmail)
  const res = await drive.files.update({
    fileId,
    requestBody: { name },
    fields: 'id, name',
    supportsAllDrives: true,
  })
  return res.data
}

export async function setStarred(
  accountEmail: string,
  fileId: string,
  starred: boolean
) {
  const { drive } = await getAuthenticatedClient(accountEmail)
  const res = await drive.files.update({
    fileId,
    requestBody: { starred },
    fields: 'id, starred',
    supportsAllDrives: true,
  })
  return res.data
}

/**
 * Soft delete — moves to trash. Drive keeps trashed files for 30 days before
 * permanent deletion, which gives us a safe undo window without implementing
 * our own tombstone logic.
 */
export async function trashFile(accountEmail: string, fileId: string) {
  const { drive } = await getAuthenticatedClient(accountEmail)
  const res = await drive.files.update({
    fileId,
    requestBody: { trashed: true },
    fields: 'id, trashed',
    supportsAllDrives: true,
  })
  return res.data
}

/**
 * Resolve a folder's ancestry chain for breadcrumbs. Walks upward until it
 * hits a root (My Drive or a Shared Drive root) or a folder the caller can't
 * read. Stops at 10 levels as a safety bound.
 */
export async function getFolderAncestry(
  accountEmail: string,
  folderId: string
): Promise<Array<{ id: string; name: string }>> {
  const { drive } = await getAuthenticatedClient(accountEmail)
  const crumbs: Array<{ id: string; name: string }> = []
  let current: string | null = folderId
  for (let i = 0; i < 10 && current; i++) {
    try {
      // Explicit annotation because the googleapis files.get overload matrix
      // confuses TS's recursive inference in the loop scope.
      const data: drive_v3.Schema$File = (
        await drive.files.get({
          fileId: current,
          fields: 'id, name, parents',
          supportsAllDrives: true,
        })
      ).data
      if (data.id && data.name) {
        crumbs.unshift({ id: data.id, name: data.name })
      }
      current = data.parents?.[0] || null
    } catch {
      break
    }
  }
  return crumbs
}

// ---------------------------------------------------------------------------
// Sheets API — structured read of spreadsheet tabs + values.
// ---------------------------------------------------------------------------

export type SheetTab = {
  id: number
  title: string
  rowCount: number
  columnCount: number
  gridIndex: number
}

export type SheetData = {
  title: string
  tabs: SheetTab[]
  /** Which tab these values belong to. */
  activeTab: string
  /** 2D array of stringified cell values, row-major. */
  values: string[][]
}

async function getAuthenticatedSheets(accountEmail: string) {
  const account = await prisma.driveAccount.findUnique({ where: { email: accountEmail } })
  if (!account) throw new Error(`No Drive account found for ${accountEmail}`)

  const oauth2Client = getOAuth2Client()
  oauth2Client.setCredentials({
    access_token: account.accessToken,
    refresh_token: account.refreshToken,
    expiry_date: account.tokenExpiry.getTime(),
  })

  oauth2Client.on('tokens', async (newTokens) => {
    await prisma.driveAccount.update({
      where: { email: accountEmail },
      data: {
        accessToken: newTokens.access_token || account.accessToken,
        tokenExpiry: newTokens.expiry_date
          ? new Date(newTokens.expiry_date)
          : account.tokenExpiry,
      },
    })
  })

  return google.sheets({ version: 'v4', auth: oauth2Client })
}

/**
 * Fetch a spreadsheet's tab list + the values of one tab (default: first tab).
 * Values come back as `FORMATTED_VALUE` so numbers/dates match what the user
 * sees in Google Sheets rather than raw serial numbers.
 */
export async function getSheetData(
  accountEmail: string,
  spreadsheetId: string,
  tabTitle?: string
): Promise<SheetData> {
  const sheets = await getAuthenticatedSheets(accountEmail)

  const meta = await sheets.spreadsheets.get({
    spreadsheetId,
    fields: 'properties.title,sheets.properties',
  })

  const tabs: SheetTab[] = (meta.data.sheets || []).map((s, i) => ({
    id: s.properties?.sheetId ?? i,
    title: s.properties?.title || `Sheet${i + 1}`,
    rowCount: s.properties?.gridProperties?.rowCount ?? 0,
    columnCount: s.properties?.gridProperties?.columnCount ?? 0,
    gridIndex: s.properties?.index ?? i,
  }))

  if (tabs.length === 0) {
    return {
      title: meta.data.properties?.title || 'Spreadsheet',
      tabs: [],
      activeTab: '',
      values: [],
    }
  }

  // Pick requested tab, or fall back to the one Sheets treats as "first".
  const target =
    (tabTitle && tabs.find((t) => t.title === tabTitle)) ||
    tabs.slice().sort((a, b) => a.gridIndex - b.gridIndex)[0]

  // Range = the whole tab by name. Sheets auto-trims to the used region.
  const resp = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `'${target.title.replace(/'/g, "''")}'`,
    valueRenderOption: 'FORMATTED_VALUE',
    dateTimeRenderOption: 'FORMATTED_STRING',
  })

  // values may be undefined for empty tabs; normalize to 2D of strings.
  const values: string[][] = (resp.data.values || []).map((row) =>
    (row as unknown[]).map((cell) => (cell == null ? '' : String(cell)))
  )

  return {
    title: meta.data.properties?.title || 'Spreadsheet',
    tabs,
    activeTab: target.title,
    values,
  }
}

// ---------------------------------------------------------------------------
// Appointments sheet sync — write path for the /agent portal.
//
// Design:
// - One "master" spreadsheet (id from env MASTER_APPOINTMENTS_SHEET_ID) holds
//   every agent's bookings.
// - One tab per agent, named after the agent on approval (ensureAgentTab),
//   plus a rollup "Master Table" tab that every appointment also lands in.
// - Column order matches what the call center already uses on Google Sheets.
// ---------------------------------------------------------------------------

/** Env-sourced spreadsheet id. Falls back to the one Alex shared on 2026-04-17. */
export function getMasterSpreadsheetId(): string {
  return (
    process.env.MASTER_APPOINTMENTS_SHEET_ID ||
    '10Ms_ppnp5nQ-Xx01u47TPLWauiTWrgUAlFhkLdBhVOA'
  )
}

export const APPOINTMENT_COLUMN_ORDER: Array<{ key: string; header: string }> = [
  { key: 'apptDateTime', header: 'Appt Date and Time' },
  { key: 'customerName', header: "Customer's Name" },
  { key: 'customerPhone', header: "Customer's Phone Number" },
  { key: 'address', header: 'Address' },
  { key: 'email', header: 'Email' },
  { key: 'monthlyBill', header: 'Monthly Bill' },
  { key: 'utilityProvider', header: 'Utility Provider' },
  { key: 'roofType', header: 'Roof Type' },
  { key: 'roofAge', header: 'Roof Age' },
  { key: 'status', header: 'Appointment Status' },
  { key: 'notes', header: 'NOTES' },
  { key: 'callRecordingLink', header: 'Call Recording Link' },
  // Extra columns for provenance tracking in the master rollup. Per-agent
  // tabs skip these (they're implied).
  { key: 'agentName', header: 'Agent Name' },
  { key: 'agentEmail', header: 'Agent Email' },
  { key: 'createdAt', header: 'Logged At' },
]

/** Columns that appear in the per-agent tabs (drop agent* provenance). */
const AGENT_TAB_COLUMNS = APPOINTMENT_COLUMN_ORDER.filter(
  (c) => !['agentName', 'agentEmail'].includes(c.key)
)

/** Columns that appear in the master rollup tab (all of them). */
const MASTER_TAB_COLUMNS = APPOINTMENT_COLUMN_ORDER

/** Default master rollup tab title. Matches the existing sheet. */
export const MASTER_TAB_TITLE = 'Master Table'

export type AppointmentSyncData = {
  apptDateTime: Date | string
  customerName: string
  customerPhone: string
  address: string | null
  email: string | null
  monthlyBill: string | null
  utilityProvider: string | null
  roofType: string | null
  roofAge: string | null
  status: string
  notes: string | null
  callRecordingLink: string | null
  agentName: string | null
  agentEmail: string
  createdAt: Date | string
}

function formatCell(value: unknown): string {
  if (value == null) return ''
  if (value instanceof Date) {
    // Human-readable local-ish format. Sheets will parse back into a date
    // when possible; for our purposes plain string is safest.
    return value.toISOString().replace('T', ' ').replace(/:\d{2}\.\d+Z$/, '')
  }
  return String(value)
}

function buildRow(
  appt: AppointmentSyncData,
  columns: typeof APPOINTMENT_COLUMN_ORDER
): string[] {
  const row: Record<string, unknown> = { ...appt }
  return columns.map((c) => formatCell(row[c.key]))
}

async function getSheetsClient(accountEmail: string) {
  // Reuse the Sheets client we already wire up for the read-only Data view.
  // (Internal helper defined inline to avoid exporting the low-level auth.)
  const account = await prisma.driveAccount.findUnique({ where: { email: accountEmail } })
  if (!account) throw new Error(`No Drive account for ${accountEmail}`)

  const oauth2Client = new google.auth.OAuth2(
    process.env.AUTH_GOOGLE_ID,
    process.env.AUTH_GOOGLE_SECRET
  )
  oauth2Client.setCredentials({
    access_token: account.accessToken,
    refresh_token: account.refreshToken,
    expiry_date: account.tokenExpiry.getTime(),
  })
  oauth2Client.on('tokens', async (newTokens) => {
    await prisma.driveAccount.update({
      where: { email: accountEmail },
      data: {
        accessToken: newTokens.access_token || account.accessToken,
        tokenExpiry: newTokens.expiry_date
          ? new Date(newTokens.expiry_date)
          : account.tokenExpiry,
      },
    })
  })
  return google.sheets({ version: 'v4', auth: oauth2Client })
}

/**
 * Picks a connected Drive account that has access to the master spreadsheet.
 * We prefer alex@leadgenisys.com (the owner per Alex's setup); if not
 * connected, fall back to any connected account. Caller handles the "no
 * accounts connected" case.
 */
async function getWriterAccountEmail(): Promise<string> {
  const preferred = await prisma.driveAccount.findUnique({
    where: { email: 'alex@leadgenisys.com' },
  })
  if (preferred) return preferred.email
  const any = await prisma.driveAccount.findFirst({ orderBy: { email: 'asc' } })
  if (!any) {
    throw new Error(
      'No Google Drive account connected — Alex needs to connect alex@leadgenisys.com under Settings → Drive accounts before agent appointments can sync.'
    )
  }
  return any.email
}

function sanitizeTabName(raw: string): string {
  // Google Sheets tab names: max 100 chars; no [ ] * ? / \. Trim + replace.
  return raw.replace(/[[\]*?/\\]/g, '').slice(0, 100).trim()
}

async function findTabByTitle(
  sheets: ReturnType<typeof google.sheets>,
  spreadsheetId: string,
  title: string
): Promise<{ sheetId: number; title: string } | null> {
  const res = await sheets.spreadsheets.get({
    spreadsheetId,
    fields: 'sheets.properties(sheetId,title)',
  })
  const found = (res.data.sheets || [])
    .map((s) => s.properties)
    .find((p) => p?.title === title)
  if (!found || found.sheetId == null || !found.title) return null
  return { sheetId: found.sheetId, title: found.title }
}

async function writeHeaderRow(
  sheets: ReturnType<typeof google.sheets>,
  spreadsheetId: string,
  tabTitle: string,
  columns: typeof APPOINTMENT_COLUMN_ORDER
) {
  const values = [columns.map((c) => c.header)]
  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `'${tabTitle.replace(/'/g, "''")}'!A1`,
    valueInputOption: 'RAW',
    requestBody: { values },
  })
}

/**
 * Ensures a tab exists for the given agent. If it needs to be created, also
 * seeds the header row. Returns the final tab title (may be sanitized).
 *
 * Called from admin approve action so the tab exists before the agent's
 * first appointment sync.
 */
export async function ensureAgentTab(params: {
  agentName: string | null
  agentEmail: string
}): Promise<string> {
  const spreadsheetId = getMasterSpreadsheetId()
  const accountEmail = await getWriterAccountEmail()
  const sheets = await getSheetsClient(accountEmail)

  // Preferred name: full display name; fall back to email local-part so tabs
  // stay unique even if names collide.
  const base = params.agentName?.trim() || params.agentEmail.split('@')[0]
  const title = sanitizeTabName(base)

  // Does it already exist?
  const existing = await findTabByTitle(sheets, spreadsheetId, title)
  if (existing) return existing.title

  // Create the tab.
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: {
      requests: [{ addSheet: { properties: { title } } }],
    },
  })
  await writeHeaderRow(sheets, spreadsheetId, title, AGENT_TAB_COLUMNS)

  // Also make sure the Master Table tab has its header row. Harmless no-op
  // if it's already populated — we overwrite row 1 with the same headers.
  const master = await findTabByTitle(sheets, spreadsheetId, MASTER_TAB_TITLE)
  if (!master) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: { requests: [{ addSheet: { properties: { title: MASTER_TAB_TITLE } } }] },
    })
  }
  await writeHeaderRow(sheets, spreadsheetId, MASTER_TAB_TITLE, MASTER_TAB_COLUMNS)

  return title
}

/**
 * Append a row to both the agent's tab and the master rollup tab. Returns
 * the 1-based row numbers so callers can store them for future updates.
 */
export async function appendAppointmentRows(params: {
  agentTabTitle: string
  appt: AppointmentSyncData
}): Promise<{ agentRow: number; masterRow: number }> {
  const spreadsheetId = getMasterSpreadsheetId()
  const accountEmail = await getWriterAccountEmail()
  const sheets = await getSheetsClient(accountEmail)

  const agentRow = buildRow(params.appt, AGENT_TAB_COLUMNS)
  const masterRow = buildRow(params.appt, MASTER_TAB_COLUMNS)

  // We perform the two appends sequentially. Sheets' values.append returns
  // `updates.updatedRange` (e.g. "'Tab Name'!A14:N14") — we parse the row
  // number out of that so edits can update the same row later.
  async function appendOne(tab: string, row: string[]): Promise<number> {
    const res = await sheets.spreadsheets.values.append({
      spreadsheetId,
      range: `'${tab.replace(/'/g, "''")}'!A1`,
      valueInputOption: 'USER_ENTERED',
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values: [row] },
    })
    const updated = res.data.updates?.updatedRange || ''
    // Matches '...!A14:N14' — capture the start row.
    const m = updated.match(/![A-Z]+(\d+):/)
    return m ? Number(m[1]) : 0
  }

  const agentRowNumber = await appendOne(params.agentTabTitle, agentRow)
  const masterRowNumber = await appendOne(MASTER_TAB_TITLE, masterRow)
  return { agentRow: agentRowNumber, masterRow: masterRowNumber }
}

/**
 * Update existing rows (agent tab + master tab) in place. Used when an
 * agent edits their appointment.
 */
export async function updateAppointmentRows(params: {
  agentTabTitle: string
  agentRowNumber: number
  masterRowNumber: number
  appt: AppointmentSyncData
}): Promise<void> {
  const spreadsheetId = getMasterSpreadsheetId()
  const accountEmail = await getWriterAccountEmail()
  const sheets = await getSheetsClient(accountEmail)

  const agentCols = AGENT_TAB_COLUMNS.length
  const masterCols = MASTER_TAB_COLUMNS.length
  const agentEnd = String.fromCharCode(64 + agentCols) // A+n-1; only works for n<=26
  const masterEnd = String.fromCharCode(64 + masterCols)

  const agentRange = `'${params.agentTabTitle.replace(/'/g, "''")}'!A${params.agentRowNumber}:${agentEnd}${params.agentRowNumber}`
  const masterRange = `'${MASTER_TAB_TITLE}'!A${params.masterRowNumber}:${masterEnd}${params.masterRowNumber}`

  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId,
    requestBody: {
      valueInputOption: 'USER_ENTERED',
      data: [
        { range: agentRange, values: [buildRow(params.appt, AGENT_TAB_COLUMNS)] },
        { range: masterRange, values: [buildRow(params.appt, MASTER_TAB_COLUMNS)] },
      ],
    },
  })
}

/**
 * Clear two rows (agent + master) when an appointment is deleted. We clear
 * the row contents rather than shifting cells up so existing row numbers
 * for other appointments stay stable.
 */
export async function clearAppointmentRows(params: {
  agentTabTitle: string
  agentRowNumber: number
  masterRowNumber: number
}): Promise<void> {
  const spreadsheetId = getMasterSpreadsheetId()
  const accountEmail = await getWriterAccountEmail()
  const sheets = await getSheetsClient(accountEmail)

  const agentRange = `'${params.agentTabTitle.replace(/'/g, "''")}'!A${params.agentRowNumber}:Z${params.agentRowNumber}`
  const masterRange = `'${MASTER_TAB_TITLE}'!A${params.masterRowNumber}:Z${params.masterRowNumber}`

  await sheets.spreadsheets.values.batchClear({
    spreadsheetId,
    requestBody: { ranges: [agentRange, masterRange] },
  })
}
