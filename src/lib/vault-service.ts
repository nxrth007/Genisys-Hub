/**
 * Vault service — the single place that encrypts, decrypts, and logs access
 * to stored secrets. API routes call into this; they don't touch crypto.ts or
 * the VaultAccessLog model directly.
 */
import { prisma } from '@/lib/prisma'
import { encryptSecret, decryptSecret } from '@/lib/crypto'

export type VaultAction = 'create' | 'view' | 'edit' | 'delete'

async function logAccess(entryId: string, userId: string, action: VaultAction) {
  await prisma.vaultAccessLog.create({
    data: { entryId, userId, action },
  })
}

export async function listEntries() {
  // Metadata only — no ciphertext ever leaves this function.
  return prisma.vaultEntry.findMany({
    orderBy: { updatedAt: 'desc' },
    select: {
      id: true,
      name: true,
      description: true,
      tags: true,
      lastUsedAt: true,
      createdAt: true,
      updatedAt: true,
      createdBy: { select: { id: true, name: true, email: true } },
    },
  })
}

export async function createEntry(params: {
  name: string
  description?: string | null
  value: string
  tags?: string[]
  userId: string
}) {
  const { ciphertext, nonce } = encryptSecret(params.value)
  const entry = await prisma.vaultEntry.create({
    data: {
      name: params.name,
      description: params.description ?? null,
      ciphertext,
      nonce,
      tags: params.tags ?? [],
      createdById: params.userId,
    },
  })
  await logAccess(entry.id, params.userId, 'create')
  return { id: entry.id }
}

export async function revealEntry(entryId: string, userId: string) {
  const entry = await prisma.vaultEntry.findUnique({
    where: { id: entryId },
    select: { id: true, name: true, ciphertext: true, nonce: true },
  })
  if (!entry) throw new Error('Entry not found')

  const value = decryptSecret(entry.ciphertext, entry.nonce)

  // Record access + update lastUsedAt in a single transaction so the audit
  // log and the "last used" timestamp never drift.
  await prisma.$transaction([
    prisma.vaultAccessLog.create({
      data: { entryId: entry.id, userId, action: 'view' },
    }),
    prisma.vaultEntry.update({
      where: { id: entry.id },
      data: { lastUsedAt: new Date() },
    }),
  ])

  return { id: entry.id, name: entry.name, value }
}

export async function updateEntry(
  entryId: string,
  userId: string,
  updates: {
    name?: string
    description?: string | null
    tags?: string[]
    value?: string // if provided, re-encrypts with a fresh nonce
  }
) {
  const data: Record<string, unknown> = {}
  if (updates.name !== undefined) data.name = updates.name
  if (updates.description !== undefined) data.description = updates.description
  if (updates.tags !== undefined) data.tags = updates.tags
  if (updates.value !== undefined) {
    const { ciphertext, nonce } = encryptSecret(updates.value)
    data.ciphertext = ciphertext
    data.nonce = nonce
  }

  await prisma.vaultEntry.update({ where: { id: entryId }, data })
  await logAccess(entryId, userId, 'edit')
}

export async function deleteEntry(entryId: string, userId: string) {
  // Log BEFORE delete so the audit row has somewhere to point. Then the
  // cascading delete removes both the entry and the logs, which is fine
  // because we also want the logs gone when an entry is purged.
  await logAccess(entryId, userId, 'delete')
  await prisma.vaultEntry.delete({ where: { id: entryId } })
}

/**
 * Server-side lookup for integration code. Decrypts and returns the value
 * of a vault entry by its name. Does NOT log the access — system/integration
 * use happens on every request and would flood the audit log with noise.
 * User-initiated reveals go through revealEntry() which IS logged.
 *
 * Throws if the entry doesn't exist. Callers should catch and return a
 * user-friendly "you need to add this to the vault" error.
 */
export async function getSecretByName(name: string): Promise<string> {
  const entry = await prisma.vaultEntry.findFirst({
    where: { name },
    select: { id: true, ciphertext: true, nonce: true },
  })
  if (!entry) {
    throw new Error(
      `Vault entry "${name}" not found. Add it in /vault before using this integration.`
    )
  }
  // Bump lastUsedAt so the UI reflects actual integration usage even though
  // we skip the individual-access audit row.
  await prisma.vaultEntry.update({
    where: { id: entry.id },
    data: { lastUsedAt: new Date() },
  })
  return decryptSecret(entry.ciphertext, entry.nonce)
}

/**
 * List vault entries that have a specific tag — used by integrations to
 * enumerate all configured sub-accounts (e.g. all GHL tokens tagged "ghl").
 * Returns metadata only, no ciphertext.
 */
export async function listEntriesByTag(tag: string) {
  return prisma.vaultEntry.findMany({
    where: { tags: { has: tag } },
    select: {
      id: true,
      name: true,
      description: true,
      tags: true,
    },
    orderBy: { name: 'asc' },
  })
}

export async function getAuditLog(entryId: string) {
  return prisma.vaultAccessLog.findMany({
    where: { entryId },
    orderBy: { createdAt: 'desc' },
    take: 50,
    include: {
      user: { select: { id: true, name: true, email: true } },
    },
  })
}
