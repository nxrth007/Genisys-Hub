import { WEBHOOK_METHODS, type HlStep } from './types'

/**
 * GHL's Webhook (the contact's details plus custom data) and Custom Webhook
 * (a request built in the step) as a Hell-level Webhook step's settings.
 * Shared by the import and the builder's "Run it in Hell-level" button for
 * steps imported before Hell-level could run them. null = one Hell-level
 * can't run: OAuth2, whose token lives in GHL's own connection.
 */

type Rec = Record<string, unknown>
const rec = (v: unknown): Rec => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Rec) : {})
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : typeof v === 'number' ? String(v) : null)

export const GHL_WEBHOOK_TYPES = ['webhook', 'custom_webhook']

export function ghlWebhookConfig(type: string, attributes: unknown, stepIndex?: unknown): HlStep['config'] | null {
  const a = rec(attributes)
  const auth = rec(a.authorization)
  const authData = rec(auth.data)
  const authType = str(auth.type)?.toUpperCase()
  if (authType === 'OAUTH2') return null
  const kv = (v: unknown) =>
    arr(v)
      .map(rec)
      .map((p) => ({ key: str(p.key) ?? '', value: p.value === undefined || p.value === null ? '' : String(p.value) }))
      .filter((p) => p.key)
  const custom = type === 'custom_webhook'
  const body = rec(a.body)
  const contentType = str(body.contentType) ?? 'application/json'
  const form = /x-www-form-urlencoded/i.test(contentType)
  const method = WEBHOOK_METHODS.find((m) => m === (str(a.method) ?? 'POST').toUpperCase()) ?? 'POST'
  const sample = rec(a.webhookResponse).data
  const index = typeof stepIndex === 'number' ? stepIndex : typeof stepIndex === 'string' && /^\d+$/.test(stepIndex) ? Number(stepIndex) : null
  return {
    method,
    url: str(a.url) ?? '',
    bodyType: !custom ? 'contact' : method === 'GET' ? 'none' : form ? 'form' : 'raw',
    ...(custom && !form ? { rawBody: String(body.rawData ?? ''), ...(/json/i.test(contentType) ? {} : { contentType }) } : {}),
    data: kv(custom ? body.keyValueData : a.customData),
    headers: kv(a.headers),
    params: kv(a.parameters),
    ...(authType === 'BASIC' ? { auth: { type: 'basic' as const, username: str(authData.username) ?? '', password: String(authData.password ?? '') } } : {}),
    ...(authType === 'BEARER_TOKEN' ? { auth: { type: 'bearer' as const, token: String(authData.token ?? '') } } : {}),
    ...(authType === 'API_KEY'
      ? { auth: { type: 'api_key' as const, key: str(authData.key) ?? '', value: String(authData.value ?? ''), in: /query/i.test(str(authData.passBy) ?? '') ? ('query' as const) : ('header' as const) } }
      : {}),
    ...(a.saveResponse === true ? { saveResponse: true } : {}),
    ...(sample !== undefined && sample !== null && (JSON.stringify(sample)?.length ?? Infinity) <= 50_000 ? { sampleResponse: sample } : {}),
    // GHL's later steps read the response as {{custom_webhook.<stepIndex>.response…}}.
    ...(index !== null ? { ref: String(index) } : {}),
  }
}
