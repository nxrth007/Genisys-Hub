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
// - One "master" spreadsheet (id from env MASTER_APPOINTMENTS_SHEET_ID)
//   holds every agent's bookings. Alex curates the column layout of its
//   "Master Table" tab manually.
// - One tab per agent, named after the agent on approval (ensureAgentTab).
//
// The sync is SCHEMA-AWARE: on every write we read the target tab's header
// row, figure out each column's meaning by matching the header text
// against a set of aliases, and build a row that slots each value into
// the right column. Unknown columns get blank cells so row alignment
// stays intact. We never overwrite headers that already exist — only
// the first newly-created agent tab gets seeded.
// ---------------------------------------------------------------------------

/** Env-sourced spreadsheet id. Falls back to the one Alex shared on 2026-04-17. */
export function getMasterSpreadsheetId(): string {
  return (
    process.env.MASTER_APPOINTMENTS_SHEET_ID ||
    '10Ms_ppnp5nQ-Xx01u47TPLWauiTWrgUAlFhkLdBhVOA'
  )
}

export const MASTER_TAB_TITLE = 'Master Table'

// ---- Canonical keys + alias → key map ----------------------------------

type CanonicalKey =
  | 'apptDate'
  | 'apptTime'
  | 'apptDateTime'
  | 'client'
  | 'customerName'
  | 'customerPhone'
  | 'address'
  | 'email'
  | 'monthlyBill'
  | 'utilityProvider'
  | 'roofType'
  | 'roofAge'
  | 'status'
  | 'estimatedDealValue'
  | 'notes'
  | 'callRecordingLink'
  | 'agentName'
  | 'agentEmail'
  | 'loggedAt'

// Normalized alias → canonical key. Normalization lowercases + strips
// punctuation and whitespace, so "Customer's Phone Number" and
// "customer phone number" both map to the same canonical.
const COLUMN_ALIASES: Record<string, CanonicalKey> = {
  // Date / time
  appointmentdate: 'apptDate',
  apptdate: 'apptDate',
  date: 'apptDate',
  appointmenttime: 'apptTime',
  appttime: 'apptTime',
  time: 'apptTime',
  appointmentdateandtime: 'apptDateTime',
  apptdateandtime: 'apptDateTime',
  dateandtime: 'apptDateTime',
  datetime: 'apptDateTime',
  // Client (which Genisys client the appointment is booked for)
  client: 'client',
  clientcompany: 'client',
  company: 'client',
  accountname: 'client',
  // Customer
  clientname: 'customerName',
  customername: 'customerName',
  customersname: 'customerName',
  name: 'customerName',
  phonenumber: 'customerPhone',
  customerphonenumber: 'customerPhone',
  customersphonenumber: 'customerPhone',
  customerphone: 'customerPhone',
  phone: 'customerPhone',
  address: 'address',
  email: 'email',
  customeremail: 'email',
  // Solar-specific
  monthlybill: 'monthlyBill',
  bill: 'monthlyBill',
  utilityprovider: 'utilityProvider',
  utility: 'utilityProvider',
  rooftype: 'roofType',
  roofage: 'roofAge',
  // Status + value
  appointmentstatus: 'status',
  status: 'status',
  estimateddealvalue: 'estimatedDealValue',
  dealvalue: 'estimatedDealValue',
  estdealvalue: 'estimatedDealValue',
  // Notes + recording
  notes: 'notes',
  callrecordinglink: 'callRecordingLink',
  recordinglink: 'callRecordingLink',
  recording: 'callRecordingLink',
  // Provenance (optional — populated only if Alex adds these columns)
  agentname: 'agentName',
  agent: 'agentName',
  agentemail: 'agentEmail',
  loggedat: 'loggedAt',
  logged: 'loggedAt',
  createdat: 'loggedAt',
  timestamp: 'loggedAt',
}

function normalizeHeader(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]/g, '')
}

function canonicalize(headerText: string): CanonicalKey | null {
  if (!headerText) return null
  return COLUMN_ALIASES[normalizeHeader(headerText)] || null
}

export type TableSchema = {
  tabTitle: string
  headerRowNumber: number // 1-based
  columns: Array<{ header: string; canonical: CanonicalKey | null; columnIndex: number }>
}

// Default layout — matches Alex's existing Master Table (14 columns, split
// date+time, includes Estimated Deal Value). Used only when seeding a
// freshly-created agent tab AND Master Table itself had no detectable
// schema.
// Note: "Client Name" here means the customer's name, not the Genisys
// client (Brighton / Spring). The dedicated Genisys-client column is
// labeled "Client" below. Legacy label preserved so existing tabs keep
// mapping to customerName.
const DEFAULT_HEADER_ROW = [
  'Client',
  'Appointment Date',
  'Appointment Time',
  'Client Name',
  'Phone Number',
  'Address',
  'Email',
  'Monthly Bill',
  'Utility Provider',
  'Roof Type',
  'Roof Age',
  'Appointment Status',
  'Estimated Deal Value',
  'Notes',
  'Call Recording Link',
]

