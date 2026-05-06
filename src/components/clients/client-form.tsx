'use client'

import { useEffect, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { X, Mail, Phone as PhoneIcon, MapPin, FileText, Link2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { formatPhoneInput } from '@/lib/phone'

/**
 * Shared create + edit form for the Clients tab. Handles both modes
 * via a single `mode` prop:
 *   - mode="create": POST /api/clients
 *   - mode="edit":   PATCH /api/clients/:id (sends only changed fields)
 *
 * Built as a self-contained modal so the parent only needs to manage
 * `open` + an optional `initial` payload. Cache invalidation hits the
 * with-counts query (the table) and the basic clients query (booking
 * pickers + search dialog) so a save propagates everywhere.
 */

export type ClientLifecycle = 'active' | 'onboarding' | 'paused' | 'churned'

export type ClientPackage = 'ppa' | 'growth' | 'pro' | 'custom'

export type ClientFormValues = {
  id?: string
  name: string
  state: string
  color: string
  lifecycle: ClientLifecycle
  package: ClientPackage
  /** Stored as a string so the input field stays controlled even
   *  when blank. Empty string = no cap (unlimited). */
  apptCap: string
  contactName: string
  contactRole: string
  contactEmail: string
  contactPhone: string
  address: string
  notes: string
  intakeFormUrl: string
  ghlSubaccountUrl: string
}

const EMPTY: ClientFormValues = {
  name: '',
  state: '',
  color: '#0ea5e9',
  lifecycle: 'active',
  package: 'custom',
  apptCap: '',
  contactName: '',
  contactRole: '',
  contactEmail: '',
  contactPhone: '',
  address: '',
  notes: '',
  intakeFormUrl: '',
  ghlSubaccountUrl: '',
}

const COLOR_PRESETS = [
  { name: 'Brighton amber', value: '#f59e0b' },
  { name: 'Spring emerald', value: '#10b981' },
  { name: 'Energy Upgrade sky', value: '#0ea5e9' },
  { name: 'Violet', value: '#8b5cf6' },
  { name: 'Rose', value: '#f43f5e' },
  { name: 'Slate', value: '#64748b' },
]

export const LIFECYCLE_OPTIONS: ReadonlyArray<{
  id: ClientLifecycle
  label: string
  hint: string
}> = [
  { id: 'active', label: 'Active', hint: 'Engaged + receiving bookings' },
  { id: 'onboarding', label: 'Onboarding', hint: 'In setup, not booking yet' },
  { id: 'paused', label: 'Paused', hint: 'Temporarily on hold' },
  { id: 'churned', label: 'Churned', hint: 'Relationship ended' },
]

/**
 * Package tiers — drives default appt caps. Picking a tier auto-
 * fills the cap input; admins can still override the number for
 * sit-down-guarantee deals or any bespoke arrangement.
 */
export const PACKAGE_OPTIONS: ReadonlyArray<{
  id: ClientPackage
  label: string
  /** Default cap when this tier is selected. null = unlimited. */
  defaultCap: number | null
  hint: string
}> = [
  { id: 'ppa', label: 'PPA', defaultCap: null, hint: 'Pay per appointment — no cap' },
  { id: 'growth', label: 'Growth', defaultCap: 20, hint: '20 appointments / period' },
  { id: 'pro', label: 'Pro', defaultCap: 30, hint: '30 appointments / period' },
  { id: 'custom', label: 'Custom', defaultCap: null, hint: 'Bespoke deal — set cap manually' },
]

export function ClientFormDialog({
  open,
  onOpenChange,
  mode,
  initial,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  mode: 'create' | 'edit'
  /** For edit mode — pre-fills the form. Ignored in create mode. */
  initial?: Partial<ClientFormValues> & { id?: string }
}) {
  const qc = useQueryClient()
  const [values, setValues] = useState<ClientFormValues>({
    ...EMPTY,
    ...(initial ?? {}),
  })
  const [error, setError] = useState<string | null>(null)

  // Re-hydrate when the dialog opens with a different `initial`
  // payload — important for the edit flow so reopening with another
  // client shows that client's data, not the previous one's.
  useEffect(() => {
    if (open) {
      setValues({ ...EMPTY, ...(initial ?? {}) })
      setError(null)
    }
  }, [open, initial])

  // Esc closes — same convention as our other modals.
  useEffect(() => {
    if (!open) return
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onOpenChange(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onOpenChange])

  function set<K extends keyof ClientFormValues>(
    key: K,
    val: ClientFormValues[K]
  ) {
    setValues((v) => ({ ...v, [key]: val }))
  }

  const mutation = useMutation({
    mutationFn: async () => {
      const url =
        mode === 'edit' && initial?.id
          ? `/api/clients/${initial.id}`
          : '/api/clients'
      const method = mode === 'edit' ? 'PATCH' : 'POST'
      const res = await fetch(url, {
        method,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(toApiPayload(values)),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        throw new Error(data.error || 'Save failed')
      }
      return data
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['clients-with-counts'] })
      qc.invalidateQueries({ queryKey: ['clients'] })
      onOpenChange(false)
    },
    onError: (err: Error) => setError(err.message),
  })

  function submit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    if (!values.name.trim()) {
      setError('Client name is required.')
      return
    }
    mutation.mutate()
  }

  if (!open) return null

  return (
    // Backdrop is intentionally NOT click-to-close. Alex's complaint:
    // when text-selecting or click-dragging inside the form, releasing
    // outside the form would fire the backdrop's onClick (mousedown was
    // inside the form but click bubbled to the common ancestor) and
    // wipe the half-typed client info. Esc and the X button stay as
    // close affordances. The stopPropagation on the form was guarding
    // against in-form clicks but couldn't catch the drag-out case.
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-4 pt-[6vh] backdrop-blur-sm"
    >
      <form
        onSubmit={submit}
        className="flex w-full max-w-xl flex-col gap-5 rounded-2xl border border-border bg-popover p-6 text-popover-foreground shadow-pop"
      >
        <div className="flex items-start justify-between">
          <div>
            <h2 className="text-lg font-semibold">
              {mode === 'edit' ? 'Edit client' : 'New client'}
            </h2>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {mode === 'edit'
                ? 'Update contact, notes, status, or branding.'
                : 'Add a Genisys client. Only the name is required — fill the rest in as you have it.'}
            </p>
          </div>
          <button
            type="button"
            onClick={() => onOpenChange(false)}
            className="grid h-7 w-7 place-items-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* ---- Identity row ---- */}
        <Section title="Identity">
          <Row>
            <Field label="Business name" required full>
              <input
                type="text"
                value={values.name}
                onChange={(e) => set('name', e.target.value)}
                placeholder="Brighton Capital Solar"
                required
                autoFocus={mode === 'create'}
                className={inputCls}
              />
            </Field>
          </Row>
          <Row>
            <Field label="State">
              <input
                type="text"
                value={values.state}
                onChange={(e) => set('state', e.target.value)}
                placeholder="Arizona, California, Utah, …"
                list="state-suggestions"
                className={inputCls}
              />
              <datalist id="state-suggestions">
                <option value="Arizona" />
                <option value="California" />
                <option value="Utah" />
                <option value="Nevada" />
                <option value="Texas" />
                <option value="Colorado" />
                <option value="New Mexico" />
                <option value="Oregon" />
                <option value="Washington" />
                <option value="Florida" />
              </datalist>
            </Field>
            <Field label="Status">
              <select
                value={values.lifecycle}
                onChange={(e) => set('lifecycle', e.target.value as ClientLifecycle)}
                className={inputCls}
              >
                {LIFECYCLE_OPTIONS.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.label}
                  </option>
                ))}
              </select>
            </Field>
          </Row>
        </Section>

        {/* ---- Package / cap ----
            Pick a tier and the cap auto-fills (Growth → 20, Pro →
            30, PPA → blank/unlimited). Cap stays editable so a sit-
            down-guarantee deal can sit at the bespoke number — or
            be cleared entirely for "we keep delivering until they
            sit down". The hint under the cap input explains the
            unlimited-when-blank semantics. */}
        <Section title="Package">
          <Row>
            <Field label="Tier">
              <select
                value={values.package}
                onChange={(e) => {
                  const next = e.target.value as ClientPackage
                  const opt = PACKAGE_OPTIONS.find((o) => o.id === next)
                  setValues((v) => ({
                    ...v,
                    package: next,
                    // Only auto-set the cap when picking a preset tier;
                    // leave 'custom' alone so admins can keep their
                    // manually-typed number.
                    apptCap:
                      next === 'custom'
                        ? v.apptCap
                        : opt?.defaultCap == null
                          ? ''
                          : String(opt.defaultCap),
                  }))
                }}
                className={inputCls}
              >
                {PACKAGE_OPTIONS.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.label} — {o.hint}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Appointment cap">
              <input
                type="number"
                min={1}
                step={1}
                value={values.apptCap}
                onChange={(e) => set('apptCap', e.target.value)}
                placeholder="No cap"
                className={inputCls}
              />
              <span className="mt-1 text-[11px] text-muted-foreground">
                Leave blank for unlimited (PPA / sit-down guarantee).
                {values.package !== 'custom' &&
                  ` Default for ${
                    PACKAGE_OPTIONS.find((o) => o.id === values.package)
                      ?.label
                  } is ${
                    PACKAGE_OPTIONS.find((o) => o.id === values.package)
                      ?.defaultCap ?? 'unlimited'
                  }.`}
              </span>
            </Field>
          </Row>
        </Section>

        {/* ---- Primary contact ---- */}
        <Section title="Primary contact">
          <Row>
            <Field label="Contact name">
              <input
                type="text"
                value={values.contactName}
                onChange={(e) => set('contactName', e.target.value)}
                placeholder="David Mehta"
                className={inputCls}
              />
            </Field>
            <Field label="Role">
              <input
                type="text"
                value={values.contactRole}
                onChange={(e) => set('contactRole', e.target.value)}
                placeholder="VP Revenue"
                className={inputCls}
              />
            </Field>
          </Row>
          <Row>
            <Field label="Email" icon={Mail}>
              <input
                type="email"
                value={values.contactEmail}
                onChange={(e) => set('contactEmail', e.target.value)}
                placeholder="contact@example.com"
                autoComplete="email"
                className={inputCls}
              />
            </Field>
            <Field label="Phone" icon={PhoneIcon}>
              <input
                type="tel"
                value={values.contactPhone}
                onChange={(e) =>
                  set('contactPhone', formatPhoneInput(e.target.value))
                }
                placeholder="(555) 123-4567"
                autoComplete="tel"
                className={inputCls}
              />
            </Field>
          </Row>
          <Row>
            <Field label="Address" icon={MapPin} full>
              <input
                type="text"
                value={values.address}
                onChange={(e) => set('address', e.target.value)}
                placeholder="421 Brannan St, San Francisco, CA 94107"
                className={inputCls}
              />
            </Field>
          </Row>
        </Section>

        {/* ---- Notes + links ---- */}
        <Section title="Notes & resources">
          <Row>
            <Field label="Notes" icon={FileText} full>
              <textarea
                value={values.notes}
                onChange={(e) => set('notes', e.target.value)}
                placeholder="Anything the team should know — quirks, scripts they prefer, integrations, billing notes…"
                rows={3}
                className={cn(inputCls, 'min-h-[88px] resize-y')}
              />
            </Field>
          </Row>
          <Row>
            <Field label="Intake form URL" icon={Link2}>
              <input
                type="url"
                value={values.intakeFormUrl}
                onChange={(e) => set('intakeFormUrl', e.target.value)}
                placeholder="https://forms.genisys.io/n/…"
                className={inputCls}
              />
            </Field>
            <Field label="GoHighLevel sub-account" icon={Link2}>
              <input
                type="url"
                value={values.ghlSubaccountUrl}
                onChange={(e) => set('ghlSubaccountUrl', e.target.value)}
                placeholder="https://app.gohighlevel.com/v2/location/…"
                className={inputCls}
              />
            </Field>
          </Row>
        </Section>

        {/* ---- Brand color ---- */}
        <Section title="Brand color">
          <div className="flex flex-wrap items-center gap-2">
            {COLOR_PRESETS.map((p) => (
              <button
                key={p.value}
                type="button"
                onClick={() => set('color', p.value)}
                title={p.name}
                aria-label={p.name}
                className={cn(
                  'grid h-8 w-8 place-items-center rounded-full transition',
                  values.color === p.value
                    ? 'ring-2 ring-foreground ring-offset-2 ring-offset-popover'
                    : 'opacity-80 hover:opacity-100'
                )}
                style={{ backgroundColor: p.value }}
              >
                {values.color === p.value && (
                  <span className="h-1.5 w-1.5 rounded-full bg-white" />
                )}
              </button>
            ))}
            <input
              type="color"
              value={values.color}
              onChange={(e) => set('color', e.target.value)}
              className="ml-1 h-8 w-8 cursor-pointer rounded-full border border-border bg-card"
              title="Custom hex"
            />
          </div>
        </Section>

        {error && (
          <div className="rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700 dark:border-rose-900 dark:bg-rose-950/40 dark:text-rose-300">
            {error}
          </div>
        )}

        <div className="flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={() => onOpenChange(false)}
            className="rounded-full border border-border bg-card px-4 py-2 text-sm font-medium text-foreground/80 transition hover:bg-muted"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={mutation.isPending || !values.name.trim()}
            className="inline-flex items-center gap-2 rounded-full bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground transition hover:bg-primary/90 disabled:opacity-60"
          >
            {mutation.isPending
              ? mode === 'edit' ? 'Saving…' : 'Creating…'
              : mode === 'edit' ? 'Save changes' : 'Create client'}
          </button>
        </div>
      </form>
    </div>
  )
}

