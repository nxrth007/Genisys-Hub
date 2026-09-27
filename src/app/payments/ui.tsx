'use client'

import { useState } from 'react'
import { Loader2, AlertCircle, Check, Copy } from 'lucide-react'
import { cn } from '@/lib/utils'

/**
 * Shared formatting + presentational pieces for the Payments tabs.
 * Lives in its own module so the Stripe, Mercury and NCT tabs can all
 * import it without a circular dependency.
 */

export function money(amount: number, currency = 'usd'): string {
  try {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: currency.toUpperCase(),
    }).format(amount)
  } catch {
    return `$${amount.toFixed(2)}`
  }
}

/** Stripe/our amounts are in the smallest currency unit (cents). */
export function cents(amount: number, currency = 'usd'): string {
  return money(amount / 100, currency)
}

export function fromUnix(sec: number): string {
  return new Date(sec * 1000).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
}

export function fromIso(iso: string | null): string {
  if (!iso) return '—'
  const d = new Date(iso)
  return isNaN(d.getTime())
    ? '—'
    : d.toLocaleString('en-US', {
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
      })
}

export function StatCard({
  label,
  value,
  sub,
  tone,
}: {
  label: string
  value: string
  sub?: string
  tone?: 'default' | 'good' | 'bad'
}) {
  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <p className="eyebrow text-muted-foreground">
        {label}
      </p>
      <p
        className={cn(
          'mt-1 text-2xl font-bold tabular-nums',
          tone === 'good'
            ? 'text-success'
            : tone === 'bad'
              ? 'text-destructive'
              : 'text-foreground',
        )}
      >
        {value}
      </p>
      {sub && <p className="mt-0.5 text-xs text-muted-foreground">{sub}</p>}
    </div>
  )
}

export function StatusPill({ status }: { status: string | null }) {
  const s = (status || '').toLowerCase()
  const tone =
    s.includes('succeed') ||
    s === 'paid' ||
    s === 'sent' ||
    s === 'posted' ||
    s === 'charged' ||
    s === 'ok'
      ? 'bg-success/15 text-success bg-success/15 text-success'
      : s.includes('pending') || s.includes('progress') || s === 'capped'
        ? 'bg-warning/15 text-warning bg-warning/15 text-warning'
        : s.includes('fail') || s.includes('cancel')
          ? 'bg-destructive/10 text-destructive bg-destructive/10 text-destructive'
          : 'bg-muted text-muted-foreground bg-surface-muted text-muted-foreground'
  return (
    <span
      className={cn(
        'inline-block rounded-lg px-2 py-0.5 eyebrow',
        tone,
      )}
    >
      {(status || '—').replace(/_/g, ' ')}
    </span>
  )
}

export function LoadingBlock() {
  return (
    <div className="flex h-40 items-center justify-center text-muted-foreground">
      <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Loading…
    </div>
  )
}

export function ErrorBlock({ message }: { message: string }) {
  return (
    <div className="flex items-start gap-2 rounded-xl border border-destructive/30 bg-destructive/10 p-4 text-sm text-destructive border-destructive/30 bg-destructive/10 text-destructive">
      <AlertCircle className="mt-0.5 h-4 w-4 flex-shrink-0" />
      <span>{message}</span>
    </div>
  )
}

/** Tiny copy-to-clipboard button with a "Copied" flash. */
export function CopyButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <button
      type="button"
      onClick={() => {
        navigator.clipboard.writeText(value)
        setCopied(true)
        setTimeout(() => setCopied(false), 1500)
      }}
      className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-[11px] font-medium text-muted-foreground transition hover:bg-muted hover:text-foreground"
    >
      {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
      {copied ? 'Copied' : label}
    </button>
  )
}

/** Shared input styling for the Payments forms. */
export const fieldClass =
  'w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/40'
