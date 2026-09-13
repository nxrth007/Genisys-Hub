import { NextRequest } from 'next/server'
import { withOwnerApi, externalOptions } from '@/lib/external-api'
import { externalWrite, WriteError, requireOwner } from '@/lib/external-write'
import {
  listEntries,
  createEntry,
  updateEntry,
  deleteEntry,
} from '@/lib/vault-service'

/**
 * /api/external/v1/vault — the Vault, reachable from the CRM.
 *
 * There is deliberately NO reveal here.
 *
 * The master key lives in Render's environment and secrets are decrypted
 * only inside the Hub. Exposing reveal on this surface would put
 * plaintext credentials in a browser on a separately-hosted domain whose
 * frontend repo is public — a much larger blast radius than the Hub's
 * own same-origin page, which already offers reveal and audits every
 * use. Listing, adding, editing and rotating cover the day-to-day work;
 * actually looking at a secret stays in one place.
 *
 * listEntries() selects metadata only, so no ciphertext can leak through
 * this route even by accident.
 *
 * Owner-gated throughout: credentials are not a staff surface.
 */

const MAX_NAME = 120
const MAX_DESC = 2000
const MAX_TAGS = 12

function cleanTags(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  return [
    ...new Set(
      raw
        .map((t) => String(t ?? '').trim().toLowerCase())
        .filter((t) => t.length > 0 && t.length <= 40),
    ),
  ].slice(0, MAX_TAGS)
}

function cleanName(raw: unknown): string {
  const name = String(raw ?? '').trim()
  if (!name) throw new WriteError('Give the entry a name.')
  if (name.length > MAX_NAME) {
    throw new WriteError(`Name must be ${MAX_NAME} characters or fewer.`)
  }
  return name
}

function cleanDescription(raw: unknown): string | null {
  if (raw === undefined || raw === null) return null
  const d = String(raw).trim()
  if (d.length > MAX_DESC) {
    throw new WriteError(`Description must be ${MAX_DESC} characters or fewer.`)
  }
  return d || null
}

export const GET = withOwnerApi(async () => {
  const entries = await listEntries()
  return {
    entries: entries.map((e) => ({
      id: e.id,
      name: e.name,
      description: e.description,
      tags: e.tags,
      lastUsedAt: e.lastUsedAt,
      createdAt: e.createdAt,
      updatedAt: e.updatedAt,
      createdBy: e.createdBy?.name ?? e.createdBy?.email ?? null,
    })),
  }
})

export const POST = externalWrite(async ({ auth, body }) => {
  requireOwner(auth)

  const value = String(body.value ?? '')
  // Not trimmed: some keys legitimately carry trailing characters, and
  // silently altering a credential is worse than storing a stray space.
  if (!value) throw new WriteError('Paste the key or secret to store.')

  const { id } = await createEntry({
    name: cleanName(body.name),
    description: cleanDescription(body.description),
    tags: cleanTags(body.tags),
    value,
    userId: auth.user.id,
  })
  return { id }
})

export const PATCH = externalWrite(async ({ auth, body }) => {
  requireOwner(auth)

  const id = String(body.id ?? '').trim()
  if (!id) throw new WriteError('id is required')

  const updates: {
    name?: string
    description?: string | null
    tags?: string[]
    value?: string
  } = {}

  if (body.name !== undefined) updates.name = cleanName(body.name)
  if (body.description !== undefined) {
    updates.description = cleanDescription(body.description)
  }
  if (body.tags !== undefined) updates.tags = cleanTags(body.tags)

  // An empty string means "leave the secret alone", not "store nothing" —
  // the edit form sends a blank value field whenever it isn't rotating.
  if (typeof body.value === 'string' && body.value.length > 0) {
    updates.value = body.value
  }

  if (Object.keys(updates).length === 0) {
    throw new WriteError('Nothing to change.')
  }

  await updateEntry(id, auth.user.id, updates)
  return { id, rotated: updates.value !== undefined }
})

export const DELETE = externalWrite(async ({ auth }, req) => {
  requireOwner(auth)

  const id = (req.nextUrl.searchParams.get('id') ?? '').trim()
  if (!id) throw new WriteError('id is required')

  await deleteEntry(id, auth.user.id)
  return { id }
})

export function OPTIONS(req: NextRequest) {
  return externalOptions(req)
}
