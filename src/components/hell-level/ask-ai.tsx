'use client'

import Link from 'next/link'
import { useEffect, useRef, useState } from 'react'
import { useQuery, type UseQueryResult } from '@tanstack/react-query'
import { ArrowRight, ArrowUp, CheckCircle2, RotateCcw, Sparkles, Square } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { Attention, AttentionSection } from '@/lib/hl/ask-attention'
import type { AskEvent } from '@/lib/hl/ask'
import { Button, ErrorNote, Spinner, hlFetch } from './ui'
import { Markdown } from './markdown'

/**
 * Ask AI (src/lib/hl/ask.ts): the "Needs attention" list beside a chat that
 * answers questions from the sub-account's real data (or every
 * sub-account's, in the agency view). Read-only: it looks things up, it
 * never sends or changes anything.
 */

type Turn = { role: 'user' | 'assistant'; text: string; looked?: string[]; error?: string; stopped?: boolean }

const SUGGEST_ACCOUNT = [
  'Who’s waiting on a reply?',
  'How many leads this month vs last month, and from where?',
  'How fast are new leads getting a text back?',
  'Which open deals are worth the most?',
  'What’s on the calendar this week?',
  'Did any texts or automations fail this week?',
]
const SUGGEST_AGENCY = [
  'Which clients haven’t had a lead in 2 weeks?',
  'Whose texting still isn’t live, and what is it waiting on?',
  'Did any texts or automations fail this week, and why?',
  'Which clients got the most leads this month?',
  'How fast is each client answering new leads?',
]

/** Kept while moving around Hell-level (a link in an answer, then back), until a reload. */
const kept = new Map<string, Turn[]>()