function buildSchemaFromHeaderRow(
  tabTitle: string,
  headerValues: string[],
  headerRowNumber: number
): TableSchema {
  return {
    tabTitle,
    headerRowNumber,
    columns: headerValues.map((h, i) => ({
      header: h,
      canonical: canonicalize(h),
      columnIndex: i,
    })),
  }
}

/**
 * Scan the first 15 rows of a tab for a header row. A row qualifies if at
 * least 3 of its cells match known canonical keys — enough signal to
 * distinguish a real header from a random data row or a decorative title.
 * Returns null if none found.
 */
async function detectTableSchema(
  sheets: ReturnType<typeof google.sheets>,
  spreadsheetId: string,
  tabTitle: string
): Promise<TableSchema | null> {
  const range = `'${tabTitle.replace(/'/g, "''")}'!A1:Z15`
  let res
  try {
    res = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range,
      valueRenderOption: 'FORMATTED_VALUE',
    })
  } catch {
    return null
  }
  const rows = (res.data.values || []) as unknown[][]
  for (let i = 0; i < rows.length; i++) {
    const row = (rows[i] || []).map((c) => (c == null ? '' : String(c)))
    const matches = row.filter((c) => canonicalize(c) != null).length
    if (matches >= 3) return buildSchemaFromHeaderRow(tabTitle, row, i + 1)
  }
  return null
}

// ---- Value formatters --------------------------------------------------

function fmtDate(d: Date): string {
  return d.toLocaleDateString('en-US')
}

function fmtTime(d: Date): string {
  return d.toLocaleTimeString('en-US', { hour12: true })
}

function fmtDateTime(d: Date): string {
  return `${fmtDate(d)} ${fmtTime(d)}`
}

// ---- Appointment payload + row building --------------------------------

export type AppointmentSyncData = {
  apptDateTime: Date | string
  // Genisys client (Brighton Capital Solar / Spring Solar / …). Optional so
  // historical rows missing a clientId still sync.
  clientName?: string | null
  customerName: string
  customerPhone: string
  address: string | null
  email: string | null
  monthlyBill: string | null
  utilityProvider: string | null
  roofType: string | null
  roofAge: string | null
  status: string
  estimatedDealValue: string | null
  notes: string | null
  callRecordingLink: string | null
  agentName: string | null
  agentEmail: string
  createdAt: Date | string
}

function toDate(v: Date | string): Date {
  return v instanceof Date ? v : new Date(v)
}

function valueForCanonical(appt: AppointmentSyncData, key: CanonicalKey | null): string {
  if (!key) return '' // unknown column — leave blank so row alignment holds
  const when = toDate(appt.apptDateTime)
  switch (key) {
    case 'apptDate':
      return fmtDate(when)
    case 'apptTime':
      return fmtTime(when)
    case 'apptDateTime':
      return fmtDateTime(when)
    case 'client':
      return appt.clientName || ''
    case 'customerName':
      return appt.customerName || ''
    case 'customerPhone':
      return appt.customerPhone || ''
    case 'address':
      return appt.address || ''
    case 'email':
      return appt.email || ''
    case 'monthlyBill':
      return appt.monthlyBill || ''
    case 'utilityProvider':
      return appt.utilityProvider || ''
    case 'roofType':
      return appt.roofType || ''
    case 'roofAge':
      return appt.roofAge || ''
    case 'status':
      return appt.status || ''
    case 'estimatedDealValue':
      return appt.estimatedDealValue || ''
    case 'notes':
      return appt.notes || ''
    case 'callRecordingLink':
      return appt.callRecordingLink || ''
    case 'agentName':
      return appt.agentName || ''
    case 'agentEmail':
      return appt.agentEmail || ''
    case 'loggedAt':
      return fmtDateTime(toDate(appt.createdAt))
    default:
      return ''
  }
}

function buildRowForSchema(schema: TableSchema, appt: AppointmentSyncData): string[] {
  return schema.columns.map((col) => valueForCanonical(appt, col.canonical))
}

// ---- Auth + tab helpers -------------------------------------------------

async function getSheetsClient(accountEmail: string) {
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

/** Prefer alex@leadgenisys.com (sheet owner), fall back to any Drive account. */
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
  return raw.replace(/[[\]*?/\\]/g, '').slice(0, 100).trim()
}

// ---------------------------------------------------------------------------
// Read-back: pulls the live Master Table tab into JS objects so the Hub UI
// can show appointments that the call center entered manually into the
// sheet (i.e. didn't go through the /agent portal). Source of truth for the
// Master Tracker page.
// ---------------------------------------------------------------------------

