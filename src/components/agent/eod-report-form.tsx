'use client'

import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import {
  ArrowLeft,
  Save,
  AlertCircle,
  Trash2,
  Phone,
  MessageCircle,
  CalendarCheck,
  ClipboardCheck,
  TriangleAlert,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { TECHNICAL_ISSUE_TAGS } from '@/lib/eod-reports'

export type EodFormValues = {
  reportDate: string // YYYY-MM-DD
  dialsMade: string // kept as string so the input can be empty
  contactsReached: string
  appointmentsGenerated: string
  callbacksScheduled: string
  technicalIssueTags: string[]
  technicalIssueNotes: string
  organizationalIssues: string
  wins: string
  tomorrowFocus: string
}

function todayISODate(): string {
  const d = new Date()
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

const EMPTY: EodFormValues = {
  reportDate: '',
  dialsMade: '',
  contactsReached: '',
  appointmentsGenerated: '',
  callbacksScheduled: '',
  technicalIssueTags: [],
  technicalIssueNotes: '',
  organizationalIssues: '',
  wins: '',
  tomorrowFocus: '',
}

export function EodReportForm({
  mode,
  initial,
  reportId,
  apiBase = '/api/agent/eod-reports',
  pageBase = '/agent/eod',
}: {
  mode: 'create' | 'edit'
  initial?: Partial<EodFormValues>
  reportId?: string
  /** API endpoint base. Defaults to Mary's agent path; Team #1
   *  pages pass '/api/team/eod-reports' so the same form posts to
   *  the role-gated endpoint for them. */
  apiBase?: string
  /** Page-level base for back-link and post-save redirects. */
  pageBase?: string
}) {
  const router = useRouter()
  const [values, setValues] = useState<EodFormValues>({
    ...EMPTY,
    reportDate: todayISODate(),
    ...initial,
  })
  const [saving, setSaving] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Keep reportDate sensible when create page mounts without initial override.
  useEffect(() => {
    if (mode === 'create' && !initial?.reportDate) {
      setValues((v) => ({ ...v, reportDate: todayISODate() }))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  function update<K extends keyof EodFormValues>(key: K, value: EodFormValues[K]) {
    setValues((v) => ({ ...v, [key]: value }))
  }

  function toggleTag(tag: string) {
    setValues((v) => {
      const next = new Set(v.technicalIssueTags)
      if (next.has(tag)) next.delete(tag)
      else next.add(tag)
      return { ...v, technicalIssueTags: Array.from(next) }
    })
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)

    const payload = {
      reportDate: values.reportDate,
      dialsMade: values.dialsMade === '' ? 0 : Number(values.dialsMade),
      contactsReached:
        values.contactsReached === '' ? 0 : Number(values.contactsReached),
      appointmentsGenerated:
        values.appointmentsGenerated === ''
          ? 0
          : Number(values.appointmentsGenerated),
      callbacksScheduled:
        values.callbacksScheduled === '' ? 0 : Number(values.callbacksScheduled),
      technicalIssueTags: values.technicalIssueTags,
      technicalIssueNotes: values.technicalIssueNotes || null,
      organizationalIssues: values.organizationalIssues || null,
      wins: values.wins || null,
      tomorrowFocus: values.tomorrowFocus || null,
    }

    setSaving(true)
    try {
      const url =
        mode === 'create' ? apiBase : `${apiBase}/${reportId}`
      const res = await fetch(url, {
        method: mode === 'create' ? 'POST' : 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      })
      const data = await res.json()
      if (!res.ok) {
        if (data.code === 'ALREADY_EXISTS' && data.existingId) {
          router.push(`${pageBase}/${data.existingId}`)
          return
        }
        throw new Error(data.error || 'Failed to save report')
      }
      router.push(pageBase)
      router.refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error')
    } finally {
      setSaving(false)
    }
  }

  async function onDelete() {
    if (!reportId) return
    if (
      !confirm(
        'Delete this EOD report? This only removes your submission — not any appointments.'
      )
    )
      return
    setDeleting(true)
    setError(null)
    try {
      const res = await fetch(`${apiBase}/${reportId}`, {
        method: 'DELETE',
      })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        throw new Error(data.error || 'Failed to delete')
      }
      router.push(pageBase)
      router.refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error')
      setDeleting(false)
    }
  }

  const hasAnyIssue =
    values.technicalIssueTags.length > 0 ||
    values.technicalIssueNotes.trim().length > 0 ||
    values.organizationalIssues.trim().length > 0

  return (
    <form onSubmit={onSubmit} className="mx-auto max-w-3xl space-y-6">
      <div>
        <Link
          href={pageBase}
          className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          Back to reports
        </Link>
        <h1 className="mt-2 text-2xl font-bold tracking-tight">
          {mode === 'create' ? 'Submit End-of-Day Report' : 'Edit EOD Report'}
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Quick recap of your shift — takes ~2 minutes. Ethan and the
          management team review these daily to unblock technical + process
          issues faster.
        </p>
      </div>

      {error && (
        <div className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive border-destructive/30 bg-destructive/10 text-destructive">
          <AlertCircle className="mt-0.5 h-4 w-4 flex-shrink-0" />
          <span>{error}</span>
        </div>
      )}

      <Section title="Shift date">
        <div className="max-w-xs">
          <input
            type="date"
            required
            value={values.reportDate}
            onChange={(e) => update('reportDate', e.target.value)}
            className="w-full rounded-md border border-border bg-card px-3 py-2 text-sm focus:border-primary/50 focus:outline-none border-border bg-background"
          />
          <p className="mt-1 text-xs text-muted-foreground">
            Defaults to today. Only one report per day — revisiting this page
            tomorrow will start a fresh one.
          </p>
        </div>
      </Section>

      <Section title="Activity numbers (required)">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <NumberField
            label="Dials made"
            icon={Phone}
            value={values.dialsMade}
            onChange={(v) => update('dialsMade', v)}
            hint="Total outbound attempts"
          />
          <NumberField
            label="Live contacts"
            icon={MessageCircle}
            value={values.contactsReached}
            onChange={(v) => update('contactsReached', v)}
            hint="Actual conversations"
          />
          <NumberField
            label="Appts generated"
            icon={CalendarCheck}
            value={values.appointmentsGenerated}
            onChange={(v) => update('appointmentsGenerated', v)}
            hint="Confirmed bookings today"
          />
          <NumberField
            label="Callbacks booked"
            icon={ClipboardCheck}
            value={values.callbacksScheduled}
            onChange={(v) => update('callbacksScheduled', v)}
            hint="Prospects for future follow-up"
          />
        </div>
      </Section>

      <Section title="Technical issues (optional)" icon={TriangleAlert}>
        <p className="mb-3 text-xs text-muted-foreground">
          Tap every category that caused friction today. Leave blank if the
          shift ran smoothly.
        </p>
        <div className="flex flex-wrap gap-2">
          {TECHNICAL_ISSUE_TAGS.map((tag) => {
            const active = values.technicalIssueTags.includes(tag.value)
            return (
              <button
                key={tag.value}
                type="button"
                onClick={() => toggleTag(tag.value)}
                className={cn(
                  'rounded-md border px-3 py-1 text-xs font-medium transition-colors',
                  active
                    ? 'border-warning bg-warning text-warning-foreground'
                    : 'border-border bg-card text-foreground/85 hover:border-amber-300 hover:bg-warning/15 border-border bg-card text-foreground/85 dark:hover:border-amber-700 hover:bg-warning/10'
                )}
              >
                {tag.label}
              </button>
            )
          })}
        </div>
        <textarea
          placeholder="Describe specifics — what broke, when, what you tried. The more detail, the faster we can fix it."
          value={values.technicalIssueNotes}
          onChange={(e) => update('technicalIssueNotes', e.target.value)}
          rows={3}
          className="mt-3 w-full rounded-md border border-border bg-card px-3 py-2 text-sm focus:border-primary/50 focus:outline-none border-border bg-background"
        />
      </Section>

      <Section title="Organizational / process issues (optional)">
        <textarea
          placeholder="Unclear scripts? Script/offer confusion? Missing leads? Leadership blockers? Anything non-technical that slowed the team down."
          value={values.organizationalIssues}
          onChange={(e) => update('organizationalIssues', e.target.value)}
          rows={3}
          className="w-full rounded-md border border-border bg-card px-3 py-2 text-sm focus:border-primary/50 focus:outline-none border-border bg-background"
        />
      </Section>

      <Section title="Wins / what went well (optional)">
        <textarea
          placeholder="Strong calls, breakthroughs, teammate shout-outs, anything notable in a good way."
          value={values.wins}
          onChange={(e) => update('wins', e.target.value)}
          rows={2}
          className="w-full rounded-md border border-border bg-card px-3 py-2 text-sm focus:border-primary/50 focus:outline-none border-border bg-background"
        />
      </Section>

      <Section title="Focus for tomorrow (optional)">
        <textarea
          placeholder={`e.g. "Follow up on the 3 callbacks from today", "Retry the list I couldn't finish".`}
          value={values.tomorrowFocus}
          onChange={(e) => update('tomorrowFocus', e.target.value)}
          rows={2}
          className="w-full rounded-md border border-border bg-card px-3 py-2 text-sm focus:border-primary/50 focus:outline-none border-border bg-background"
        />
      </Section>

      <div className="sticky bottom-0 flex items-center justify-between gap-3 border-t border-border bg-card px-1 py-3 border-border bg-background">
        <div className="text-xs text-muted-foreground">
          {hasAnyIssue
            ? 'Issues flagged — management will see this highlighted.'
            : 'No issues flagged.'}
        </div>
        <div className="flex items-center gap-2">
          {mode === 'edit' && (
            <button
              type="button"
              onClick={onDelete}
              disabled={deleting || saving}
              className="inline-flex items-center gap-1.5 rounded-md border border-destructive/30 px-3 py-2 text-sm font-medium text-destructive hover:bg-destructive/10 disabled:opacity-50 border-destructive/30 text-destructive hover:bg-destructive/10"
            >
              <Trash2 className="h-4 w-4" />
              {deleting ? 'Deleting…' : 'Delete'}
            </button>
          )}
          <button
            type="submit"
            disabled={saving || deleting}
            className="inline-flex items-center gap-1.5 rounded-md bg-foreground px-4 py-2 text-sm font-medium text-background hover:bg-foreground/90 disabled:opacity-50"
          >
            <Save className="h-4 w-4" />
            {saving ? 'Saving…' : mode === 'create' ? 'Submit report' : 'Save changes'}
          </button>
        </div>
      </div>
    </form>
  )
}

function Section({
  title,
  icon: Icon,
  children,
}: {
  title: string
  icon?: React.ComponentType<{ className?: string }>
  children: React.ReactNode
}) {
  return (
    <section className="rounded-xl border border-border bg-card p-5 border-border bg-card">
      <h3 className="mb-3 flex items-center gap-1.5 text-sm font-semibold text-foreground/85 text-foreground">
        {Icon && <Icon className="h-4 w-4 text-primary" />}
        {title}
      </h3>
      {children}
    </section>
  )
}

function NumberField({
  label,
  icon: Icon,
  value,
  onChange,
  hint,
}: {
  label: string
  icon: React.ComponentType<{ className?: string }>
  value: string
  onChange: (v: string) => void
  hint: string
}) {
  return (
    <label className="block">
      <span className="mb-1 flex items-center gap-1.5 text-xs font-medium text-muted-foreground text-foreground/85">
        <Icon className="h-3.5 w-3.5 text-primary" />
        {label}
      </span>
      <input
        type="number"
        inputMode="numeric"
        min={0}
        step={1}
        placeholder="0"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full rounded-md border border-border bg-card px-3 py-2 text-sm tabular-nums focus:border-primary/50 focus:outline-none border-border bg-background"
      />
      <span className="mt-1 block text-[10px] text-muted-foreground/70">{hint}</span>
    </label>
  )
}
