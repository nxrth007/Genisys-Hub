/**
 * TEMPORARY admin-only MWAPI compatibility probe.
 *
 * Runs INSIDE the deployed app so it can read the MWAPI key straight from
 * the Vault (getSecretByName), the exact production path. Exercises the four
 * Claude call shapes the SEO engine depends on against the MWAPI proxy and
 * reports pass/fail. Never returns the key — only a redacted preview.
 *
 * Trigger: open https://<host>/api/admin/mwapi-smoke while signed in as admin.
 *
 * DELETE THIS FILE once MWAPI compatibility is confirmed. It is not part of
 * the engine and should not live in the tree long-term.
 */
import { NextResponse } from 'next/server'
import Anthropic from '@anthropic-ai/sdk'
import { requireAdmin } from '@/lib/auth-helpers'
import { getSecretByName } from '@/lib/vault-service'

export const dynamic = 'force-dynamic'
export const maxDuration = 300

const VAULT_ENTRY = 'MWAPI API Key'
const DEFAULT_BASE_URL = 'https://api.mwapi.dev'
const DEFAULT_MODEL = 'claude-opus-5' // src/lib/seo/settings.ts default
const FALLBACK_BETA = 'server-side-fallback-2026-07-01'

type Probe = { name: string; critical: boolean; ok: boolean; detail: string }

function errMsg(err: unknown): string {
  if (err instanceof Anthropic.APIError) {
    return `${err.status ?? '?'} ${err.name}: ${String(err.message).slice(0, 300)}`
  }
  return err instanceof Error ? err.message : String(err)
}

const textOf = (bs: Anthropic.Beta.BetaContentBlock[]) =>
  bs.filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === 'text').map((b) => b.text).join('')

export async function GET(req: Request) {
  const guard = await requireAdmin()
  if (guard instanceof NextResponse) return guard

  const url = new URL(req.url)
  const model = url.searchParams.get('model')?.trim() || DEFAULT_MODEL
  const baseURL = (process.env.MWAPI_BASE_URL?.trim() || DEFAULT_BASE_URL).replace(/\/+$/, '')

  let key: string
  try {
    key = (await getSecretByName(VAULT_ENTRY)).trim()
  } catch (err) {
    return NextResponse.json(
      { error: 'vault_lookup_failed', entry: VAULT_ENTRY, message: errMsg(err) },
      { status: 400 },
    )
  }
  if (!key) {
    return NextResponse.json({ error: 'empty_key', entry: VAULT_ENTRY }, { status: 400 })
  }

  const client = new Anthropic({
    apiKey: key,
    baseURL,
    authToken: null,
    maxRetries: 0,
    timeout: 4 * 60_000,
  })

  const probes: Probe[] = []
  const push = (p: Probe) => probes.push(p)

  // 1. plain streamed message — can we talk to the proxy at all?
  try {
    const m = await client.beta.messages
      .stream({ model, max_tokens: 64, messages: [{ role: 'user', content: 'Reply with exactly: OK' }] })
      .finalMessage()
    const text = textOf(m.content).trim()
    push({ name: 'plain streamed message', critical: true, ok: text.length > 0, detail: `model=${m.model} stop=${m.stop_reason}` })
  } catch (err) {
    push({ name: 'plain streamed message', critical: true, ok: false, detail: errMsg(err) })
  }

  // 2. structured JSON-schema output — plan/write/audit stages.
  try {
    const m = await client.beta.messages
      .stream({
        model,
        max_tokens: 256,
        thinking: { type: 'adaptive', display: 'omitted' },
        output_config: {
          effort: 'low',
          format: {
            type: 'json_schema',
            schema: {
              type: 'object',
              additionalProperties: false,
              properties: { city: { type: 'string' }, rank: { type: 'integer' } },
              required: ['city', 'rank'],
            },
          },
        },
        messages: [{ role: 'user', content: 'Return the capital of France and the number 1 as JSON {city, rank}.' }],
      })
      .finalMessage()
    const raw = textOf(m.content)
    let ok = false
    let detail = `stop=${m.stop_reason}`
    try {
      const j = JSON.parse(raw)
      ok = typeof j.city === 'string' && typeof j.rank === 'number'
    } catch {
      detail += ` not-json="${raw.slice(0, 50)}"`
    }
    push({ name: 'structured JSON-schema output', critical: true, ok, detail })
  } catch (err) {
    push({ name: 'structured JSON-schema output', critical: true, ok: false, detail: errMsg(err) })
  }

  // 3. server-side web_search + web_fetch — the research stage.
  try {
    const m = await client.beta.messages
      .stream({
        model,
        max_tokens: 2048,
        thinking: { type: 'adaptive', display: 'omitted' },
        output_config: { effort: 'low' },
        tools: [
          {
            type: 'web_search_20260209',
            name: 'web_search',
            max_uses: 2,
            user_location: { type: 'approximate', city: 'Phoenix', region: 'Arizona', country: 'US', timezone: 'America/Phoenix' },
          },
          { type: 'web_fetch_20260209', name: 'web_fetch', max_uses: 1, max_content_tokens: 4000 },
        ],
        messages: [{ role: 'user', content: 'Search the web for "solar panel tax credit 2026" and name one source URL you found.' }],
      })
      .finalMessage()
    const used = m.content.some((b) => b.type === 'server_tool_use' || b.type === 'web_search_tool_result')
    const searches = m.usage?.server_tool_use?.web_search_requests ?? 0
    push({ name: 'server web_search / web_fetch', critical: true, ok: used, detail: `stop=${m.stop_reason} toolBlocks=${used} searchReqs=${searches}` })
  } catch (err) {
    push({ name: 'server web_search / web_fetch', critical: true, ok: false, detail: errMsg(err) })
  }

  // 4. server-side fallback beta — resilience nicety, NOT load-bearing.
  try {
    const m = await client.beta.messages
      .stream({
        model,
        betas: [FALLBACK_BETA],
        fallbacks: 'default',
        max_tokens: 64,
        messages: [{ role: 'user', content: 'Reply with exactly: OK' }],
      })
      .finalMessage()
    push({ name: 'server-side fallback beta', critical: false, ok: textOf(m.content).trim().length > 0, detail: `accepted betas/fallbacks, stop=${m.stop_reason}` })
  } catch (err) {
    push({ name: 'server-side fallback beta', critical: false, ok: false, detail: errMsg(err) })
  }

  const criticalFails = probes.filter((p) => p.critical && !p.ok)
  const preview = key.length > 12 ? `${key.slice(0, 6)}…${key.slice(-4)}` : '(short)'

  return NextResponse.json({
    entry: VAULT_ENTRY,
    keyPreview: preview,
    keyLength: key.length,
    baseURL,
    model,
    verdict:
      criticalFails.length === 0
        ? 'PASS — MWAPI supports every critical call shape. Safe to wire as a fallback.'
        : `FAIL — ${criticalFails.length} critical shape(s) unsupported: ${criticalFails.map((p) => p.name).join(', ')}.`,
    probes,
  })
}