/* ---- Sub-components ---------------------------------------------------- */

const inputCls =
  'w-full rounded-xl border border-border bg-card px-3 py-2 text-sm focus:border-primary focus:outline-none disabled:opacity-50'

function Section({
  title,
  children,
}: {
  title: string
  children: React.ReactNode
}) {
  return (
    <div className="flex flex-col gap-2.5">
      <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
        {title}
      </p>
      <div className="flex flex-col gap-2.5">{children}</div>
    </div>
  )
}

function Row({ children }: { children: React.ReactNode }) {
  return <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">{children}</div>
}

function Field({
  label,
  required,
  full,
  icon: Icon,
  children,
}: {
  label: string
  required?: boolean
  /** Span both columns of the parent row. */
  full?: boolean
  icon?: React.ComponentType<{ className?: string }>
  children: React.ReactNode
}) {
  return (
    <label className={cn('flex flex-col gap-1.5', full && 'sm:col-span-2')}>
      <span className="flex items-center gap-1.5 text-xs font-semibold">
        {Icon && <Icon className="h-3.5 w-3.5 text-muted-foreground" />}
        {label}
        {required && <span className="text-destructive">*</span>}
      </span>
      {children}
    </label>
  )
}

/* ---- API payload shaping ----------------------------------------------- */

/** Trim and convert empty strings to null so the API treats blank
 *  fields as "clear this column" rather than "store an empty string." */
function toApiPayload(v: ClientFormValues) {
  const blank = (s: string) => (s.trim() ? s.trim() : null)
  // Cap parses as a positive integer or comes through as null. NaN
  // and non-positive numbers fall back to null too — we don't want
  // a typo turning into "0 appointments allowed".
  const capNum = Number.parseInt(v.apptCap.trim(), 10)
  const apptCap =
    Number.isFinite(capNum) && capNum > 0 ? capNum : null
  return {
    name: v.name.trim(),
    state: blank(v.state),
    color: v.color,
    lifecycle: v.lifecycle,
    package: v.package,
    apptCap,
    contactName: blank(v.contactName),
    contactRole: blank(v.contactRole),
    contactEmail: blank(v.contactEmail),
    contactPhone: blank(v.contactPhone),
    address: blank(v.address),
    notes: blank(v.notes),
    intakeFormUrl: blank(v.intakeFormUrl),
    ghlSubaccountUrl: blank(v.ghlSubaccountUrl),
  }
}