export type MasterTableRow = {
  /** 1-based row in the Master Table tab. Useful as a stable key. */
  rowNumber: number
  /** ISO datetime if both date + time parsed, ISO @ midnight if only date,
   *  null if neither could be parsed. */
  apptDateTime: string | null
  client: string | null
  customerName: string
  customerPhone: string
  address: string | null
  email: string | null
  monthlyBill: string | null
  utilityProvider: string | null
  roofType: string | null
  roofAge: string | null
  status: string | null
  estimatedDealValue: string | null
  notes: string | null
  callRecordingLink: string | null
  agentName: string | null
  agentEmail: string | null
  loggedAt: string | null
}

/** Combine sheet date + time strings into an ISO datetime if possible. */
function combineDateAndTime(dateStr: string, timeStr: string): string | null {
  const date = (dateStr || '').trim()
  const time = (timeStr || '').trim()
  if (!date && !time) return null
  // Browser-native Date parser handles `4/16/2026 10:00:00 AM` directly.
  const combined = time ? `${date} ${time}` : date
  const d = new Date(combined)
  if (isNaN(d.getTime())) return null
  return d.toISOString()
}

/**
 * Read every populated row from the Master Table tab and parse it into
 * MasterTableRows. Empty rows (no customer name) are skipped. Rows are
 * returned newest-appointment-first.
 */
export async function readMasterTableRows(): Promise<MasterTableRow[]> {
  const writerEmail = await getWriterAccountEmail()
  const sheets = await getSheetsClient(writerEmail)
  const spreadsheetId = getMasterSpreadsheetId()

  // Detect the schema (header row + which column maps to which canonical
  // key). detectTableSchema looks at A1:Z15, so it covers the typical
  // "header on row 1" case. If the sheet has no header row, return [].
  const schema = await detectTableSchema(sheets, spreadsheetId, MASTER_TAB_TITLE)
  if (!schema) return []

  // Pull all data rows below the header. Wide column range (A:AZ) covers
  // any plausible schema width without needing a precise end column.
  const rangeStart = schema.headerRowNumber + 1
  const range = `'${MASTER_TAB_TITLE.replace(/'/g, "''")}'!A${rangeStart}:AZ`
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range,
    valueRenderOption: 'FORMATTED_VALUE',
  })
  const rawRows = (res.data.values || []) as unknown[][]

  // Build a lookup from canonical key → column index for quick access.
  const colByKey = new Map<CanonicalKey, number>()
  for (const col of schema.columns) {
    if (col.canonical && !colByKey.has(col.canonical)) {
      colByKey.set(col.canonical, col.columnIndex)
    }
  }
  const cell = (row: unknown[], key: CanonicalKey): string => {
    const idx = colByKey.get(key)
    if (idx == null) return ''
    const v = row[idx]
    return v == null ? '' : String(v).trim()
  }
  // Money columns sometimes have a leading "$" baked into the cell value
  // (e.g. "$200+" or " $1500 "). The Hub UI also prepends a "$", which
  // gave us the "$$200+" double-dollar in Master Tracker. Strip a single
  // leading "$" + any commas / spaces so the stored value is just the
  // raw number-ish text and the UI controls its own formatting.
  const cellMoney = (row: unknown[], key: CanonicalKey): string => {
    const raw = cell(row, key)
    return raw.replace(/^\s*\$\s*/, '').trim()
  }

  const out: MasterTableRow[] = []
  for (let i = 0; i < rawRows.length; i++) {
    const row = rawRows[i] || []
    const customerName = cell(row, 'customerName')
    // Skip entirely empty rows (the sheet has hundreds of blank trailing
    // rows). A row with no customer name is treated as empty.
    if (!customerName) continue

    const apptDate = cell(row, 'apptDate')
    const apptTime = cell(row, 'apptTime')
    const apptDateTime =
      cell(row, 'apptDateTime') ||
      combineDateAndTime(apptDate, apptTime) ||
      null
    const isoApptDateTime =
      typeof apptDateTime === 'string' && apptDateTime !== ''
        ? // If apptDateTime came in as a single field, try to parse it too.
          (() => {
            const d = new Date(apptDateTime)
            return isNaN(d.getTime())
              ? combineDateAndTime(apptDate, apptTime)
              : d.toISOString()
          })()
        : null

    out.push({
      rowNumber: rangeStart + i,
      apptDateTime: isoApptDateTime,
      client: cell(row, 'client') || null,
      customerName,
      customerPhone: cell(row, 'customerPhone'),
      address: cell(row, 'address') || null,
      email: cell(row, 'email') || null,
      monthlyBill: cellMoney(row, 'monthlyBill') || null,
      utilityProvider: cell(row, 'utilityProvider') || null,
      roofType: cell(row, 'roofType') || null,
      roofAge: cell(row, 'roofAge') || null,
      status: cell(row, 'status') || null,
      estimatedDealValue: cellMoney(row, 'estimatedDealValue') || null,
      notes: cell(row, 'notes') || null,
      callRecordingLink: cell(row, 'callRecordingLink') || null,
      agentName: cell(row, 'agentName') || null,
      agentEmail: cell(row, 'agentEmail') || null,
      loggedAt: cell(row, 'loggedAt') || null,
    })
  }

  // Newest-first by appointment datetime when present. Rows without a
  // parsable date sink to the bottom.
  out.sort((a, b) => {
    if (!a.apptDateTime && !b.apptDateTime) return b.rowNumber - a.rowNumber
    if (!a.apptDateTime) return 1
    if (!b.apptDateTime) return -1
    return b.apptDateTime.localeCompare(a.apptDateTime)
  })

  return out
}

