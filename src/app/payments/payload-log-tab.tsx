'use client'

import { useQuery } from '@tanstack/react-query'
import { Inbox } from 'lucide-react'
import {
  CopyButton,
  ErrorBlock,
  fromIso,
  LoadingBlock,
  StatusPill,
} from './ui'

/**
 * Payments → Payload Log.
 *
 * Every authenticated hit on the NCT lead webhook, shown verbatim —
 * the exact bytes NCT sent, captured before parsing. This is the
 * "how do they actually send?" answer, and the receipts when a lead
 * dispute comes down to what arrived versus what they claim they sent.
 */

type LogEvent = {
  id: string
  rawBody: string
  contentType: string | null
  userAgent: string | null
  outcome: string
  leadId: string | null
  note: string | null
  createdAt: string
}

/** Pretty-print if the body is JSON; otherwise show it exactly as-is. */
function displayBody(raw: string): { text: string; wasJson: boolean } {
  try {
    return { text: JSON.stringify(JSON.parse(raw), null, 2), wasJson: true }
  } catch {
    return { text: raw, wasJson: false }
  }
}

export function PayloadLogTab() {
  const { data, isLoading, isError, error } = useQuery<{
    ok: true
    events: LogEvent[]
  }>({
    queryKey: ['payments-nct-payloads'],
    queryFn: async () => {
      const res = await fetch('/api/payments/nct/payload-log')
      const d = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(d.message || d.error || 'Failed to load')
      return d
    },
    refetchInterval: 30_000,
  })

  if (isLoading) return <LoadingBlock />
  if (isError || !data)
    return (
      <ErrorBlock
        message={error instanceof Error ? error.message : 'Failed to load.'}
      />
    )

  if (data.events.length === 0) {
    return (
      <div className="rounded-2xl border border-dashed border-border bg-card p-12 text-center">
        <Inbox className="mx-auto mb-2 h-6 w-6 text-muted-foreground" />
        <p className="text-sm font-medium text-foreground">
          No webhook hits yet
        </p>
        <p className="mt-1 text-sm text-muted-foreground">
          The moment NCT sends anything with a valid token — even a broken
          payload — it shows up here exactly as they sent it.
        </p>
      </div>
    )
  }

  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground">
        Last {data.events.length} authenticated webhook hits, newest first,
        shown exactly as received. Bad-token requests are not recorded.
      </p>

      {data.events.map((e) => {
        const body = displayBody(e.rawBody)
        return (
          <div
            key={e.id}
            className="rounded-2xl border border-border bg-card p-4"
          >
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <span className="text-sm font-medium text-foreground">
                {fromIso(e.createdAt)}
              </span>
              <StatusPill status={e.outcome} />
              {e.leadId && (
                <code className="font-mono text-xs text-muted-foreground">
                  {e.leadId}
                </code>
              )}
              <span className="ml-auto text-[11px] text-muted-foreground">
                {e.contentType || 'no content-type'}
              </span>
            </div>

            {e.note && (
              <p className="mt-1 text-xs text-muted-foreground">{e.note}</p>
            )}

            <details className="mt-2">
              <summary className="cursor-pointer text-xs font-medium text-muted-foreground hover:text-foreground">
                Raw payload{body.wasJson ? ' (JSON, formatted)' : ''}
              </summary>
              <div className="mt-2 space-y-2">
                <pre className="max-h-80 overflow-auto rounded-lg bg-muted p-3 font-mono text-[11px] leading-relaxed">
                  {body.text || '(empty body)'}
                </pre>
                <div className="flex flex-wrap items-center gap-2">
                  <CopyButton value={e.rawBody} label="Copy raw" />
                  {e.userAgent && (
                    <span className="truncate text-[11px] text-muted-foreground">
                      Sent by: {e.userAgent}
                    </span>
                  )}
                </div>
              </div>
            </details>
          </div>
        )
      })}
    </div>
  )
}