export function AskAi({ accountId, name }: { accountId: string | null; name: string | null }) {
  const key = accountId ?? 'agency'
  const api = accountId ? `/api/hl/accounts/${accountId}/ask` : '/api/hl/agency/ask'
  const attention = useQuery<Attention>({ queryKey: ['hl', 'ask-attention', key], queryFn: () => hlFetch(api), refetchInterval: 60_000 })
  const [turns, setTurns] = useState<Turn[]>(() => kept.get(key) ?? [])
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const stop = useRef<AbortController | null>(null)
  const bottom = useRef<HTMLDivElement>(null)
  const box = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    kept.set(key, turns)
  }, [key, turns])
  // Leaving mid-answer stops it (no paying for an answer nobody reads).
  useEffect(() => () => stop.current?.abort(), [])
  useEffect(() => {
    bottom.current?.scrollIntoView({ block: 'end' })
  }, [turns])

  const patchLast = (fn: (t: Turn) => Turn) => setTurns((all) => [...all.slice(0, -1), fn(all[all.length - 1])])

  /** Ask, after `prior` (the chat so far, unless retrying). */
  const ask = async (question: string, prior: Turn[] = turns) => {
    const q = question.trim()
    if (!q || busy) return
    const shown: Turn[] = [...prior, { role: 'user', text: q }]
    // Failed answers aren't sent back; the server keeps the turns alternating.
    const history = shown.filter((t) => !t.error && t.text)
    setTurns([...shown, { role: 'assistant', text: '', looked: [] }])
    setDraft('')
    setBusy(true)
    setStatus('Thinking')
    const ctrl = new AbortController()
    stop.current = ctrl
    try {
      const res = await fetch(api, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ messages: history.map((t) => ({ role: t.role, text: t.text })) }),
        signal: ctrl.signal,
      })
      if (!res.ok || !res.body) {
        const body = (await res.json().catch(() => ({}))) as { error?: string }
        throw new Error(body.error || `Request failed (${res.status})`)
      }
      const reader = res.body.getReader()
      const dec = new TextDecoder()
      let buf = ''
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        buf += dec.decode(value, { stream: true })
        let nl: number
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).trim()
          buf = buf.slice(nl + 1)
          if (!line) continue
          const e = JSON.parse(line) as AskEvent
          if (e.type === 'status') {
            setStatus(e.text)
            patchLast((t) => ({ ...t, looked: t.looked?.includes(e.text) ? t.looked : [...(t.looked ?? []), e.text] }))
          } else if (e.type === 'text') {
            setStatus(null)
            patchLast((t) => ({ ...t, text: t.text + e.text }))
          } else if (e.type === 'clear') {
            patchLast((t) => ({ ...t, text: '' }))
          } else if (e.type === 'error') {
            patchLast((t) => ({ ...t, error: e.error }))
          }
        }
      }
    } catch (err) {
      if (ctrl.signal.aborted) patchLast((t) => ({ ...t, stopped: true }))
      else patchLast((t) => ({ ...t, error: err instanceof Error ? err.message : 'Something went wrong.' }))
    } finally {
      setBusy(false)
      setStatus(null)
      stop.current = null
      box.current?.focus()
    }
  }

  const retry = () => {
    const at = turns.map((t) => t.role).lastIndexOf('user')
    if (at >= 0) void ask(turns[at].text, turns.slice(0, at))
  }

  const empty = !turns.length
  const suggestions = accountId ? SUGGEST_ACCOUNT : SUGGEST_AGENCY

  return (
    <div className="flex h-full min-h-0">
      <section className="flex min-w-0 flex-1 flex-col">
        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto flex max-w-3xl flex-col gap-6 px-6 py-7">
            {empty ? (
              <div className="flex flex-col gap-6 pt-6">
                <div className="flex flex-col items-start gap-3">
                  <span className="grid h-10 w-10 place-items-center rounded-lg border border-border bg-surface text-primary">
                    <Sparkles className="h-5 w-5" />
                  </span>
                  <h1 className="text-[24px] font-semibold tracking-tight text-foreground">{accountId ? `Ask about ${name ?? 'this sub-account'}` : 'Ask about all your clients'}</h1>
                  <p className="max-w-xl text-[13.5px] leading-relaxed text-muted-foreground">
                    {accountId
                      ? 'Plain-English questions about this sub-account’s leads, conversations, deals, calendar and automations, answered from its real data.'
                      : 'Plain-English questions across every client’s sub-account: who’s getting leads, who’s gone quiet, what’s broken.'}{' '}
                    It only looks things up; it never sends or changes anything.
                  </p>
                </div>
                {attention.data && <Today items={attention.data.today} />}
                <div className="flex flex-wrap gap-2">
                  {suggestions.map((s) => (
                    <button key={s} type="button" onClick={() => void ask(s)} className="rounded-full border border-border bg-surface px-3 py-1.5 text-left text-[12.5px] text-foreground/85 transition hover:border-primary/50 hover:text-foreground">
                      {s}
                    </button>
                  ))}
                </div>
                {/* Below the chat on narrow screens; beside it on wide ones. */}
                <div className="lg:hidden">
                  <AttentionList query={attention} busy={busy} onAsk={(q) => void ask(q)} />
                </div>
              </div>
            ) : (
              turns.map((t, i) =>
                t.role === 'user' ? (
                  <div key={i} className="ml-auto max-w-[85%] whitespace-pre-wrap rounded-xl rounded-br-sm border border-border bg-surface px-3.5 py-2.5 text-[14px] text-foreground">
                    {t.text}
                  </div>
                ) : (
                  <div key={i} className="flex gap-3">
                    <span className="mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-md border border-border bg-surface text-primary">
                      <Sparkles className="h-3.5 w-3.5" />
                    </span>
                    <div className="flex min-w-0 flex-1 flex-col gap-2">
                      {!!t.looked?.length && (
                        <p className="font-mono text-[11px] text-muted-foreground">{t.looked.join(' · ')}</p>
                      )}
                      {busy && i === turns.length - 1 && !t.text && (
                        <p className="flex items-center gap-2 text-[13px] text-muted-foreground">
                          <Spinner className="h-3.5 w-3.5" />
                          {status ?? 'Thinking'}…
                        </p>
                      )}
                      {t.text && <Markdown text={t.text} />}
                      {t.stopped && <p className="text-[12.5px] text-muted-foreground">Stopped.</p>}
                      {t.error && (
                        <div className="flex flex-wrap items-center gap-3">
                          <ErrorNote error={new Error(t.error)} />
                          {i === turns.length - 1 && (
                            <Button size="sm" icon={<RotateCcw className="h-3.5 w-3.5" />} onClick={retry}>
                              Try again
                            </Button>
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                ),
              )
            )}
            <div ref={bottom} />
          </div>
        </div>

        <div className="border-t border-border px-6 py-4">
          <form
            className="mx-auto flex max-w-3xl flex-col gap-2"
            onSubmit={(e) => {
              e.preventDefault()
              void ask(draft)
            }}
          >
            <div className="flex items-end gap-2 rounded-xl border border-border bg-surface p-2 focus-within:border-primary/50">
              <textarea
                ref={box}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                    e.preventDefault()
                    void ask(draft)
                  }
                }}
                rows={Math.min(6, Math.max(1, draft.split('\n').length))}
                maxLength={2000}
                placeholder={accountId ? `Ask anything about ${name ?? 'this sub-account'}…` : 'Ask anything across your clients…'}
                className="max-h-40 min-h-9 flex-1 resize-none bg-transparent px-2 py-1.5 text-[14px] text-foreground outline-none placeholder:text-muted-foreground"
                autoFocus
              />
              {busy ? (
                <button type="button" onClick={() => stop.current?.abort()} className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-muted text-foreground transition hover:bg-muted/70" title="Stop">
                  <Square className="h-3.5 w-3.5 fill-current" />
                </button>
              ) : (
                <button type="submit" disabled={!draft.trim()} className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-primary text-primary-foreground transition hover:bg-primary/90 disabled:opacity-40" title="Ask">
                  <ArrowUp className="h-4 w-4" />
                </button>
              )}
            </div>
            <div className="flex items-center justify-between gap-3 text-[11.5px] text-muted-foreground">
              <span>Read-only: it looks things up and never sends or changes anything. A few cents a question.</span>
              {!empty && (
                <button type="button" disabled={busy} onClick={() => setTurns([])} className="flex shrink-0 items-center gap-1.5 hover:text-foreground disabled:opacity-40">
                  <RotateCcw className="h-3 w-3" /> New chat
                </button>
              )}
            </div>
          </form>
        </div>
      </section>

      <aside className="hidden w-[340px] shrink-0 overflow-y-auto border-l border-border px-5 py-6 lg:block">
        {!empty && attention.data && (
          <div className="mb-5">
            <Today items={attention.data.today} compact />
          </div>
        )}
        <AttentionList query={attention} busy={busy} onAsk={(q) => void ask(q)} />
      </aside>
    </div>
  )
}

