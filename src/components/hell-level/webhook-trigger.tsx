'use client'

import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Check, Copy, RefreshCw } from 'lucide-react'
import { prettyPhone } from '@/lib/hl/merge'
import { WEBHOOK_MAPPING, type HlTrigger, type HlWebhookMapping } from '@/lib/hl/types'
import { contactFromPayload, webhookPaths } from '@/lib/hl/webhook-shared'
import { Badge, Button, Field, Input, fmtDateTime, hlFetch } from './ui'

/**
 * The Inbound webhook trigger's settings, GHL's layout: the URL to send to,
 * the requests it has had (pick one as the "mapping reference": its fields
 * fill the actions' Insert field menus), and where the contact's details
 * are. See src/lib/hl/webhooks.ts.
 */

type HookRequest = { id: string; at: string; contentType: string | null; bytes: number | null; payload: unknown; outcome: { status?: string; detail?: string } }

/** A new URL key (the server swaps it if it's ever taken). */
export function newHookId(): string {
  const b = new Uint8Array(24)
  crypto.getRandomValues(b)
  return btoa(String.fromCharCode(...b))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
}

const OUTCOME: Record<string, { label: string; color: 'green' | 'gray' | 'amber' | 'blue' }> = {
  started: { label: 'Started', color: 'green' },
  test: { label: 'Test', color: 'blue' },
  skipped: { label: 'Not started', color: 'amber' },
  not_started: { label: 'Not started', color: 'amber' },
  received: { label: 'Received', color: 'gray' },
}

/** The detail fields a request can find the contact by on their own; consent never is. */
const AUTO = new Set<keyof HlWebhookMapping>(['email', 'phone', 'firstName', 'lastName', 'fullName'])

