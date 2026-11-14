'use client'

import { useEffect, useRef, useState } from 'react'
import { Loader2, X } from 'lucide-react'

/**
 * "Are you sure?" for a folder button that spends money (a domain, a number, a build): what it
 * costs and what happens, then the press. `onConfirm` resolves to null when it worked (the dialog
 * closes) or to what went wrong (shown here, the dialog stays open).
 */
export function ConfirmDialog({
  open,
  title,
  children,
  confirmLabel,
  disabled = false,
  onConfirm,
  onClose,
}: {
  open: boolean
  title: string
  children: React.ReactNode
  confirmLabel: string
  /** Nothing to press yet (still loading what it would use, or something stops it). */
  disabled?: boolean
  onConfirm: () => Promise<string | null>
  onClose: () => void
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const cancelRef = useRef<HTMLButtonElement>(null)
  const closeCb = useRef(onClose)
  closeCb.current = onClose
  const busyRef = useRef(false)
  busyRef.current = busy

  useEffect(() => {
    if (!open) return
    setError(null)
    cancelRef.current?.focus()
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && !busyRef.current && closeCb.current()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open])

  if (!open) return null

  async function confirm() {
    setBusy(true)
    setError(null)
    try {
      const problem = await onConfirm()
      if (problem) setError(problem)
      else onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/70 p-4 pt-[12vh] backdrop-blur-sm" onMouseDown={() => !busy && onClose()}>
      <div role="dialog" aria-modal="true" aria-label={title} className="w-full max-w-md rounded-xl border border-border bg-popover shadow-pop" onMouseDown={(e) => e.stopPropagation()}>
        <div className="flex items-start justify-between gap-4 px-5 pt-4">
          <h2 className="text-[15px] font-semibold text-foreground">{title}</h2>
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="grid h-8 w-8 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-40"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="flex flex-col gap-2.5 px-5 py-3 text-[13px] leading-snug text-foreground/90">{children}</div>
        {error && <p className="mx-5 mb-3 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-[12.5px] leading-snug text-foreground">{error}</p>}
        <div className="flex justify-end gap-2 border-t border-border px-5 py-3">
          <button
            ref={cancelRef}
            type="button"
            onClick={onClose}
            disabled={busy}
            className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-card px-3 py-1.5 text-[12.5px] font-medium text-foreground transition hover:bg-muted disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={confirm}
            disabled={busy || disabled}
            className="inline-flex items-center gap-1.5 rounded-lg border border-foreground/20 bg-foreground px-3 py-1.5 text-[12.5px] font-medium text-background transition hover:opacity-90 disabled:opacity-50"
          >
            {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />} {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}

/** POST JSON to one of the client's routes: its answer when it worked, otherwise what went wrong (in Hub words). */
export async function postAction(url: string, body: Record<string, unknown>): Promise<{ ok: true; data: Record<string, unknown> } | { ok: false; reason: string }> {
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>
  if (res.ok && data.ok !== false) return { ok: true, data }
  const reason = (typeof data.reason === 'string' && data.reason) || (typeof data.error === 'string' && data.error) || `The Hub answered HTTP ${res.status}.`
  return { ok: false, reason }
}
