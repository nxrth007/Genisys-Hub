import { externalOptions } from '@/lib/external-api'
import { withBotApi } from '@/lib/bot-api'
import { listEntries } from '@/lib/vault-service'

/**
 * GET /api/external/v1/vault/names
 *
 * Owner-token only. Vault entry names and metadata so a bot can tell
 * which integrations are configured. Never ciphertext or values.
 */
export const GET = withBotApi('vault.names', async () => {
  const entries = await listEntries()
  return entries.map((e) => ({ name: e.name, tags: e.tags, lastUsedAt: e.lastUsedAt, updatedAt: e.updatedAt }))
})

export const OPTIONS = externalOptions
