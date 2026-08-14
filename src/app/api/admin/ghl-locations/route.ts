import { NextRequest, NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/auth-helpers'
import { getSecretByName, listEntriesByTag } from '@/lib/vault-service'

/**
 * GET /api/admin/ghl-locations?vault=<entry name>
 *
 * Diagnostic. Asks GHL which sub-accounts a given token can actually see.
 *
 * The Hub discovers sub-accounts from Vault entries tagged "ghl" — one
 * hand-added token each — so it only ever shows what someone remembered
 * to add, not what exists in the GHL agency. This answers the question
 * that decides whether automatic discovery is possible at all:
 *
 *   - a LOCATION token sees exactly one location (or 401/403 here), so
 *     every sub-account needs its own token in the Vault
 *   - an AGENCY token with locations.readonly lists them all, and
 *     discovery can be automated
 *
 * Read-only, admin-only, and never returns the token itself.
 */

const BASE_URL = 'https://services.leadconnectorhq.com'

export async function GET(req: NextRequest) {
  const denial = await requireAdmin()
  if (denial) return denial

  const entries = await listEntriesByTag('ghl')
  const requested = req.nextUrl.searchParams.get('vault')
  const vaultName = requested ?? entries[0]?.name

  if (!vaultName) {
    return NextResponse.json(
      {
        error: 'No Vault entries tagged "ghl" were found.',
        hint: 'Add a GHL token in the Vault and tag it "ghl".',
      },
      { status: 400 },
    )
  }

  let token: string
  try {
    token = await getSecretByName(vaultName)
  } catch {
    return NextResponse.json(
      { error: `No Vault entry named "${vaultName}".` },
      { status: 404 },
    )
  }

  const res = await fetch(`${BASE_URL}/locations/search`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Version: '2021-07-28',
      Accept: 'application/json',
    },
    cache: 'no-store',
  })

  const raw = await res.text()
  let parsed: unknown = null
  try {
    parsed = JSON.parse(raw)
  } catch {
    /* GHL returned non-JSON — surfaced as bodyPreview below */
  }

  const locations =
    (parsed as { locations?: Array<Record<string, unknown>> } | null)
      ?.locations ?? null

  return NextResponse.json({
    checkedVaultEntry: vaultName,
    allGhlVaultEntries: entries.map((e) => ({ name: e.name, tags: e.tags })),
    httpStatus: res.status,
    canListLocations: res.ok && Array.isArray(locations),
    locationCount: locations?.length ?? 0,
    // Just enough to identify each sub-account — no tokens, no settings.
    locations:
      locations?.map((l) => ({
        id: String(l.id ?? l._id ?? ''),
        name: String(l.name ?? ''),
      })) ?? null,
    verdict: res.ok
      ? Array.isArray(locations) && locations.length > 1
        ? 'AGENCY token — discovery can be automated.'
        : 'Token sees one location only — each sub-account needs its own Vault token.'
      : `GHL refused with ${res.status} — this is a location-scoped token, so each sub-account needs its own Vault token.`,
    bodyPreview: parsed ? undefined : raw.slice(0, 400),
  })
}
