import { prisma } from '@/lib/prisma'
import { decryptSecret } from '@/lib/crypto'

/**
 * The Google API key for Places API (New): the onboarding form's address
 * suggestions (app/api/public/address) and the Google Business Profile
 * listing lookup (gbp-setup.ts). Alex added the Vault's "Places API (New)"
 * on 2026-10-25, after the older "Google Maps Key" (still the geocoder's)
 * got PERMISSION_DENIED from Places; that one is the fallback. Names match
 * in any case, and the key is read out of whatever else the entry holds.
 */

export const PLACES_KEY_ENTRY = 'Places API (New)'
const NAMES = [PLACES_KEY_ENTRY, 'Google Maps Key']
/** A Google API key: "AIza" and 35 more. */
const GOOGLE_KEY = /AIza[0-9A-Za-z_-]{35}/

export async function placesApiKey(): Promise<string> {
  for (const name of NAMES) {
    const entry = await prisma.vaultEntry.findFirst({
      where: { name: { equals: name, mode: 'insensitive' } },
      select: { id: true, ciphertext: true, nonce: true },
    })
    if (!entry) continue
    // As getSecretByName does, so the Vault shows when it was last used.
    await prisma.vaultEntry.update({ where: { id: entry.id }, data: { lastUsedAt: new Date() } })
    const secret = decryptSecret(entry.ciphertext, entry.nonce)
    return secret.match(GOOGLE_KEY)?.[0] ?? secret.trim()
  }
  throw new Error(`Vault entry "${PLACES_KEY_ENTRY}" not found. Add it in /vault before using this integration.`)
}
