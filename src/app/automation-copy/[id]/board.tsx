'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, ArrowLeft, Check, ChevronRight, Copy, Folder, Loader2, RotateCcw } from 'lucide-react'
import { cn } from '@/lib/utils'
import { PageHeader } from '@/components/ui/page-header'
import {
  automationFolders,
  blanksIn,
  forCopy,
  segments,
  smsSegments,
  type Automation,
  type AutomationInputs,
  type CopyPiece,
} from '@/lib/automation-copy'
import { GhlPanel } from './ghl-panel'

type Saved = { values: Partial<AutomationInputs>; done: string[]; updatedAt: string | null }
type BoardData = {
  client: { id: string; name: string; siteUrl: string | null; hasIntake: boolean }
  prefill: AutomationInputs
  saved: Saved
}

const INPUTS: { key: keyof AutomationInputs; label: string; placeholder: string; hint?: string }[] = [
  { key: 'businessName', label: 'Business name', placeholder: 'A Plus Fence & Construction', hint: 'Signs every text. Shorten it if the client goes by a shorter name.' },
  { key: 'ownerFirstName', label: 'Owner first name', placeholder: 'Todd', hint: 'Signs the missed-call text and opens the internal notification.' },
  { key: 'ownerFullName', label: 'Owner full name', placeholder: 'Todd Robinson', hint: 'Signs the texts to new leads.' },
  { key: 'phone', label: 'Business phone', placeholder: '(830) 307-5740', hint: 'The number leads are told to call.' },
  { key: 'quoteLink', label: 'Website link', placeholder: 'https://aplusconstruction.org/', hint: 'The free-quote link in the missed-call text.' },
  { key: 'notifyEmail', label: 'Notification email', placeholder: 'owner@example.com', hint: 'From the onboarding form. Internal notifications go here.' },
]

export function AutomationCopyBoard({ clientId }: { clientId: string }) {
  const q = useQuery({
    queryKey: ['automation-copy', clientId],
    queryFn: async (): Promise<BoardData> => {
      const res = await fetch(`/api/automation-copy/${clientId}`)
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || 'Failed to load')
      return data
    },
    staleTime: Infinity,
    refetchOnWindowFocus: false,
  })

  return (
    <div className="mx-auto flex max-w-[1280px] flex-col gap-6">
      <PageHeader
        title={q.data ? q.data.client.name : 'Automation Copy'}
        subtitle="The copy for this client’s GHL automations, filled in from their onboarding answers. Copy each box into the matching action in their sub-account."
        breadcrumbs={[{ label: 'Genisys' }, { label: 'Automation Copy', href: '/automation-copy' }, { label: q.data?.client.name ?? 'Client' }]}
        actions={
          <Link
            href="/automation-copy"
            className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-card px-4 py-2 text-sm font-medium text-foreground transition hover:bg-muted"
          >
            <ArrowLeft className="h-4 w-4" /> All clients
          </Link>
        }
      />
      {q.isLoading ? (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading…
        </p>
      ) : q.error ? (
        <p className="text-sm text-destructive">{(q.error as Error).message}</p>
      ) : q.data ? (
        <Board clientId={clientId} data={q.data} />
      ) : null}
    </div>
  )
}

