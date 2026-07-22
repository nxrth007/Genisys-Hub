'use client'

import { useState } from 'react'
import {
  AlertCircle,
  Mail,
  Pause,
  Phone,
  Play,
  Plus,
  Trash2,
  X,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import {
  cents,
  ErrorBlock,
  fieldClass,
  fromIso,
  LoadingBlock,
  StatCard,
} from './ui'
import {
  useNctAction,
  useNctOverview,
  type Notice,
  type RoofingClient,
} from './nct-shared'

/**
 * Payments → Roofing Clients.
 *
 * The roster for the NCT per-lead billing model. Deliberately separate
 * from the solar Clients page: these are a different relationship with
 * a different billing rhythm (charged per lead on delivery, not per
 * appointment on a fixed cycle), and nothing here is linked to the
 * Client records that drive appointments, dispatch, or reminders.
 */
export function RoofingClientsTab() {
  const [notice, setNotice] = useState<Notice>(null)
  const [editing, setEditing] = useState<Partial<RoofingClient> | null>(null)

  const { data, isLoading, isError, error } = useNctOverview()
  const action = useNctAction(setNotice)

  if (isLoading) return <LoadingBlock />
  if (isError || !data)
    return (
      <ErrorBlock
        message={error instanceof Error ? error.message : 'Failed to load.'}
      />
    )

  const clients = data.configs
  const active = clients.filter((c) => c.active)
  const paused = clients.filter((c) => !c.active)
  const lifetimeRevenue = clients.reduce(
    (s, c) => s + c.lifetimeRevenueCents,
    0,
  )
  const lifetimeMargin = clients.reduce(
    (s, c) => s + (c.lifetimeRevenueCents - c.lifetimeCostCents),
    0,
  )

  const save = (payload: Record<string, unknown>) => {
    action.mutate({ action: 'saveConfig', ...payload })
    setEditing(null)
  }

  return (
    <div className="space-y-6">
      {notice && (
        <div
          className={cn(
            'flex items-start gap-2 rounded-xl border p-3 text-sm',
            notice.tone === 'ok'
              ? 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-300'
              : 'border-rose-200 bg-rose-50 text-rose-700 dark:border-rose-900 dark:bg-rose-950/40 dark:text-rose-300',
          )}
        >
          <AlertCircle className="mt-0.5 h-4 w-4 flex-shrink-0" />
          <span className="flex-1">{notice.text}</span>
          <button type="button" onClick={() => setNotice(null)}>
            <X className="h-4 w-4 opacity-60 hover:opacity-100" />
          </button>
        </div>
      )}

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard
          label="Active clients"
          value={String(active.length)}
          sub={paused.length > 0 ? `${paused.length} paused` : undefined}
        />
        <StatCard
          label="Billed this week"
          value={cents(data.week.chargedCents)}
          sub={`${data.week.leadCount} lead${data.week.leadCount === 1 ? '' : 's'}`}
        />
        <StatCard
          label="Lifetime billed"
          value={cents(lifetimeRevenue)}
        />
        <StatCard
          label="Lifetime margin"
          value={cents(lifetimeMargin)}
          tone={lifetimeMargin >= 0 ? 'good' : 'bad'}
        />
      </div>

      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-sm font-semibold text-foreground">
            Roofing clients
          </h3>
          <p className="text-xs text-muted-foreground">
            Per-lead billing via NCT Media. Separate from the solar Clients
            page — these are billed on delivery, not per appointment.
          </p>
        </div>
        <button
          type="button"
          onClick={() =>
            setEditing({
              pricePerLeadCents: 15000,
              costPerLeadCents: 11000,
              weeklyCapCents: 0,
              active: true,
            })
          }
          className="inline-flex flex-shrink-0 items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground transition hover:opacity-90"
        >
          <Plus className="h-4 w-4" />
          Add client
        </button>
      </div>

      {editing && (
        <ClientForm
          initial={editing}
          busy={action.isPending}
          onCancel={() => setEditing(null)}
          onSave={save}
        />
      )}

      {clients.length === 0 && !editing ? (
        <p className="rounded-xl border border-dashed border-border p-8 text-center text-sm text-muted-foreground">
          No roofing clients yet. Add one to start billing NCT leads — until
          then, incoming leads are recorded but never charged.
        </p>
      ) : (
        <div className="space-y-3">
          {[...active, ...paused].map((c) => (
            <ClientCard
              key={c.id}
              client={c}
              busy={action.isPending}
              onEdit={() => setEditing(c)}
              onToggle={() =>
                action.mutate({
                  action: 'saveConfig',
                  ...c,
                  active: !c.active,
                })
              }
              onDelete={() => {
                if (
                  !window.confirm(
                    `Remove ${c.clientName}? Leads already billed stay in the ledger, and their card is never touched again.`,
                  )
                )
                  return
                action.mutate({ action: 'deleteConfig', id: c.id })
              }}
            />
          ))}
        </div>
      )}
    </div>
  )
}

/* -------------------------------------------------------------------------- */

function ClientCard({
  client: c,
  busy,
  onEdit,
  onToggle,
  onDelete,
}: {
  client: RoofingClient
  busy: boolean
  onEdit: () => void
  onToggle: () => void
  onDelete: () => void
}) {
  const pct =
    c.weeklyCapCents > 0
      ? Math.min(100, (c.weekSpentCents / c.weeklyCapCents) * 100)
      : 0
  const margin = c.lifetimeRevenueCents - c.lifetimeCostCents
  const remaining = c.weeklyCapCents - c.weekSpentCents
  const leadsLeft =
    c.weeklyCapCents > 0 && c.pricePerLeadCents > 0
      ? Math.max(0, Math.floor(remaining / c.pricePerLeadCents))
      : null

  return (
    <div
      className={cn(
        'rounded-2xl border bg-card p-4',
        c.active ? 'border-border' : 'border-dashed border-border opacity-70',
      )}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <p className="font-semibold text-foreground">{c.clientName}</p>
            <span
              className={cn(
                'rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide',
                c.active
                  ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300'
                  : 'bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400',
              )}
            >
              {c.active ? 'Active' : 'Paused'}
            </span>
          </div>

          {(c.contactName || c.contactEmail || c.contactPhone) && (
            <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
              {c.contactName && <span>{c.contactName}</span>}
              {c.contactEmail && (
                <span className="inline-flex items-center gap-1">
                  <Mail className="h-3 w-3" />
                  {c.contactEmail}
                </span>
              )}
              {c.contactPhone && (
                <span className="inline-flex items-center gap-1">
                  <Phone className="h-3 w-3" />
                  {c.contactPhone}
                </span>
              )}
            </div>
          )}

          <p className="mt-1 font-mono text-[11px] text-muted-foreground">
            {c.sourceKey}
            {c.stripeCustomerId ? ` · ${c.stripeCustomerId}` : ''}
          </p>
          {!c.stripeCustomerId && (
            <p className="mt-1 inline-flex items-center gap-1 rounded-md bg-amber-100 px-2 py-0.5 text-[11px] font-medium text-amber-800 dark:bg-amber-950 dark:text-amber-300">
              <AlertCircle className="h-3 w-3" />
              No Stripe customer ID yet — leads will be held, not charged
            </p>
          )}
        </div>

        <div className="flex flex-shrink-0 gap-1">
          <button
            type="button"
            onClick={onEdit}
            className="rounded-md border border-border px-2 py-1 text-[11px] font-medium text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            Edit
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={onToggle}
            className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-[11px] font-medium text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-40"
          >
            {c.active ? (
              <Pause className="h-3 w-3" />
            ) : (
              <Play className="h-3 w-3" />
            )}
            {c.active ? 'Pause' : 'Activate'}
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={onDelete}
            className="rounded-md border border-rose-200 px-2 py-1 text-rose-600 hover:bg-rose-50 disabled:opacity-40 dark:border-rose-900 dark:text-rose-400 dark:hover:bg-rose-950/40"
          >
            <Trash2 className="h-3 w-3" />
          </button>
        </div>
      </div>

      {/* Pricing + lifetime */}
      <div className="mt-3 grid grid-cols-2 gap-3 border-t border-border pt-3 text-sm sm:grid-cols-4">
        <div>
          <p className="text-[11px] uppercase tracking-wide text-muted-foreground">
            Per lead
          </p>
          <p className="font-medium tabular-nums text-foreground">
            {cents(c.pricePerLeadCents)}
          </p>
          <p className="text-[11px] text-muted-foreground">
            costs {cents(c.costPerLeadCents)}
          </p>
        </div>
        <div>
          <p className="text-[11px] uppercase tracking-wide text-muted-foreground">
            Leads billed
          </p>
          <p className="font-medium tabular-nums text-foreground">
            {c.lifetimeLeadCount}
          </p>
          <p className="text-[11px] text-muted-foreground">
            {c.lastLeadAt ? `last ${fromIso(c.lastLeadAt)}` : 'none yet'}
          </p>
        </div>
        <div>
          <p className="text-[11px] uppercase tracking-wide text-muted-foreground">
            Lifetime billed
          </p>
          <p className="font-medium tabular-nums text-foreground">
            {cents(c.lifetimeRevenueCents)}
          </p>
        </div>
        <div>
          <p className="text-[11px] uppercase tracking-wide text-muted-foreground">
            Lifetime margin
          </p>
          <p
            className={cn(
              'font-medium tabular-nums',
              margin >= 0
                ? 'text-emerald-600 dark:text-emerald-400'
                : 'text-rose-600 dark:text-rose-400',
            )}
          >
            {cents(margin)}
          </p>
        </div>
      </div>

      {/* Weekly cap */}
      <div className="mt-3 border-t border-border pt-3">
        <div className="flex flex-wrap justify-between gap-2 text-xs">
          <span className="text-muted-foreground">
            This week · {c.weekLeadCount} lead
            {c.weekLeadCount === 1 ? '' : 's'}
          </span>
          <span className="font-medium tabular-nums text-foreground">
            {cents(c.weekSpentCents)}
            {c.weeklyCapCents > 0
              ? ` / ${cents(c.weeklyCapCents)} cap`
              : ' · no cap set'}
          </span>
        </div>
        {c.weeklyCapCents > 0 && (
          <>
            <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-muted">
              <div
                className={cn(
                  'h-full rounded-full transition-all',
                  pct >= 100
                    ? 'bg-rose-500'
                    : pct >= 80
                      ? 'bg-amber-500'
                      : 'bg-emerald-500',
                )}
                style={{ width: `${pct}%` }}
              />
            </div>
            <p className="mt-1 text-[11px] text-muted-foreground">
              {leadsLeft !== null && leadsLeft > 0
                ? `Room for ~${leadsLeft} more lead${leadsLeft === 1 ? '' : 's'} this week.`
                : 'Cap reached — further leads are held, not charged.'}
            </p>
          </>
        )}
      </div>

      {c.notes && (
        <p className="mt-3 whitespace-pre-wrap border-t border-border pt-3 text-xs text-muted-foreground">
          {c.notes}
        </p>
      )}
    </div>
  )
}

/* -------------------------------------------------------------------------- */

/**
 * Module-level, deliberately: a component defined inside ClientForm would
 * be a new type on every render, remounting each input and dropping focus
 * after a single keystroke.
 */
function Field({
  label,
  value,
  onChange,
  placeholder,
  hint,
  type = 'text',
}: {
  label: string
  value: string
  onChange: (v: string) => void
  placeholder?: string
  hint?: string
  type?: string
}) {
  return (
    <div>
      <label className="mb-1 block text-xs font-medium text-muted-foreground">
        {label}
      </label>
      <input
        className={fieldClass}
        type={type}
        step={type === 'number' ? '0.01' : undefined}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
      />
      {hint && <p className="mt-1 text-[11px] text-muted-foreground">{hint}</p>}
    </div>
  )
}

function ClientForm({
  initial,
  busy,
  onCancel,
  onSave,
}: {
  initial: Partial<RoofingClient>
  busy: boolean
  onCancel: () => void
  onSave: (payload: Record<string, unknown>) => void
}) {
  const [f, setF] = useState({
    clientName: initial.clientName ?? '',
    stripeCustomerId: initial.stripeCustomerId ?? '',
    sourceKey: initial.sourceKey ?? '',
    price: ((initial.pricePerLeadCents ?? 15000) / 100).toString(),
    cost: ((initial.costPerLeadCents ?? 11000) / 100).toString(),
    cap: ((initial.weeklyCapCents ?? 0) / 100).toString(),
    contactName: initial.contactName ?? '',
    contactEmail: initial.contactEmail ?? '',
    contactPhone: initial.contactPhone ?? '',
    notes: initial.notes ?? '',
    active: initial.active !== false,
  })
  const set = (k: keyof typeof f, v: string | boolean) =>
    setF((prev) => ({ ...prev, [k]: v }))

  // Stripe ID is optional at save time so a client can be entered before
  // their card-verification link is done — leads hold instead of charging.
  const valid = f.clientName.trim() && f.sourceKey.trim()

  return (
    <div className="rounded-2xl border border-border bg-card p-4">
      <div className="mb-3 flex items-center justify-between">
        <h4 className="text-sm font-semibold text-foreground">
          {initial.id ? `Edit ${initial.clientName}` : 'New roofing client'}
        </h4>
        <button type="button" onClick={onCancel}>
          <X className="h-4 w-4 text-muted-foreground hover:text-foreground" />
        </button>
      </div>

      <p className="mb-3 text-xs font-medium uppercase tracking-wide text-muted-foreground">
        Billing
      </p>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <Field
          label="Client name *"
          value={f.clientName}
          onChange={(v) => set('clientName', v)}
          placeholder="Forever Lit Solar LLC"
        />
        <Field
          label="Stripe customer ID"
          value={f.stripeCustomerId}
          onChange={(v) => set('stripeCustomerId', v)}
          placeholder="cus_XXXXXXXXXXXX"
          hint="Can be added later — until it's set, this client's leads are held instead of charged"
        />
        <Field
          label="Source key *"
          value={f.sourceKey}
          onChange={(v) => set('sourceKey', v)}
          placeholder="forever-lit"
          hint="What NCT sends to identify this client"
        />
        <Field
          label="We charge (per lead)"
          value={f.price}
          onChange={(v) => set('price', v)}
          type="number"
        />
        <Field
          label="NCT charges us"
          value={f.cost}
          onChange={(v) => set('cost', v)}
          type="number"
        />
        <Field
          label="Weekly cap"
          value={f.cap}
          onChange={(v) => set('cap', v)}
          type="number"
          hint="0 = uncapped. Leads over the cap are held, not charged."
        />
      </div>

      <p className="mb-3 mt-4 text-xs font-medium uppercase tracking-wide text-muted-foreground">
        Contact
      </p>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Field
          label="Contact name"
          value={f.contactName}
          onChange={(v) => set('contactName', v)}
          placeholder="Bethany Wiggins"
        />
        <Field
          label="Email"
          value={f.contactEmail}
          onChange={(v) => set('contactEmail', v)}
          placeholder="bethany@example.com"
        />
        <Field
          label="Phone"
          value={f.contactPhone}
          onChange={(v) => set('contactPhone', v)}
          placeholder="555-123-4567"
        />
      </div>

      <div className="mt-3">
        <label className="mb-1 block text-xs font-medium text-muted-foreground">
          Notes
        </label>
        <textarea
          className={cn(fieldClass, 'min-h-[70px] resize-y')}
          value={f.notes}
          onChange={(e) => set('notes', e.target.value)}
          placeholder="Billing quirks, budget conversations, anything worth remembering"
        />
      </div>

      <label className="mt-3 flex items-center gap-2 text-sm text-foreground">
        <input
          type="checkbox"
          checked={f.active}
          onChange={(e) => set('active', e.target.checked)}
          className="h-4 w-4 rounded border-border"
        />
        Active — leads for this source key get charged
      </label>

      <div className="mt-4">
        <button
          type="button"
          disabled={!valid || busy}
          onClick={() =>
            onSave({
              id: initial.id,
              clientName: f.clientName.trim(),
              stripeCustomerId: f.stripeCustomerId.trim(),
              sourceKey: f.sourceKey.trim(),
              pricePerLeadCents: Math.round(parseFloat(f.price || '0') * 100),
              costPerLeadCents: Math.round(parseFloat(f.cost || '0') * 100),
              weeklyCapCents: Math.round(parseFloat(f.cap || '0') * 100),
              contactName: f.contactName.trim(),
              contactEmail: f.contactEmail.trim(),
              contactPhone: f.contactPhone.trim(),
              notes: f.notes.trim(),
              active: f.active,
            })
          }
          className="rounded-lg bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground transition hover:opacity-90 disabled:opacity-40"
        >
          Save client
        </button>
      </div>
    </div>
  )
}