/**
 * One-off migration: add a "Client" header column to every tab in the
 * master spreadsheet that doesn't already have one, then extend any
 * Google-Sheets native Table on that tab so the new column is *inside*
 * the table (matches alternating-row formatting, filter dropdowns, etc.).
 * Appending a cell to the right of a Table doesn't auto-widen the Table
 * range — we have to call updateTable to move endColumnIndex.
 *
 * Called via POST /api/admin/sheets/migrate-client-column — idempotent,
 * so re-running is harmless. Re-runs also fix any tab that had the
 * header appended previously but whose Table wasn't yet extended.
 */
export async function migrateAddClientColumn(): Promise<{
  spreadsheetId: string
  tabsUpdated: string[]
  tabsAlreadyHad: string[]
  tabsNoHeader: string[]
  tablesExtended: string[]
  headersStyled: string[]
}> {
  const writerEmail = await getWriterAccountEmail()
  const sheets = await getSheetsClient(writerEmail)
  const spreadsheetId = getMasterSpreadsheetId()

  const meta = await sheets.spreadsheets.get({
    spreadsheetId,
    // Request tables too so we can extend their range to cover the new column.
    fields: 'sheets(properties(sheetId,title),tables(tableId,range))',
  })

  const tabsUpdated: string[] = []
  const tabsAlreadyHad: string[] = []
  const tabsNoHeader: string[] = []
  const tablesExtended: string[] = []
  const headersStyled: string[] = []

  for (const tab of meta.data.sheets || []) {
    const sheetId = tab.properties?.sheetId
    const tabTitle = tab.properties?.title
    if (typeof sheetId !== 'number' || !tabTitle) continue

    const schema = await detectTableSchema(sheets, spreadsheetId, tabTitle)
    if (!schema) {
      tabsNoHeader.push(tabTitle)
      continue
    }

    // Figure out where the Client column lives (existing or to-be-created).
    const existingClient = schema.columns.find((c) => c.canonical === 'client')
    let clientColIndex: number
    if (existingClient) {
      tabsAlreadyHad.push(tabTitle)
      clientColIndex = existingClient.columnIndex
    } else {
      clientColIndex = schema.columns.length // append at end
      const colLetterStr = colLetter(clientColIndex + 1)
      const range = `'${tabTitle.replace(/'/g, "''")}'!${colLetterStr}${schema.headerRowNumber}`
      await sheets.spreadsheets.values.update({
        spreadsheetId,
        range,
        valueInputOption: 'RAW',
        requestBody: { values: [['Client']] },
      })
      tabsUpdated.push(tabTitle)
    }

    // Extend any Table on this tab so its endColumnIndex covers Client.
    // Tables without an explicit range/tableId are skipped defensively.
    for (const table of tab.tables || []) {
      if (!table.tableId || !table.range) continue
      const tableSheetId = table.range.sheetId
      if (tableSheetId != null && tableSheetId !== sheetId) continue
      const currentEnd = table.range.endColumnIndex ?? 0
      const targetEnd = clientColIndex + 1 // end index is exclusive
      if (currentEnd >= targetEnd) continue

      const newRange: Record<string, number> = {
        sheetId,
        startRowIndex: table.range.startRowIndex ?? 0,
        startColumnIndex: table.range.startColumnIndex ?? 0,
        endColumnIndex: targetEnd,
      }
      if (typeof table.range.endRowIndex === 'number') {
        newRange.endRowIndex = table.range.endRowIndex
      }

      await sheets.spreadsheets.batchUpdate({
        spreadsheetId,
        requestBody: {
          requests: [
            {
              updateTable: {
                table: { tableId: table.tableId, range: newRange },
                fields: 'range',
              },
            },
          ],
        },
      })
      tablesExtended.push(tabTitle)
    }

    // Finally: copy the header *formatting* (blue fill, white bold text
    // — whatever the Table uses) from the left-neighbor header cell onto
    // the Client header cell. Google Sheets Tables apply header styling
    // as per-cell explicit fills at Table-create time, and merely
    // extending the Table range doesn't paint the new cell. copyPaste
    // with PASTE_FORMAT mirrors the neighbor's look without touching
    // the "Client" text we already wrote.
    if (clientColIndex > 0) {
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId,
        requestBody: {
          requests: [
            {
              copyPaste: {
                source: {
                  sheetId,
                  startRowIndex: schema.headerRowNumber - 1,
                  endRowIndex: schema.headerRowNumber,
                  startColumnIndex: clientColIndex - 1,
                  endColumnIndex: clientColIndex,
                },
                destination: {
                  sheetId,
                  startRowIndex: schema.headerRowNumber - 1,
                  endRowIndex: schema.headerRowNumber,
                  startColumnIndex: clientColIndex,
                  endColumnIndex: clientColIndex + 1,
                },
                pasteType: 'PASTE_FORMAT',
                pasteOrientation: 'NORMAL',
              },
            },
          ],
        },
      })
      headersStyled.push(tabTitle)
    }
  }

  return {
    spreadsheetId,
    tabsUpdated,
    tabsAlreadyHad,
    tabsNoHeader,
    tablesExtended,
    headersStyled,
  }
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