function Board({ clientId, data }: { clientId: string; data: BoardData }) {
  const qc = useQueryClient()
  const [edits, setEditsState] = useState<Partial<AutomationInputs>>(data.saved.values)
  const [done, setDoneState] = useState<string[]>(data.saved.done)
  const [save, setSave] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle')
  const latest = useRef({ edits, done })
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current)
  }, [])

  function queueSave(next: { edits?: Partial<AutomationInputs>; done?: string[] }) {
    latest.current = { ...latest.current, ...next }
    setSave('saving')
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(async () => {
      try {
        const res = await fetch(`/api/automation-copy/${clientId}`, {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ values: latest.current.edits, done: latest.current.done }),
        })
        setSave(res.ok ? 'saved' : 'error')
        // The client list shows the "set up" count.
        if (res.ok) qc.invalidateQueries({ queryKey: ['automation-copy'], exact: true })
      } catch {
        setSave('error')
      }
    }, 700)
  }
  function setValue(key: keyof AutomationInputs, value: string) {
    const next = { ...latest.current.edits, [key]: value }
    setEditsState(next)
    queueSave({ edits: next })
  }
  function reset(key: keyof AutomationInputs) {
    const next = { ...latest.current.edits }
    delete next[key]
    setEditsState(next)
    queueSave({ edits: next })
  }
  function toggleDone(id: string) {
    const next = latest.current.done.includes(id) ? latest.current.done.filter((d) => d !== id) : [...latest.current.done, id]
    setDoneState(next)
    queueSave({ done: next })
  }

  const values = useMemo(() => ({ ...data.prefill, ...edits }) as AutomationInputs, [data.prefill, edits])
  const folders = useMemo(() => automationFolders(values), [values])
  const totalBlanks = useMemo(
    () => new Set(folders.flatMap((f) => f.automations.flatMap((a) => a.pieces.flatMap((p) => blanksIn(p.text))))).size,
    [folders],
  )

  return (
    <div className="grid items-start gap-6 lg:grid-cols-[20rem_minmax(0,1fr)]">
      <aside className="flex flex-col gap-4 lg:sticky lg:top-6">
        <section className="rounded-xl border border-border-soft bg-surface p-4">
          <div className="mb-3 flex items-baseline justify-between gap-3">
            <p className="eyebrow text-muted-foreground">Details</p>
            <p className="font-mono text-[11px] text-muted-foreground/70">
              {save === 'saving' ? 'Saving…' : save === 'saved' ? 'Saved' : save === 'error' ? 'Couldn’t save' : 'Saved per client'}
            </p>
          </div>
          {!data.client.hasIntake && (
            <p className="mb-3 rounded-lg border border-border bg-card px-3 py-2 text-[12px] text-muted-foreground">
              This client has no onboarding answers, so most details start empty.
            </p>
          )}
          <div className="flex flex-col gap-3">
            {INPUTS.map((f) => {
              const edited = f.key in edits && edits[f.key] !== data.prefill[f.key]
              const empty = !values[f.key].trim()
              return (
                <label key={f.key} className="flex flex-col gap-1">
                  <span className="flex items-center justify-between gap-2">
                    <span className="eyebrow text-muted-foreground/80">{f.label}</span>
                    {edited && (
                      <button
                        type="button"
                        onClick={(e) => {
                          e.preventDefault()
                          reset(f.key)
                        }}
                        className="inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground"
                        title={data.prefill[f.key] ? `Back to “${data.prefill[f.key]}” from onboarding` : 'Clear'}
                      >
                        <RotateCcw className="h-3 w-3" /> {data.prefill[f.key] ? 'Onboarding value' : 'Clear'}
                      </button>
                    )}
                  </span>
                  <input
                    value={values[f.key]}
                    onChange={(e) => setValue(f.key, e.target.value)}
                    placeholder={f.placeholder}
                    spellCheck={false}
                    className={cn(
                      'h-9 w-full rounded-md border bg-card px-2.5 py-1.5 text-[13px] outline-none transition focus:border-foreground/30',
                      empty ? 'border-amber-500/40' : 'border-border',
                    )}
                  />
                  {f.hint && <span className="text-[11px] leading-snug text-muted-foreground/80">{f.hint}</span>}
                </label>
              )
            })}
          </div>
        </section>
      </aside>

      <div className="flex min-w-0 flex-col gap-6">
        {totalBlanks > 0 && (
          <p className="flex items-start gap-2 rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-[13px]">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" />
            <span>
              {totalBlanks} detail{totalBlanks === 1 ? '' : 's'} still blank, highlighted below. Fill {totalBlanks === 1 ? 'it' : 'them'} in on the left before
              copying.
            </span>
          </p>
        )}
        <p className="text-[12px] leading-snug text-muted-foreground">
          <MergeChip text="{{contact.first_name}}" /> and the like are GHL merge fields. Leave them as they are; GHL fills them in for each lead.
        </p>

        <GhlPanel clientId={clientId} values={values} />

        {folders.map((folder) => {
          const doneHere = folder.automations.filter((a) => done.includes(a.id)).length
          return (
            <details key={folder.id} open className="group rounded-xl border border-border-soft bg-surface">
              <summary className="flex cursor-pointer list-none items-center gap-2.5 px-4 py-3 [&::-webkit-details-marker]:hidden">
                <ChevronRight className="h-4 w-4 text-muted-foreground transition group-open:rotate-90" />
                <Folder className="h-4 w-4 text-muted-foreground" />
                <span className="flex-1 text-[14px] font-semibold">{folder.name}</span>
                <span className="font-mono text-[11px] text-muted-foreground">
                  {doneHere}/{folder.automations.length} set up
                </span>
              </summary>
              <div className="flex flex-col gap-4 border-t border-border-soft p-4">
                {folder.automations.map((a) => (
                  <AutomationCard key={a.id} automation={a} done={done.includes(a.id)} onToggle={() => toggleDone(a.id)} />
                ))}
              </div>
            </details>
          )
        })}
      </div>
    </div>
  )
}

