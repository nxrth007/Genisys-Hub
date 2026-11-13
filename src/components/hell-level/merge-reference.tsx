'use client'

import { useMemo, useState } from 'react'
import { BookOpen, Check, Copy, Plus } from 'lucide-react'
import { cn } from '@/lib/utils'
import { renderTemplate, type MergeData } from '@/lib/hl/merge'
import { GHL_NOT_FILLED, MERGE_GROUPS, MERGE_RULES, fillToday, insertToken, sampleMerge, type MergeFieldDoc } from '@/lib/hl/merge-fields'
import type { HlProfile } from '@/lib/hl/types'
import { Badge, Input, Modal, copyText } from './ui'

/**
 * The merge field reference: GHL's field picker laid out as a guide (kinds
 * down the left, the fields on the right), with what each one fills with,
 * where that comes from, what happens when it's blank and GoHighLevel's name
 * for it. Everything comes from src/lib/hl/merge-fields.ts; the values shown
 * are the same code's, filled with the sample lead and this sub-account's
 * Business Profile.
 */

const NOT_FILLED = 'not-filled'
const RULES = 'rules'

/** "{{ Location.Name }}", "location.name" and "location name" find the same field. */
const norm = (s: string) => s.toLowerCase().replace(/[{}\s_.]/g, '')

const haystack = (f: MergeFieldDoc) => norm([f.token, f.label, f.example, f.hl, ...(f.also ?? []), ...f.ghl, ...(f.ghlNot ?? [])].filter(Boolean).join('|'))

function Code({ children }: { children: React.ReactNode }) {
  return <code className="rounded bg-surface-muted px-1.5 py-0.5 font-mono text-[12px] text-foreground/90">{children}</code>
}

function Codes({ list }: { list: string[] }) {
  return (
    <span className="flex flex-wrap gap-1">
      {list.map((t) => (
        <Code key={t}>{t}</Code>
      ))}
    </span>
  )
}

function Row({ k, children }: { k: string; children: React.ReactNode }) {
  return (
    <>
      <dt className="text-muted-foreground/80">{k}</dt>
      <dd className="min-w-0 text-foreground/85">{children}</dd>
    </>
  )
}

/** The GoHighLevel line: its names that fill here, the ones that don't, or "Hell-level only". */
function Ghl({ f }: { f: MergeFieldDoc }) {
  const own = f.ghl.includes(f.token)
  const others = f.ghl.filter((t) => t !== f.token)
  return (
    <span className="flex flex-col gap-1">
      {own && <span>The same name in GoHighLevel.{f.hl && <> Hell-level’s name for it: <Code>{f.hl}</Code></>}</span>}
      {others.length > 0 && (
        <span className="flex flex-wrap items-center gap-1">
          <Codes list={others} />
          <span className="text-muted-foreground">{own ? 'also' : others.length > 1 ? 'all fill here too' : 'fills here too'}</span>
        </span>
      )}
      {(f.ghlNot?.length ?? 0) > 0 && (
        <span className="flex flex-wrap items-center gap-1">
          <Codes list={f.ghlNot!} />
          <span className="text-warning">{f.ghlNot!.length > 1 ? 'don’t' : 'doesn’t'} fill here: use this one</span>
        </span>
      )}
      {!f.ghl.length && !f.ghlNot?.length && <span className="font-medium text-foreground/90">Hell-level only</span>}
      {f.ghlNote && <span className="text-muted-foreground">{f.ghlNote}</span>}
    </span>
  )
}

