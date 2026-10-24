import { NextResponse } from 'next/server'
import { hlError, hlGuard, jsonBody, str } from '@/lib/hl/http'
import { DEFAULT_GHL_VAULT, IMPORT_PHASES, defaultAccountId, readImportState, startGhlImport } from '@/lib/hl/ghl-import'

/**
 * GET  ?accountId=: where an import stands (default: the home sub-account's).
 * POST { vaultName?, accountId? }: start one. Defaults to the Lead Genisys key
 * ("GHL Genisys Token"); read-only on the GHL side.
 */
export async function GET(req: Request) {
  const guard = await hlGuard()
  if (guard instanceof NextResponse) return guard
  const accountId = new URL(req.url).searchParams.get('accountId') || (await defaultAccountId())
  const state = accountId ? await readImportState(accountId) : null
  return NextResponse.json({ state, phases: IMPORT_PHASES, defaultVault: DEFAULT_GHL_VAULT })
}

export async function POST(req: Request) {
  const guard = await hlGuard()
  if (guard instanceof NextResponse) return guard
  try {
    const body = await jsonBody(req).catch(() => ({}) as Record<string, unknown>)
    const state = await startGhlImport({ vaultName: str(body.vaultName) ?? undefined, accountId: str(body.accountId) ?? undefined, by: guard.email })
    console.log(`[hell-level import] started by ${guard.email} for ${state.accountId} (${state.vaultName})`)
    return NextResponse.json({ state, phases: IMPORT_PHASES })
  } catch (err) {
    return hlError(err, 'start import')
  }
}