function AutomationCard({ automation, done, onToggle }: { automation: Automation; done: boolean; onToggle: () => void }) {
  return (
    <section className="flex flex-col gap-3 rounded-xl border border-border bg-card p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-[14px] font-semibold">{automation.name}</h2>
          <p className="font-mono text-[11px] text-muted-foreground">{automation.where}</p>
        </div>
        <label className="inline-flex cursor-pointer items-center gap-2 text-[12.5px] text-muted-foreground">
          <input type="checkbox" checked={done} onChange={onToggle} className="h-4 w-4 accent-foreground" />
          <span className={cn(done && 'text-emerald-600 dark:text-emerald-400')}>Set up in GHL</span>
        </label>
      </div>
      <div className="flex flex-col gap-3">
        {automation.pieces.map((p) => (
          <PieceCard key={p.id} piece={p} />
        ))}
      </div>
    </section>
  )
}

function PieceCard({ piece }: { piece: CopyPiece }) {
  const [copied, setCopied] = useState(false)
  const text = forCopy(piece.text)
  const blanks = blanksIn(piece.text)
  const sms = piece.kind === 'sms' ? smsSegments(piece.text) : null

  async function copy() {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      setCopied(false)
    }
  }

  return (
    <div className="flex min-w-0 flex-col gap-2 rounded-lg border border-border-soft bg-surface p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[13px] font-medium">{piece.label}</p>
          <p className="font-mono text-[11px] text-muted-foreground">
            {sms
              ? `~${sms.chars} characters · ${sms.segments} SMS segment${sms.segments === 1 ? '' : 's'}${sms.unicode ? ' (Unicode)' : ''}`
              : piece.kind === 'email'
                ? 'Internal notification'
                : 'Paste as is'}
            {blanks.length ? ` · ${blanks.length} blank${blanks.length === 1 ? '' : 's'}` : ''}
          </p>
        </div>
        <button
          type="button"
          onClick={copy}
          className={cn(
            'inline-flex shrink-0 items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-medium transition',
            copied ? 'border-emerald-500/40 text-emerald-600 dark:text-emerald-400' : 'border-border bg-card hover:bg-muted',
          )}
        >
          {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <div
        className={cn(
          'whitespace-pre-wrap break-words rounded-md border border-border-soft bg-card px-3 py-2.5 leading-relaxed',
          piece.kind === 'value' ? 'font-mono text-[12.5px]' : 'text-[13px]',
        )}
      >
        {segments(piece.text).map((s, i) =>
          s.kind === 'blank' ? (
            <mark key={i} className="rounded bg-amber-500/20 px-0.5 font-medium text-amber-700 dark:text-amber-300">
              {s.text}
            </mark>
          ) : s.kind === 'merge' ? (
            <MergeChip key={i} text={s.text} />
          ) : (
            <span key={i}>{s.text}</span>
          ),
        )}
      </div>
      {piece.note && <p className="text-[11.5px] leading-snug text-muted-foreground">{piece.note}</p>}
    </div>
  )
}

function MergeChip({ text }: { text: string }) {
  return <span className="rounded bg-sky-500/15 px-0.5 font-mono text-[12px] text-sky-700 dark:text-sky-300">{text}</span>
}
