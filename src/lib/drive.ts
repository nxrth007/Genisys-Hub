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
      // Read-only covers file content + metadata. Swap to
      // 'https://www.googleapis.com/auth/drive' later if we need write access.
      'https://www.googleapis.com/auth/drive.readonly',
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

async function getAuthenticatedClient(accountEmail: string) {
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