function AttentionList({ query, busy, onAsk }: { query: UseQueryResult<Attention>; busy: boolean; onAsk: (q: string) => void }) {
  const sections = query.data?.sections.filter((s) => s.count > 0) ?? []
  return (
    <div className="flex flex-col gap-3">
      <p className="eyebrow text-muted-foreground">Needs attention</p>
      {query.isLoading ? (
        <div className="flex justify-center py-8">
          <Spinner />
        </div>
      ) : query.error ? (
        <ErrorNote error={query.error} />
      ) : !sections.length ? (
        <p className="flex items-center gap-2 rounded-lg border border-border bg-surface px-3 py-3 text-[13px] text-muted-foreground">
          <CheckCircle2 className="h-4 w-4 text-success" /> Nothing needs attention right now.
        </p>
      ) : (
        sections.map((s) => <SectionCard key={s.key} s={s} onAsk={onAsk} disabled={busy} />)
      )}
    </div>
  )
}

function Today({ items, compact }: { items: Attention['today']; compact?: boolean }) {
  return (
    <div className={cn('grid gap-2', compact ? 'grid-cols-2' : 'grid-cols-2 sm:grid-cols-4')}>
      {items.map((t) => {
        const inner = (
          <>
            <span className="block font-mono text-[18px] font-semibold text-foreground">{t.value}</span>
            <span className="block text-[11.5px] text-muted-foreground">{t.label}</span>
          </>
        )
        return t.link ? (
          <Link key={t.label} href={t.link} className="rounded-lg border border-border bg-surface px-3 py-2 transition hover:border-primary/40">
            {inner}
          </Link>
        ) : (
          <div key={t.label} className="rounded-lg border border-border bg-surface px-3 py-2">
            {inner}
          </div>
        )
      })}
    </div>
  )
}

function SectionCard({ s, onAsk, disabled }: { s: AttentionSection; onAsk: (q: string) => void; disabled: boolean }) {
  return (
    <div className="rounded-lg border border-border bg-surface">
      <div className="flex items-start justify-between gap-2 px-3 pt-3">
        <div className="min-w-0">
          <p className="text-[13px] font-medium text-foreground">{s.title}</p>
          <p className="text-[11.5px] leading-snug text-muted-foreground">{s.hint}</p>
        </div>
        <span className="shrink-0 rounded-full bg-primary-soft px-2 py-0.5 font-mono text-[11px] font-semibold text-primary">{s.count}</span>
      </div>
      <ul className="mt-2 flex flex-col">
        {s.items.map((it, i) => (
          <li key={i}>
            <Link href={it.link} className="flex flex-col px-3 py-1.5 transition hover:bg-white/[0.03]">
              <span className="truncate text-[12.5px] text-foreground/90">{it.label}</span>
              <span className="truncate text-[11.5px] text-muted-foreground">{it.detail}</span>
            </Link>
          </li>
        ))}
      </ul>
      {s.count > s.items.length && <p className="px-3 pt-1 text-[11.5px] text-muted-foreground">and {s.count - s.items.length} more</p>}
      <button type="button" disabled={disabled} onClick={() => onAsk(s.ask)} className="flex w-full items-center gap-1.5 border-t border-border-soft px-3 py-2 text-left text-[12px] font-medium text-primary transition hover:bg-white/[0.03] disabled:opacity-40">
        Ask about this <ArrowRight className="h-3 w-3" />
      </button>
    </div>
  )
}
