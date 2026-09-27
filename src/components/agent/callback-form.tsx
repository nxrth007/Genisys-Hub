'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { ArrowLeft, Save, Trash2, AlertCircle } from 'lucide-react'

export type CallbackFormValues = {
  customerName: string
  customerPhone: string
  callbackAt: string // datetime-local value (YYYY-MM-DDTHH:mm)
  notes: string
  /** Optional vicidial recording URL pasted in from the dialer.
   *  Empty string = nothing to attach. Rendered as a "Listen"
   *  button on the row when present (signed via the shared
   *  recording proxy). */
  callRecordingLink: string
}

const EMPTY: CallbackFormValues = {
  customerName: '',
  customerPhone: '',
  callbackAt: '',
  notes: '',
  callRecordingLink: '',
}

/**
 * Default the callback time to tomorrow at 10 AM in the agent's browser
 * timezone — most callbacks are "call again tomorrow morning" and this saves
 * a few taps. Agent can always adjust.
 */
function defaultCallbackAt(): string {
  const d = new Date()
  d.setDate(d.getDate() + 1)
  d.setHours(10, 0, 0, 0)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(
    d.getHours()
  )}:${pad(d.getMinutes())}`
}

export function CallbackForm({
  mode,
  initial,
  callbackId,
  apiBase = '/api/agent/callbacks',
  pageBase = '/agent/callbacks',
}: {
  mode: 'create' | 'edit'
  initial?: Partial<CallbackFormValues>
  callbackId?: string
  /** API endpoint base. Defaults to Mary's agent path; Team #1
   *  pages pass '/api/team/callbacks' so the same form posts to
   *  the role-gated endpoint for them. Same pattern as
   *  EodReportForm. */
  apiBase?: string
  pageBase?: string
}) {
  const router = useRouter()
  const [values, setValues] = useState<CallbackFormValues>({
    ...EMPTY,
    callbackAt: mode === 'create' ? defaultCallbackAt() : '',
    ...initial,
  })
  const [saving, setSaving] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  function update<K extends keyof CallbackFormValues>(key: K, value: CallbackFormValues[K]) {
    setValues((v) => ({ ...v, [key]: value }))
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)

    const payload = {
      customerName: values.customerName,
      customerPhone: values.customerPhone,
      // datetime-local has no timezone — browser interprets it as local time.
      // Constructing with `new Date(value)` does exactly that, then toISOString
      // gives us UTC to store.
      callbackAt: new Date(values.callbackAt).toISOString(),
      notes: values.notes || null,
      callRecordingLink: values.callRecordingLink.trim() || null,
    }

    setSaving(true)
    try {
      const url =
        mode === 'create' ? apiBase : `${apiBase}/${callbackId}`
      const res = await fetch(url, {
        method: mode === 'create' ? 'POST' : 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Failed to save')
      router.push(pageBase)
      router.refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error')
    } finally {
      setSaving(false)
    }
  }

  async function onDelete() {
    if (!callbackId) return
    if (!confirm('Delete this callback?')) return
    setDeleting(true)
    setError(null)
    try {
      const res = await fetch(`${apiBase}/${callbackId}`, {
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

  return (
    <form onSubmit={onSubmit} className="mx-auto max-w-2xl space-y-4">
      <div>
        <Link
          href={pageBase}
          className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          Back to callbacks
        </Link>
        <h1 className="mt-2 text-2xl font-bold tracking-tight">
          {mode === 'create' ? 'New Callback' : 'Edit Callback'}
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Prospects who asked you to call them back. Schedule the follow-up
          and the Hub will surface it on your dashboard when it&apos;s due.
        </p>
      </div>

      {error && (
        <div className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive border-destructive/30 bg-destructive/10 text-destructive">
          <AlertCircle className="mt-0.5 h-4 w-4 flex-shrink-0" />
          <span>{error}</span>
        </div>
      )}

      <div className="rounded-xl border border-border bg-card p-5 border-border bg-card">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <label className="block sm:col-span-2">
            <span className="mb-1 block text-xs font-medium text-muted-foreground text-foreground/85">
              Customer name *
            </span>
            <input
              type="text"
              required
              value={values.customerName}
              onChange={(e) => update('customerName', e.target.value)}
              className="w-full rounded-md border border-border bg-card px-3 py-2 text-sm focus:border-primary/50 focus:outline-none border-border bg-background"
            />
          </label>

          <label className="block">
            <span className="mb-1 block text-xs font-medium text-muted-foreground text-foreground/85">
              Phone *
            </span>
            <input
              type="tel"
              required
              value={values.customerPhone}
              onChange={(e) => update('customerPhone', e.target.value)}
              placeholder="555-123-4567"
              className="w-full rounded-md border border-border bg-card px-3 py-2 text-sm focus:border-primary/50 focus:outline-none border-border bg-background"
            />
          </label>

          <label className="block">
            <span className="mb-1 block text-xs font-medium text-muted-foreground text-foreground/85">
              Call back on *
            </span>
            <input
              type="datetime-local"
              required
              value={values.callbackAt}
              onChange={(e) => update('callbackAt', e.target.value)}
              className="w-full rounded-md border border-border bg-card px-3 py-2 text-sm focus:border-primary/50 focus:outline-none border-border bg-background"
            />
          </label>

          <label className="block sm:col-span-2">
            <span className="mb-1 block text-xs font-medium text-muted-foreground text-foreground/85">
              Notes (optional)
            </span>
            <textarea
              value={values.notes}
              onChange={(e) => update('notes', e.target.value)}
              rows={3}
              placeholder="What did they say? Anything to remember for next time?"
              className="w-full rounded-md border border-border bg-card px-3 py-2 text-sm focus:border-primary/50 focus:outline-none border-border bg-background"
            />
          </label>

          <label className="block sm:col-span-2">
            <span className="mb-1 block text-xs font-medium text-muted-foreground text-foreground/85">
              Call recording link (optional)
            </span>
            <input
              type="url"
              value={values.callRecordingLink}
              onChange={(e) => update('callRecordingLink', e.target.value)}
              placeholder="Paste the vicidial recording URL if you want admin to listen"
              className="w-full rounded-md border border-border bg-card px-3 py-2 text-sm font-mono focus:border-primary/50 focus:outline-none border-border bg-background"
            />
            <span className="mt-1 block text-[10px] text-muted-foreground/70">
              Paste from the dialer. Leave blank to skip — most callbacks
              don&apos;t need this.
            </span>
          </label>
        </div>
      </div>

      <div className="sticky bottom-0 flex items-center justify-end gap-2 border-t border-border bg-card px-1 py-3 border-border bg-background">
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
          {saving ? 'Saving…' : mode === 'create' ? 'Save callback' : 'Save changes'}
        </button>
      </div>
    </form>
  )
}