export function WebhookTriggerFields({ t, onChange, accountId, workflowId }: { t: HlTrigger; onChange: (t: HlTrigger) => void; accountId?: string; workflowId?: string }) {
  const [copied, setCopied] = useState(false)
  const url = t.hookId ? `${typeof window === 'undefined' ? '' : window.location.origin}/api/hl/public/hooks/${t.hookId}` : ''
  const requests = useQuery<{ requests: HookRequest[] }>({
    queryKey: ['hl', 'hook', accountId, workflowId, t.hookId],
    queryFn: () => hlFetch(`/api/hl/accounts/${accountId}/workflows/${workflowId}/hooks/${t.hookId}`),
    enabled: !!(accountId && workflowId && t.hookId),
  })
  const list = requests.data?.requests ?? []
  const reference = t.reference?.payload
  const fields = reference !== undefined ? webhookPaths(reference) : []
  const found = reference !== undefined ? contactFromPayload(reference, t.mapping) : null

  const setMapping = (key: keyof HlWebhookMapping, value: string) => {
    const m: HlWebhookMapping = { ...(t.mapping ?? {}) }
    if (value.trim()) m[key] = value.trim()
    else delete m[key]
    onChange({ ...t, mapping: Object.keys(m).length ? m : undefined })
  }
  const copy = () => {
    void navigator.clipboard?.writeText(url).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    })
  }

  return (
    <div className="flex flex-col gap-4">
      <Field label="Webhook URL" hint="Send it a POST with JSON or form data, up to 1 MB. It works once the workflow is saved; while the workflow is a draft, requests are kept as test requests and nothing runs.">
        <div className="flex gap-2">
          <Input readOnly value={url} onFocus={(e) => e.currentTarget.select()} className="font-mono text-[12px]" />
          <Button size="sm" onClick={copy} icon={copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />} disabled={!url}>
            {copied ? 'Copied' : 'Copy'}
          </Button>
        </div>
      </Field>

      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between gap-2">
          <p className="text-[13px] font-medium text-foreground/90">Requests received</p>
          <Button size="sm" variant="ghost" onClick={() => void requests.refetch()} loading={requests.isFetching} icon={<RefreshCw className="h-3.5 w-3.5" />} disabled={!accountId || !workflowId}>
            Refresh
          </Button>
        </div>
        <div className="max-h-64 overflow-y-auto rounded-lg border border-border">
          {list.map((r) => {
            const o = OUTCOME[r.outcome.status ?? 'received'] ?? OUTCOME.received
            const isRef = t.reference?.at === r.at
            const sample = webhookPaths(r.payload, 4)
            return (
              <div key={r.id} className="flex items-start gap-3 border-b border-border px-3 py-2.5 last:border-0">
                <div className="min-w-0 flex-1">
                  <p className="flex flex-wrap items-center gap-2 text-[12.5px] text-foreground/90">
                    <span className="font-semibold">{fmtDateTime(r.at)}</span>
                    <Badge color={o.color}>{o.label}</Badge>
                  </p>
                  {r.outcome.detail && <p className="mt-0.5 text-[12px] text-muted-foreground">{r.outcome.detail}</p>}
                  <p className="mt-0.5 truncate font-mono text-[11.5px] text-muted-foreground/80">{sample.map((f) => `${f.path}: ${f.sample}`).join(' · ') || 'Empty request'}</p>
                </div>
                {isRef ? (
                  <Badge color="purple">Reference</Badge>
                ) : (
                  <Button size="sm" variant="ghost" onClick={() => onChange({ ...t, reference: { at: r.at, payload: r.payload } })}>
                    Use as reference
                  </Button>
                )}
              </div>
            )
          })}
          {!list.length && (
            <p className="px-3 py-4 text-center text-[12.5px] text-muted-foreground">
              {requests.isLoading ? 'Loading…' : 'Nothing received yet. Save the workflow, send a test request to the URL, then refresh.'}
            </p>
          )}
        </div>
        {requests.error && <p className="text-[12px] text-destructive">{(requests.error as Error).message}</p>}
      </div>

      {reference !== undefined && (
        <div className="flex flex-col gap-1.5 rounded-lg border border-border p-3">
          <div className="flex items-center justify-between gap-2">
            <p className="text-[13px] font-medium text-foreground/90">Mapping reference</p>
            <button type="button" className="text-[12px] text-muted-foreground hover:text-destructive" onClick={() => onChange({ ...t, reference: undefined })}>
              Clear
            </button>
          </div>
          <p className="text-[12px] text-muted-foreground">
            The request from {fmtDateTime(t.reference!.at)}. Its fields are in each action’s Insert field menu as {'{{inboundWebhookRequest.…}}'}.
          </p>
          <ul className="flex flex-col gap-0.5 font-mono text-[11.5px] text-foreground/80">
            {fields.slice(0, 8).map((f) => (
              <li key={f.path} className="truncate">
                {f.path} <span className="text-muted-foreground">= {f.sample || '""'}</span>
              </li>
            ))}
            {fields.length > 8 && <li className="text-muted-foreground">and {fields.length - 8} more</li>}
          </ul>
        </div>
      )}

      <div className="flex flex-col gap-2">
        <p className="text-[13px] font-medium text-foreground/90">Finding the contact</p>
        <p className="-mt-1 text-[12px] text-muted-foreground">
          The request’s email or phone finds the contact, or makes a new one; a request with neither starts nothing. Blank fields are found by their usual names. Texts only go to contacts who agreed to them, so pick the field that records it (a ticked box, true or yes).
        </p>
        <datalist id="hl-hook-paths">
          {fields.map((f) => (
            <option key={f.path} value={f.path} />
          ))}
        </datalist>
        <div className="grid grid-cols-[150px_1fr] items-center gap-x-3 gap-y-2">
          {WEBHOOK_MAPPING.map(({ key, label }) => (
            <label key={key} className="contents">
              <span className="text-[12.5px] text-foreground/90">{label}</span>
              <Input
                list="hl-hook-paths"
                value={t.mapping?.[key] ?? ''}
                onChange={(e) => setMapping(key, e.target.value)}
                placeholder={AUTO.has(key) ? (found?.from[key] && !t.mapping?.[key] ? `Automatic: ${found.from[key]}` : 'Automatic') : 'Not recorded'}
                className="font-mono text-[12px]"
              />
            </label>
          ))}
        </div>
        {found && (
          <p className="rounded-lg bg-surface-muted px-3 py-2 text-[12px] text-muted-foreground">
            From the reference:{' '}
            <span className="text-foreground/90">
              {[[found.firstName, found.lastName].filter(Boolean).join(' ') || found.fullName, found.email, found.phone ? prettyPhone(found.phone) : null].filter(Boolean).join(' · ') || 'no email or phone, so it wouldn’t start'}
            </span>
            {t.mapping?.consent && <> · agreed to texts: {found.consent ? 'yes' : 'no'}</>}
          </p>
        )}
      </div>
    </div>
  )
}
