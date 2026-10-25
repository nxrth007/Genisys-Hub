'use client'

import { useMutation } from '@tanstack/react-query'
import { Plus, Send, X } from 'lucide-react'
import { renderTemplate, type MergeData } from '@/lib/hl/merge'
import { MERGE_FIELDS, WEBHOOK_METHODS, type HlStep, type HlWebhookAuth } from '@/lib/hl/types'
import { Badge, Button, Field, Input, Select, Textarea, Toggle, hlFetch } from './ui'

/**
 * The Webhook action's settings: GHL's Webhook and Custom Webhook in one.
 * The request (method, URL, what it carries, headers, query parameters,
 * authorization), keeping the response for later steps, and a test request
 * with the sample lead. See src/lib/hl/outbound-webhook.ts.
 */

type Config = HlStep['config']
type Pair = { key: string; value: string }
/** Extra merge fields under one heading; `stepId` = a Webhook action's response (not offered to that action itself). */
export type FieldGroup = { label: string; options: { token: string; label: string }[]; stepId?: string }
type TestResult = { ok: boolean; status: number | null; ms: number; detail: string; data: unknown }

const TOKENS_ID = 'hl-webhook-tokens'

/** Key–value rows (headers, query parameters, form fields, custom data). */
function Pairs({ label, hint, rows, onChange, keyHint = 'Key' }: { label: string; hint?: string; rows: Pair[]; onChange: (rows: Pair[]) => void; keyHint?: string }) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[13px] font-medium text-foreground/90">{label}</span>
        <button type="button" onClick={() => onChange([...rows, { key: '', value: '' }])} className="flex items-center gap-1 text-[12px] text-muted-foreground hover:text-foreground">
          <Plus className="h-3.5 w-3.5" /> Add
        </button>
      </div>
      {hint && <span className="-mt-1 text-[12px] text-muted-foreground">{hint}</span>}
      {rows.map((r, i) => (
        <div key={i} className="grid grid-cols-[1fr_1.4fr_auto] items-center gap-2">
          <Input value={r.key} placeholder={keyHint} onChange={(e) => onChange(rows.map((x, j) => (j === i ? { ...x, key: e.target.value } : x)))} className="font-mono text-[12px]" />
          <Input list={TOKENS_ID} value={r.value} placeholder="Value or {{contact.email}}" onChange={(e) => onChange(rows.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))} className="font-mono text-[12px]" />
          <button type="button" onClick={() => onChange(rows.filter((_, j) => j !== i))} className="grid h-8 w-8 place-items-center rounded-md text-muted-foreground hover:bg-muted hover:text-destructive" aria-label="Remove">
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      ))}
    </div>
  )
}