/** 1-based column index → spreadsheet letter (1→A, 14→N, 27→AA). */
function colLetter(n: number): string {
  let s = ''
  let i = n
  while (i > 0) {
    const m = (i - 1) % 26
    s = String.fromCharCode(65 + m) + s
    i = Math.floor((i - 1) / 26)
  }
  return s || 'A'
}

async function ensureTabExists(
  sheets: ReturnType<typeof google.sheets>,
  spreadsheetId: string,
  title: string
): Promise<{ sheetId: number }> {
  const existing = await findTabByTitle(sheets, spreadsheetId, title)
  if (existing) return { sheetId: existing.sheetId }
  const res = await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: { requests: [{ addSheet: { properties: { title } } }] },
  })
  const sheetId =
    res.data.replies?.[0]?.addSheet?.properties?.sheetId ?? 0
  return { sheetId }
}

// ---- Placeholder detection + target-row resolution ---------------------

/** Values like "m/d/yyyy", "xx:xx", "$xx", "##" that Alex's sheet uses as
 *  template rows. A row qualifies as a placeholder if every non-empty cell
 *  matches one of these patterns. */
const PLACEHOLDER_PATTERNS: RegExp[] = [
  /^m+\/d+\/y+$/i,
  /^(mm\/dd\/(yy)?yy)$/i,
  /^x+[:.]x+([:.]x+)?(\s?[ap]m)?$/i,
  /^\$x+$/i,
  /^#+$/,
  /^x+$/i,
  /^hh[:.]mm([:.]ss)?(\s?[ap]m)?$/i,
]

function isPlaceholderCell(value: string): boolean {
  const v = value.trim()
  if (!v) return false
  return PLACEHOLDER_PATTERNS.some((p) => p.test(v))
}

function isEmptyRow(row: string[]): boolean {
  return row.every((c) => !c || c.trim() === '')
}

function isPlaceholderRow(row: string[]): boolean {
  const nonEmpty = row.filter((c) => c && c.trim() !== '')
  if (nonEmpty.length === 0) return false // empty, handled separately
  return nonEmpty.every((c) => isPlaceholderCell(c))
}

/**
 * Find the best row to write a new appointment into, given a detected
 * schema. Scans the 1000 rows below the header:
 *   - First empty row → write there (mode='fill-empty')
 *   - First all-placeholder row → overwrite (mode='overwrite-placeholder')
 *   - Otherwise keep scanning
 * If nothing matched, returns the row index just after the last scanned
 * row — effectively "append to the bottom".
 *
 * This keeps new bookings inside the user's existing Table range (where
 * the placeholders sit) instead of flying to row 1 like the old
 * values.append behavior did when the tab had blank rows above the header.
 */
async function findWriteTarget(
  sheets: ReturnType<typeof google.sheets>,
  spreadsheetId: string,
  tabTitle: string,
  schema: TableSchema
): Promise<{ rowNumber: number; mode: 'fill-empty' | 'overwrite-placeholder' | 'append' }> {
  const startRow = schema.headerRowNumber + 1
  const scanRange = `'${tabTitle.replace(/'/g, "''")}'!A${startRow}:Z${startRow + 1000}`
  let rows: unknown[][] = []
  try {
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: scanRange,
      valueRenderOption: 'FORMATTED_VALUE',
    })
    rows = (res.data.values || []) as unknown[][]
  } catch {
    // Tab smaller than scan range or permission issue — fall through to append.
  }

  for (let i = 0; i < rows.length; i++) {
    const row = (rows[i] || []).map((c) => (c == null ? '' : String(c)))
    if (isEmptyRow(row)) {
      return { rowNumber: startRow + i, mode: 'fill-empty' }
    }
    if (isPlaceholderRow(row)) {
      return { rowNumber: startRow + i, mode: 'overwrite-placeholder' }
    }
  }

  // No empty/placeholder rows inside the scanned region — append after.
  return { rowNumber: startRow + rows.length, mode: 'append' }
}