function FieldCard({ f, merge, account, picking, copied, onTake }: { f: MergeFieldDoc; merge: MergeData; account: boolean; picking: boolean; copied: string | null; onTake: (token: string) => void }) {
  const token = insertToken(f)
  const value = renderTemplate(fillToday(token), merge)
  const hlOnly = !f.ghl.length && !f.ghlNot?.length
  return (
    <div className="rounded-lg border border-border bg-card p-3.5">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-[13.5px] font-semibold text-foreground">{f.label}</p>
          <div className="mt-1 flex flex-wrap items-center gap-2">
            <Code>{f.token}</Code>
            <button
              type="button"
              onClick={() => onTake(token)}
              className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-0.5 text-[11.5px] font-medium text-muted-foreground transition hover:border-primary/50 hover:text-foreground"
              title={picking ? 'Put it in the message' : 'Copy it'}
            >
              {picking ? <Plus className="h-3 w-3" /> : copied === token ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
              {picking ? 'Insert' : copied === token ? 'Copied' : 'Copy'}
              {f.example && <span className="font-mono">{f.example}</span>}
            </button>
          </div>
        </div>
        {hlOnly ? <Badge color="purple">Hell-level only</Badge> : f.ghl.includes(f.token) ? <Badge color="green">Same in GHL</Badge> : null}
      </div>
      <dl className="mt-2.5 grid grid-cols-[96px_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-[12.5px] leading-relaxed">
        <Row k="Fills with">{f.fills}</Row>
        <Row k="Comes from">{f.from}</Row>
        <Row k="When blank">{f.blank}</Row>
        <Row k="GoHighLevel">
          <Ghl f={f} />
        </Row>
        {(f.also?.length ?? 0) > 0 && (
          <Row k="Also works">
            <Codes list={f.also!} />
          </Row>
        )}
        <Row k={account ? 'This account' : 'Sample lead'}>
          {value ? (
            <span className="whitespace-pre-wrap break-all text-foreground/90">{value}</span>
          ) : account ? (
            <span className="text-warning">Not set. Fill it in under Settings → Business Profile.</span>
          ) : (
            <span className="text-muted-foreground/70">Blank for the sample lead</span>
          )}
        </Row>
      </dl>
    </div>
  )
}

function NotFilled({ rows, onTake, picking }: { rows: typeof GHL_NOT_FILLED; onTake: (token: string) => void; picking: boolean }) {
  return (
    <section className="flex flex-col gap-2.5">
      <p className="text-[13px] text-muted-foreground">
        GoHighLevel names Hell-level doesn’t fill yet, from GHL’s own list. “Blank” ones come out empty with no warning. “As typed” ones go out with their braces, and the editor warns “Won’t fill” under the message.
      </p>
      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="w-full text-left text-[12.5px]">
          <thead>
            <tr className="border-b border-border">
              <th className="eyebrow px-3 py-2 text-muted-foreground">GoHighLevel</th>
              <th className="eyebrow px-3 py-2 text-muted-foreground">Here it’s</th>
              <th className="eyebrow px-3 py-2 text-muted-foreground">Use instead</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((m) => (
              <tr key={m.token} className="border-b border-border-soft align-top last:border-0">
                <td className="px-3 py-2 font-mono text-foreground/90">{m.token}</td>
                <td className="px-3 py-2">{m.becomes === 'kept' ? <Badge color="red">As typed</Badge> : <Badge>Blank</Badge>}</td>
                <td className="px-3 py-2 text-foreground/85">
                  {m.instead && (
                    <button type="button" onClick={() => onTake(m.instead!)} className="font-mono text-primary hover:underline" title={picking ? 'Put it in the message' : 'Copy it'}>
                      {m.instead}
                    </button>
                  )}
                  {m.note && <span className={cn('block text-muted-foreground', m.instead && 'mt-0.5')}>{m.note}</span>}
                  {!m.instead && !m.note && <span className="text-muted-foreground/70">Nothing yet</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  )
}

function NavItem({ on, label, count, onClick }: { on: boolean; label: string; count?: number; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'flex items-center justify-between gap-2 rounded-md px-2.5 py-1.5 text-left text-[13px] transition',
        on ? 'bg-white/[0.06] text-foreground' : 'text-muted-foreground hover:bg-white/[0.04] hover:text-foreground',
      )}
    >
      <span>{label}</span>
      {count !== undefined && <span className="font-mono text-[11px] text-muted-foreground/70">{count}</span>}
    </button>
  )
}

export function MergeReference({
  profile,
  data,
  onPick,
  initialQuery = '',
  framed = false,
}: {
  profile: HlProfile
  /** The workflow's own samples (its webhook reference, kept test responses), over the sample lead. */
  data?: Partial<MergeData>
  /** Opened from a message box: a field's button puts it in the message. Otherwise it copies. */
  onPick?: (token: string) => void
  initialQuery?: string
  /** Inside a modal: the fields scroll on their own. */
  framed?: boolean
}) {
  const [query, setQuery] = useState(initialQuery)
  const [view, setView] = useState(MERGE_GROUPS[0].key)
  const [copied, setCopied] = useState<string | null>(null)
  const merge = useMemo<MergeData>(() => ({ ...sampleMerge(profile), ...data }), [profile, data])
  const q = norm(query)
  const groups = q
    ? MERGE_GROUPS.map((g) => ({ ...g, fields: g.fields.filter((f) => haystack(f).includes(q)) })).filter((g) => g.fields.length)
    : MERGE_GROUPS.filter((g) => g.key === view)
  const missing = q ? GHL_NOT_FILLED.filter((m) => norm(`${m.token}|${m.instead ?? ''}`).includes(q)) : view === NOT_FILLED ? GHL_NOT_FILLED : []
  const take = (token: string) => {
    if (onPick) return onPick(token)
    copyText(token)
    setCopied(token)
    window.setTimeout(() => setCopied((c) => (c === token ? null : c)), 1500)
  }
  return (
    <div className="flex flex-col gap-4">
      <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search, or paste a GoHighLevel field like {{location.name}}" aria-label="Search merge fields" />
      <div className="flex flex-col gap-4 sm:flex-row">
        {!q && (
          <nav className="flex shrink-0 flex-wrap gap-1 sm:w-52 sm:flex-col sm:flex-nowrap sm:gap-px">
            {MERGE_GROUPS.map((g) => (
              <NavItem key={g.key} on={view === g.key} label={g.title} count={g.fields.length} onClick={() => setView(g.key)} />
            ))}
            <NavItem on={view === NOT_FILLED} label="GHL names that don’t fill" count={GHL_NOT_FILLED.length} onClick={() => setView(NOT_FILLED)} />
            <NavItem on={view === RULES} label="How filling works" onClick={() => setView(RULES)} />
          </nav>
        )}
        <div className={cn('flex min-w-0 flex-1 flex-col gap-5', framed && 'max-h-[62vh] overflow-y-auto pr-1')}>
          {groups.map((g) => (
            <section key={g.key} className="flex flex-col gap-2.5">
              {q ? <p className="eyebrow text-muted-foreground">{g.title}</p> : <p className="text-[13px] text-muted-foreground">{g.intro}</p>}
              {g.fields.map((f) => (
                <FieldCard key={f.token} f={f} merge={merge} account={g.key === 'account'} picking={!!onPick} copied={copied} onTake={take} />
              ))}
            </section>
          ))}
          {missing.length > 0 && <NotFilled rows={missing} onTake={take} picking={!!onPick} />}
          {!q && view === RULES && (
            <ul className="flex flex-col gap-2 text-[13px] text-foreground/85">
              {MERGE_RULES.map((r) => (
                <li key={r} className="flex gap-2">
                  <span className="mt-[7px] h-1.5 w-1.5 shrink-0 rounded-full bg-primary/70" />
                  <span>{r}</span>
                </li>
              ))}
            </ul>
          )}
          {q && !groups.length && !missing.length && (
            <p className="py-10 text-center text-[13px] text-muted-foreground">No merge field matches “{query.trim()}”. One Hell-level doesn’t know stays in the message as typed.</p>
          )}
        </div>
      </div>
    </div>
  )
}

/** The reference in a modal, over the step editor. `query` opens it searched (a field that won't fill). */
export function MergeReferenceModal({
  open,
  onClose,
  profile,
  data,
  onPick,
  query,
}: {
  open: boolean
  onClose: () => void
  profile: HlProfile
  data?: Partial<MergeData>
  onPick?: (token: string) => void
  query?: string
}) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Merge fields"
      description="What each {{…}} field fills with, where that comes from, what happens when it’s blank, and GoHighLevel’s name for it."
      width="max-w-4xl"
    >
      <MergeReference
        profile={profile}
        data={data}
        initialQuery={query}
        framed
        onPick={
          onPick
            ? (t) => {
                onPick(t)
                onClose()
              }
            : undefined
        }
      />
    </Modal>
  )
}

/** The small button beside a message box's Insert field menu. */
export function MergeReferenceButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex h-7 items-center gap-1.5 rounded-md border border-border bg-card px-2 text-[12px] text-foreground/90 transition hover:border-primary/50"
      title="Every merge field, what fills it, and GoHighLevel’s names"
    >
      <BookOpen className="h-3.5 w-3.5" />
      Merge fields
    </button>
  )
}