export function WebhookStepFields({
  stepId,
  config: c,
  set,
  accountId,
  groups,
  sample,
  sampleMerge,
}: {
  stepId: string
  config: Config
  set: (patch: Partial<Config>) => void
  accountId?: string
  /** Extra merge fields (the webhook trigger's, other steps' responses). */
  groups: FieldGroup[]
  /** What tests and checks fill those with. */
  sample: Pick<MergeData, 'webhook' | 'responses'>
  /** The sample lead, as the message previews use it. */
  sampleMerge: MergeData
}) {
  const method = c.method ?? 'POST'
  const bodyType = method === 'GET' ? 'none' : (c.bodyType ?? 'contact')
  const auth: HlWebhookAuth = c.auth ?? { type: 'none' }
  const setAuth = (patch: Partial<HlWebhookAuth>) => set({ auth: { ...auth, ...patch } })
  const jsonType = !c.contentType || /json/i.test(c.contentType)

  // A JSON body checked with the sample lead filled in (as the run escapes it).
  let jsonProblem: string | null = null
  if (bodyType === 'raw' && jsonType && c.rawBody?.trim()) {
    const filled = c.rawBody.replace(/\{\{\s*[^{}]+?\s*\}\}/g, (t) => JSON.stringify(renderTemplate(t, { ...sampleMerge, ...sample })).slice(1, -1))
    try {
      JSON.parse(filled)
    } catch (err) {
      jsonProblem = err instanceof Error ? err.message : 'Not valid JSON'
    }
  }

  const test = useMutation({
    mutationFn: () => hlFetch<{ result: TestResult }>(`/api/hl/accounts/${accountId}/webhook-test`, { method: 'POST', json: { step: { id: stepId, type: 'webhook', config: c }, ...sample } }),
    onSuccess: ({ result }) => {
      // A good answer becomes the response later steps pick fields from.
      if (c.saveResponse && result.ok && result.data !== null && result.data !== undefined) set({ sampleResponse: result.data })
    },
  })
  const result = test.data?.result

  return (
    <div className="flex flex-col gap-4">
      <datalist id={TOKENS_ID}>
        {[...MERGE_FIELDS, ...groups.flatMap((g) => g.options)].map((m) => (
          <option key={m.token} value={m.token}>
            {m.label}
          </option>
        ))}
      </datalist>

      <div className="grid grid-cols-[110px_1fr] gap-2">
        <Field label="Method">
          <Select value={method} onChange={(e) => set({ method: e.target.value as Config['method'] })}>
            {WEBHOOK_METHODS.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="URL">
          <Input list={TOKENS_ID} value={c.url ?? ''} onChange={(e) => set({ url: e.target.value })} placeholder="https://hooks.zapier.com/hooks/catch/…" className="font-mono text-[12px]" />
        </Field>
      </div>

      {method !== 'GET' && (
        <Field label="Send">
          <Select value={bodyType} onChange={(e) => set({ bodyType: e.target.value as Config['bodyType'] })}>
            <option value="contact">The contact’s details (like GHL’s Webhook)</option>
            <option value="raw">A body you write (like GHL’s Custom Webhook)</option>
            <option value="form">Form fields</option>
            <option value="none">Nothing</option>
          </Select>
        </Field>
      )}
      {bodyType === 'contact' && (
        <Pairs
          label="Custom data"
          hint="Sent as JSON with the contact’s name, email, phone, tags and fields, the business and the workflow; these pairs go under customData."
          rows={c.data ?? []}
          onChange={(data) => set({ data })}
        />
      )}
      {bodyType === 'raw' && (
        <div className="flex flex-col gap-1.5">
          <div className="flex items-end justify-between gap-2">
            <span className="text-[13px] font-medium text-foreground/90">Body</span>
            <div className="flex gap-2">
              <select value="" onChange={(e) => e.target.value && set({ rawBody: `${c.rawBody ?? ''}${e.target.value}` })} className="h-7 rounded-md border border-border bg-card px-2 text-[12px] text-foreground/90">
                <option value="">{'{ }'} Insert field…</option>
                {MERGE_FIELDS.map((m) => (
                  <option key={m.token} value={m.token}>
                    {m.label}
                  </option>
                ))}
                {groups.map((g) => (
                  <optgroup key={g.label} label={g.label}>
                    {g.options.map((m) => (
                      <option key={m.token} value={m.token}>
                        {m.label}
                      </option>
                    ))}
                  </optgroup>
                ))}
              </select>
              <select value={c.contentType || 'application/json'} onChange={(e) => set({ contentType: e.target.value === 'application/json' ? undefined : e.target.value })} className="h-7 rounded-md border border-border bg-card px-2 text-[12px] text-foreground/90">
                <option value="application/json">JSON</option>
                <option value="text/plain">Text</option>
                <option value="application/xml">XML</option>
              </select>
            </div>
          </div>
          <Textarea rows={8} value={c.rawBody ?? ''} onChange={(e) => set({ rawBody: e.target.value })} placeholder={'{\n  "name": "{{contact.full_name}}",\n  "email": "{{contact.email}}"\n}'} className="font-mono text-[12px]" />
          {jsonType && <span className="text-[12px] text-muted-foreground">Fields are escaped for JSON, so a quote in a name can’t break it.</span>}
          {jsonProblem && <span className="text-[12px] text-warning">Not valid JSON with the sample lead filled in: {jsonProblem}</span>}
        </div>
      )}
      {bodyType === 'form' && <Pairs label="Form fields" rows={c.data ?? []} onChange={(data) => set({ data })} />}

      <Pairs label="Headers" rows={c.headers ?? []} onChange={(headers) => set({ headers })} keyHint="Header" />
      <Pairs label="Query parameters" hint="Added to the URL, each value encoded." rows={c.params ?? []} onChange={(params) => set({ params })} keyHint="Name" />

      <div className="flex flex-col gap-2">
        <Field label="Authorization">
          <Select value={auth.type} onChange={(e) => set({ auth: e.target.value === 'none' ? undefined : { type: e.target.value as HlWebhookAuth['type'] } })}>
            <option value="none">None</option>
            <option value="bearer">Bearer token</option>
            <option value="api_key">API key</option>
            <option value="basic">Username and password (basic)</option>
          </Select>
        </Field>
        {auth.type === 'bearer' && <Input type="password" value={auth.token ?? ''} onChange={(e) => setAuth({ token: e.target.value })} placeholder="Token" autoComplete="off" />}
        {auth.type === 'basic' && (
          <div className="grid grid-cols-2 gap-2">
            <Input value={auth.username ?? ''} onChange={(e) => setAuth({ username: e.target.value })} placeholder="Username" autoComplete="off" />
            <Input type="password" value={auth.password ?? ''} onChange={(e) => setAuth({ password: e.target.value })} placeholder="Password" autoComplete="new-password" />
          </div>
        )}
        {auth.type === 'api_key' && (
          <div className="grid grid-cols-[1fr_1.3fr_110px] gap-2">
            <Input value={auth.key ?? ''} onChange={(e) => setAuth({ key: e.target.value })} placeholder="X-API-Key" className="font-mono text-[12px]" autoComplete="off" />
            <Input type="password" value={auth.value ?? ''} onChange={(e) => setAuth({ value: e.target.value })} placeholder="Key" autoComplete="off" />
            <Select value={auth.in ?? 'header'} onChange={(e) => setAuth({ in: e.target.value === 'query' ? 'query' : 'header' })}>
              <option value="header">Header</option>
              <option value="query">Query</option>
            </Select>
          </div>
        )}
      </div>

      <label className="flex items-center justify-between gap-3 rounded-lg border border-border p-3">
        <span className="text-[13.5px] text-foreground/90">
          Keep the response for later steps
          <span className="block text-[12px] text-muted-foreground">
            Later steps read it as {`{{custom_webhook.…response.field}}`}. Send a test request so its fields show in their Insert field menus.
            {c.ref ? ` Steps imported from GHL read it as #${c.ref}.` : ''}
          </span>
        </span>
        <Toggle checked={!!c.saveResponse} onChange={(v) => set({ saveResponse: v || undefined })} label="Keep the response" />
      </label>

      <div className="flex flex-col gap-2 rounded-lg border border-border p-3">
        <div className="flex items-center justify-between gap-3">
          <span className="text-[12.5px] text-muted-foreground">Sends the request now, as set above, with the sample lead (Jennifer Smith).</span>
          <Button size="sm" icon={<Send className="h-3.5 w-3.5" />} loading={test.isPending} disabled={!accountId || !c.url?.trim()} onClick={() => test.mutate()}>
            Send test request
          </Button>
        </div>
        {test.error && <p className="text-[12px] text-destructive">{(test.error as Error).message}</p>}
        {result && (
          <div className="flex flex-col gap-1.5">
            <p className="flex flex-wrap items-center gap-2 text-[12.5px] text-foreground/90">
              <Badge color={result.ok ? 'green' : 'red'}>{result.status ?? 'No answer'}</Badge>
              <span className="min-w-0 break-all">{result.detail}</span>
              <span className="text-muted-foreground">{(result.ms / 1000).toFixed(1)} s</span>
            </p>
            {result.data !== null && result.data !== undefined && (
              <pre className="max-h-56 overflow-auto rounded-lg bg-surface-muted p-3 text-[11.5px] text-foreground/80">{typeof result.data === 'string' ? result.data : JSON.stringify(result.data, null, 2)}</pre>
            )}
            {c.saveResponse && result.ok && result.data !== null && <p className="text-[12px] text-muted-foreground">Its fields are now offered to later steps (save the action and the workflow to keep it).</p>}
          </div>
        )}
      </div>
    </div>
  )
}