/** Write a single row to a tab at the schema-aware target row. Uses
 *  values.update (not append) so the row lands exactly where we chose,
 *  even when the sheet has blank rows above the header or we're
 *  overwriting a placeholder inside a pre-existing Google Sheets Table. */
async function writeAppointmentRow(
  sheets: ReturnType<typeof google.sheets>,
  spreadsheetId: string,
  tabTitle: string,
  schema: TableSchema,
  rowValues: string[]
): Promise<number> {
  const target = await findWriteTarget(sheets, spreadsheetId, tabTitle, schema)
  const endCol = colLetter(schema.columns.length)
  const range = `'${tabTitle.replace(/'/g, "''")}'!A${target.rowNumber}:${endCol}${target.rowNumber}`
  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [rowValues] },
  })
  return target.rowNumber
}

async function seedHeaderRow(
  sheets: ReturnType<typeof google.sheets>,
  spreadsheetId: string,
  tabTitle: string,
  headers: string[]
): Promise<void> {
  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `'${tabTitle.replace(/'/g, "''")}'!A1`,
    valueInputOption: 'RAW',
    requestBody: { values: [headers] },
  })
}

/**
 * Style a freshly-created agent tab so it looks like a proper table:
 *   - Freeze the header row so it stays visible while scrolling
 *   - Bold white text on blue header background (matches the Hub's
 *     accent color and roughly matches the vibe of Alex's Master Table)
 *   - Auto-resize columns so long headers don't get cut off
 * Best-effort: any step can fail without blocking the sync.
 */
async function applyAgentTabFormatting(
  sheets: ReturnType<typeof google.sheets>,
  spreadsheetId: string,
  sheetId: number,
  columnCount: number
): Promise<void> {
  try {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: {
        requests: [
          {
            updateSheetProperties: {
              properties: {
                sheetId,
                gridProperties: { frozenRowCount: 1 },
              },
              fields: 'gridProperties.frozenRowCount',
            },
          },
          {
            repeatCell: {
              range: {
                sheetId,
                startRowIndex: 0,
                endRowIndex: 1,
                startColumnIndex: 0,
                endColumnIndex: columnCount,
              },
              cell: {
                userEnteredFormat: {
                  // blue-600 at ~72% opacity on white — matches Hub branding
                  backgroundColor: { red: 0.486, green: 0.227, blue: 0.929 },
                  textFormat: {
                    bold: true,
                    foregroundColor: { red: 1, green: 1, blue: 1 },
                    fontSize: 10,
                  },
                  horizontalAlignment: 'LEFT',
                  verticalAlignment: 'MIDDLE',
                  padding: { top: 6, bottom: 6, left: 10, right: 10 },
                },
              },
              fields:
                'userEnteredFormat(backgroundColor,textFormat,horizontalAlignment,verticalAlignment,padding)',
            },
          },
          {
            autoResizeDimensions: {
              dimensions: {
                sheetId,
                dimension: 'COLUMNS',
                startIndex: 0,
                endIndex: columnCount,
              },
            },
          },
        ],
      },
    })
  } catch (err) {
    console.error('[drive] applyAgentTabFormatting failed (non-fatal):', err)
  }
}

/**
 * Ensure an agent has a tab in the master spreadsheet. New tabs inherit
 * the Master Table's column order so the layout is consistent. Existing
 * tabs are returned as-is — we never touch their headers or data.
 *
 * IMPORTANT: we NEVER write to the Master Table's header row. Alex curates
 * that manually; the sync only reads it.
 */
