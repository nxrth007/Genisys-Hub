'use client'

import { useEffect, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Loader2, X } from 'lucide-react'
import { cn } from '@/lib/utils'

/**
 * Edit the operational fields on a client — the things the agency
 * manages, as opposed to the answers the client gave on the onboarding
 * form (those stay read-only on the detail dialog as submitted).
 */

export const LIFECYCLES = [
  { id: 'onboarding', label: 'Onboarding' },
  { id: 'active', label: 'Active' },
  { id: 'paused', label: 'Paused' },
  { id: 'churned', label: 'Churned' },
] as const
export type Lifecycle = (typeof LIFECYCLES)[number]['id']

export type ClientEditValues = {
  id: string
  name: string
  lifecycle: string
  contactName: string
  contactEmail: string
  contactPhone: string
  address: string
  website: string
  siteUrl: string
  notes: string
}

const FIELDS: Array<{
  key: keyof Omit<ClientEditValues, 'id' | 'lifecycle' | 'notes'>
  label: string
  placeholder?: string
  type?: string
}> = [
  { key: 'name', label: 'Business name' },
  { key: 'contactName', label: 'Contact name' },
  { key: 'contactEmail', label: 'Contact email', type: 'email' },
  { key: 'contactPhone', label: 'Contact phone', type: 'tel' },
  { key: 'address', label: 'Address' },
  { key: 'website', label: 'Their existing website', placeholder: 'as given on the form' },
  { key: 'siteUrl', label: 'Site we built (live URL)', placeholder: 'https://…' },
]

export function ClientEditDialog({
  initial,
  onClose,
}: {
  initial: ClientEditValues | null
  onClose: () => void
}) {
  const qc = useQueryClient()
  // Mounted fresh per client (keyed by the parent), so the form is
  // seeded once from `initial` and never needs re-syncing.
  const [values, setValues] = useState<ClientEditValues | null>(initial)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!initial) return
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [initial, onClose])

  const save = useMutation({
    mutationFn: async (v: ClientEditValues) => {
      const res = await fetch(`/api/clients/${v.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: v.name,
          lifecycle: v.lifecycle,
          contactName: v.contactName,
          contactEmail: v.contactEmail,
          contactPhone: v.contactPhone,
          address: v.address,
          website: v.website,
          siteUrl: v.siteUrl,
          notes: v.notes,
        }),
      })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        throw new Error(data.error || 'Failed to save')
      }
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['clients-roster'] })
      qc.invalidateQueries({ queryKey: ['clients'] })
      // Address and site edits move a dot or fire an arc on the Home globe.
      qc.invalidateQueries({ queryKey: ['home-globe'] })
      onClose()
    },
    onError: (e: Error) => setError(e.message),
  })

  if (!initial || !values) return null
  const v = values
  const set = (key: keyof ClientEditValues, value: string) =>
    setValues((cur) => (cur ? { ...cur, [key]: value } : cur))

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/60 p-4 pt-[8vh] backdrop-blur-sm">
      <form
        onSubmit={(e) => {
          e.preventDefault()
          if (!v.name.trim()) {
            setError('Business name is required.')
            return
          }
          save.mutate(v)
        }}
        className="flex w-full max-w-xl flex-col gap-5 rounded-xl border border-border bg-popover p-6 text-popover-foreground shadow-pop"
      >
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="eyebrow text-muted-foreground">Edit client</p>
            <h2 className="mt-1 text-lg font-semibold tracking-tight">{initial.name}</h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="grid h-7 w-7 place-items-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          {FIELDS.map((f) => (
            <label key={f.key} className={cn('flex flex-col gap-1.5', (f.key === 'address' || f.key === 'siteUrl') && 'sm:col-span-2')}>
              <span className="eyebrow text-muted-foreground">{f.label}</span>
              <input
                type={f.type ?? 'text'}
                value={v[f.key]}
                onChange={(e) => set(f.key, e.target.value)}
                placeholder={f.placeholder}
                className="h-9 rounded-md border border-border bg-surface px-3 text-[13px] outline-none transition focus:border-foreground/30 focus:ring-1 focus:ring-foreground/15 placeholder:text-muted-foreground/60"
              />
            </label>
          ))}

          <label className="flex flex-col gap-1.5">
            <span className="eyebrow text-muted-foreground">Status</span>
            <select
              value={v.lifecycle}
              onChange={(e) => set('lifecycle', e.target.value)}
              className="h-9 rounded-md border border-border bg-surface px-3 text-[13px] outline-none focus:border-foreground/30"
            >
              {LIFECYCLES.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.label}
                </option>
              ))}
              {!LIFECYCLES.some((l) => l.id === v.lifecycle) && (
                <option value={v.lifecycle}>{v.lifecycle}</option>
              )}
            </select>
          </label>

          <label className="flex flex-col gap-1.5 sm:col-span-2">
            <span className="eyebrow text-muted-foreground">Internal notes</span>
            <textarea
              value={v.notes}
              onChange={(e) => set('notes', e.target.value)}
              rows={4}
              className="rounded-md border border-border bg-surface px-3 py-2 text-[13px] outline-none transition focus:border-foreground/30 focus:ring-1 focus:ring-foreground/15"
            />
          </label>
        </div>

        {error && <p className="text-sm text-destructive">{error}</p>}

        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={save.isPending}
            className="rounded-lg px-3 py-2 text-[13px] font-medium text-muted-foreground hover:bg-muted disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={save.isPending}
            className="inline-flex items-center gap-1.5 rounded-lg bg-foreground px-3.5 py-2 text-[13px] font-medium text-background transition hover:bg-foreground/90 disabled:opacity-50"
          >
            {save.isPending && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            Save
          </button>
        </div>
      </form>
    </div>
  )
}