export async function ensureAgentTab(params: {
  agentName: string | null
  agentEmail: string
}): Promise<string> {
  const spreadsheetId = getMasterSpreadsheetId()
  const accountEmail = await getWriterAccountEmail()
  const sheets = await getSheetsClient(accountEmail)

  const base = params.agentName?.trim() || params.agentEmail.split('@')[0]
  const preferredTitle = sanitizeTabName(base)

  // Disambiguate when a different agent already owns a tab with this
  // preferred name. Without this, a second "John" would silently share
  // the first John's tab and both agents' bookings would land in the
  // same place. If THIS agent already has the tab (re-approval), reuse it.
  const existingOwner = await prisma.user.findFirst({
    where: {
      agentSheetTab: preferredTitle,
      email: { not: params.agentEmail.toLowerCase() },
    },
    select: { id: true },
  })

  const title = existingOwner
    ? sanitizeTabName(`${preferredTitle} (${params.agentEmail.split('@')[0]})`)
    : preferredTitle

  const existing = await findTabByTitle(sheets, spreadsheetId, title)
  if (existing) return existing.title

  // Detect master schema so the new agent tab mirrors its columns.
  const masterSchema = await detectTableSchema(sheets, spreadsheetId, MASTER_TAB_TITLE)
  const headers = masterSchema
    ? masterSchema.columns.map((c) => c.header)
    : DEFAULT_HEADER_ROW

  const addRes = await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: { requests: [{ addSheet: { properties: { title } } }] },
  })
  const sheetId = addRes.data.replies?.[0]?.addSheet?.properties?.sheetId ?? 0
  await seedHeaderRow(sheets, spreadsheetId, title, headers)
  await applyAgentTabFormatting(sheets, spreadsheetId, sheetId, headers.length)

  return title
}

/**
 * Append a row to the agent's tab and the Master Table. Each tab's column
 * layout is detected at write time so if Alex reorders/renames columns,
 * sync adapts without code changes. Returns 1-based row numbers for later
 * in-place edits.
 *
 * Master Table headers are NEVER written — if the sheet somehow has no
 * detectable header row we still append, using a synthesized default
 * layout, without touching row 1.
 */
export async function appendAppointmentRows(params: {
  agentTabTitle: string
  appt: AppointmentSyncData
}): Promise<{ agentRow: number; masterRow: number }> {
  const spreadsheetId = getMasterSpreadsheetId()
  const accountEmail = await getWriterAccountEmail()
  const sheets = await getSheetsClient(accountEmail)

  // Master schema first — new agent tabs will seed using its headers.
  const masterSchemaMaybe = await detectTableSchema(sheets, spreadsheetId, MASTER_TAB_TITLE)
  const seedHeaders = masterSchemaMaybe
    ? masterSchemaMaybe.columns.map((c) => c.header)
    : DEFAULT_HEADER_ROW

  // Agent tab: ensure it exists, seed + style only if empty.
  const { sheetId: agentSheetId } = await ensureTabExists(
    sheets,
    spreadsheetId,
    params.agentTabTitle
  )
  let agentSchema = await detectTableSchema(sheets, spreadsheetId, params.agentTabTitle)
  if (!agentSchema) {
    await seedHeaderRow(sheets, spreadsheetId, params.agentTabTitle, seedHeaders)
    await applyAgentTabFormatting(sheets, spreadsheetId, agentSheetId, seedHeaders.length)
    agentSchema = buildSchemaFromHeaderRow(params.agentTabTitle, seedHeaders, 1)
  }

  // Master: never seed. If no schema detected, synthesize one from defaults.
  const masterSchema =
    masterSchemaMaybe ||
    buildSchemaFromHeaderRow(MASTER_TAB_TITLE, DEFAULT_HEADER_ROW, 1)

  const agentRowValues = buildRowForSchema(agentSchema, params.appt)
  const masterRowValues = buildRowForSchema(masterSchema, params.appt)

  const agentRowNumber = await writeAppointmentRow(
    sheets,
    spreadsheetId,
    params.agentTabTitle,
    agentSchema,
    agentRowValues
  )
  const masterRowNumber = await writeAppointmentRow(
    sheets,
    spreadsheetId,
    MASTER_TAB_TITLE,
    masterSchema,
    masterRowValues
  )
  return { agentRow: agentRowNumber, masterRow: masterRowNumber }
}

/** Update rows in place. Re-detects schema each call so edits stay aligned. */
export async function updateAppointmentRows(params: {
  agentTabTitle: string
  agentRowNumber: number
  masterRowNumber: number
  appt: AppointmentSyncData
}): Promise<void> {
  const spreadsheetId = getMasterSpreadsheetId()
  const accountEmail = await getWriterAccountEmail()
  const sheets = await getSheetsClient(accountEmail)

  const [agentSchemaMaybe, masterSchemaMaybe] = await Promise.all([
    detectTableSchema(sheets, spreadsheetId, params.agentTabTitle),
    detectTableSchema(sheets, spreadsheetId, MASTER_TAB_TITLE),
  ])
  const agentSchema =
    agentSchemaMaybe ||
    buildSchemaFromHeaderRow(params.agentTabTitle, DEFAULT_HEADER_ROW, 1)
  const masterSchema =
    masterSchemaMaybe ||
    buildSchemaFromHeaderRow(MASTER_TAB_TITLE, DEFAULT_HEADER_ROW, 1)

  const agentEnd = colLetter(agentSchema.columns.length)
  const masterEnd = colLetter(masterSchema.columns.length)
  const agentRange = `'${params.agentTabTitle.replace(/'/g, "''")}'!A${params.agentRowNumber}:${agentEnd}${params.agentRowNumber}`
  const masterRange = `'${MASTER_TAB_TITLE}'!A${params.masterRowNumber}:${masterEnd}${params.masterRowNumber}`

  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId,
    requestBody: {
      valueInputOption: 'USER_ENTERED',
      data: [
        { range: agentRange, values: [buildRowForSchema(agentSchema, params.appt)] },
        { range: masterRange, values: [buildRowForSchema(masterSchema, params.appt)] },
      ],
    },
  })
}

/** Clear rows on delete. Wide A:AZ range covers any plausible schema width. */
export async function clearAppointmentRows(params: {
  agentTabTitle: string
  agentRowNumber: number
  masterRowNumber: number
}): Promise<void> {
  const spreadsheetId = getMasterSpreadsheetId()
  const accountEmail = await getWriterAccountEmail()
  const sheets = await getSheetsClient(accountEmail)

  const agentRange = `'${params.agentTabTitle.replace(/'/g, "''")}'!A${params.agentRowNumber}:AZ${params.agentRowNumber}`
  const masterRange = `'${MASTER_TAB_TITLE}'!A${params.masterRowNumber}:AZ${params.masterRowNumber}`

  await sheets.spreadsheets.values.batchClear({
    spreadsheetId,
    requestBody: { ranges: [agentRange, masterRange] },
  })
}

/**
 * Called after an agent is deleted from the Hub. Cleans up sheet state:
 *
 * 1. Clears the agent's rows from the Master Table (rollup stays clean).
 * 2. If the agent's personal tab never held any appointments (empty test
 *    account), delete the tab entirely.
 * 3. Otherwise, rename the tab to "(archived YYYY-MM-DD) <name>" so the
 *    history isn't lost and you can still refer back if needed.
 *
 * Fire-and-forget from the delete handler — individual failures log but
 * don't bubble, since the DB delete has already succeeded.
 */
export async function cleanupAgentSheetData(params: {
  masterRowsToClear: number[]
  agentTabTitle: string | null
}): Promise<{
  masterRowsCleared: number
  tabArchived: string | null
  tabDeleted: string | null
}> {
  const spreadsheetId = getMasterSpreadsheetId()
  const accountEmail = await getWriterAccountEmail()
  const sheets = await getSheetsClient(accountEmail)

  let masterRowsCleared = 0
  let tabArchived: string | null = null
  let tabDeleted: string | null = null

  // 1. Clear the agent's rows from the Master Table in one batch.
  if (params.masterRowsToClear.length > 0) {
    const ranges = params.masterRowsToClear.map(
      (n) => `'${MASTER_TAB_TITLE}'!A${n}:AZ${n}`
    )
    await sheets.spreadsheets.values.batchClear({
      spreadsheetId,
      requestBody: { ranges },
    })
    masterRowsCleared = ranges.length
  }

  // 2. Handle the agent's personal tab.
  if (params.agentTabTitle) {
    const tab = await findTabByTitle(sheets, spreadsheetId, params.agentTabTitle)
    if (tab) {
      // Peek at rows 2..∞ in column A — if nothing's there, the tab never
      // held a real appointment and can be safely deleted. Uses column A
      // because every schema has a required first column (Appointment Date
      // or Client in the new layout).
      const peek = await sheets.spreadsheets.values.get({
        spreadsheetId,
        range: `'${params.agentTabTitle.replace(/'/g, "''")}'!A2:A`,
      })
      const hasDataRows = (peek.data.values || []).some(
        (row) => row[0] != null && String(row[0]).trim() !== ''
      )

      if (!hasDataRows) {
        await sheets.spreadsheets.batchUpdate({
          spreadsheetId,
          requestBody: {
            requests: [{ deleteSheet: { sheetId: tab.sheetId } }],
          },
        })
        tabDeleted = tab.title
      } else {
        const stamp = new Date().toISOString().slice(0, 10)
        // Prefix the date so repeat archives of similarly-named tabs stay
        // unique. 100-char tab limit enforced by sanitizeTabName.
        const newTitle = sanitizeTabName(
          `(archived ${stamp}) ${params.agentTabTitle}`
        )
        await sheets.spreadsheets.batchUpdate({
          spreadsheetId,
          requestBody: {
            requests: [
              {
                updateSheetProperties: {
                  properties: { sheetId: tab.sheetId, title: newTitle },
                  fields: 'title',
                },
              },
            ],
          },
        })
        tabArchived = newTitle
      }
    }
  }

  return { masterRowsCleared, tabArchived, tabDeleted }
}
