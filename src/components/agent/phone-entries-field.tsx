'use client'

import { useEffect, useMemo, useState } from 'react'
import { Plus, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { formatPhoneInput, parsePhoneEntries } from '@/lib/phone'

/**
 * Structured phone-numbers editor for the booking form. Mary's
 * common case is one number per row, but customers regularly hand
 * over both a Mobile and a Home line — this component lets her
 * label each entry instead of mashing them into a free-text field
 * and hoping the parser figures it out.
 *
 * Storage stays a single string on `Appointment.customerPhone` to
 * avoid a schema migration AND to keep the existing display path
 * (Master Tracker uses parsePhoneEntries already) and reminder
 * dispatch (primaryPhoneFor) working with the same data shape.
 *
 * Round-trip:
 *   string ↔ Array<{ number, label }>
 *
 * Empty rows in state get filtered out before serialization, so the
 * stored value stays clean ("(555) 111 Mobile\n(555) 222 Home") and
 * a half-typed row doesn't poison the SMS dispatch.
 */

const LABEL_OPTIONS = ['Mobile', 'Home', 'Work', 'Other'] as const
type LabelOption = (typeof LABEL_OPTIONS)[number] | ''

type Row = {
  number: string
  label: LabelOption
}

function emptyRow(): Row {
  return { number: '', label: '' }
}

function rowsToString(rows: Row[]): string {
  return rows
    .filter((r) => r.number.trim())
    .map((r) =>
      r.label ? `${r.number} ${r.label}` : r.number
    )
    .join('\n')
}

function stringToRows(raw: string): Row[] {
  if (!raw?.trim()) return [emptyRow()]
  const parsed = parsePhoneEntries(raw)
  if (parsed.entries.length === 0) {
    // Couldn't parse anything — preserve the raw text as-is so the
    // user can see and fix what they had.
    return [{ number: raw.trim(), label: '' }]
  }
  return parsed.entries.map((e) => ({
    number: e.number,
    label: (e.label && (LABEL_OPTIONS as readonly string[]).includes(e.label)
      ? (e.label as LabelOption)
      : '') as LabelOption,
  }))
}

export function PhoneEntriesField({
  value,
  onChange,
  required,
  disabled,
  inputClassName,
}: {
  value: string
  onChange: (combined: string) => void
  required?: boolean
  disabled?: boolean
  inputClassName?: string
}) {
  // Hydrate once from props — subsequent edits are local-state-driven
  // so each keystroke doesn't re-parse the prop and stomp on cursor
  // position. The string-form prop only round-trips back through
  // onChange, never back into local state.
  const [rows, setRows] = useState<Row[]>(() => stringToRows(value))

  // If the parent resets the field externally (e.g. the form's reset
  // button), re-hydrate. Done by string-comparing the serialized
  // local state against the prop — if they differ AND the prop is
  // empty, we treat it as an external reset.
  const localCombined = useMemo(() => rowsToString(rows), [rows])
  useEffect(() => {
    if (value === '' && localCombined !== '') {
      setRows([emptyRow()])
    }
    // We deliberately don't sync prop→state on every prop change;
    // see the comment above. localCombined dependency is intentional
    // so the effect only checks after an actual local commit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value])

  function emit(next: Row[]) {
    setRows(next)
    onChange(rowsToString(next))
  }

  function updateRow(idx: number, patch: Partial<Row>) {
    const next = rows.map((r, i) => (i === idx ? { ...r, ...patch } : r))
    emit(next)
  }

  function addRow() {
    emit([...rows, emptyRow()])
  }

  function removeRow(idx: number) {
    const next = rows.filter((_, i) => i !== idx)
    emit(next.length > 0 ? next : [emptyRow()])
  }

  return (
    <div className="flex flex-col gap-2">
      {rows.map((row, idx) => (
        <div key={idx} className="flex items-center gap-2">
          <input
            type="tel"
            value={row.number}
            onChange={(e) =>
              updateRow(idx, { number: formatPhoneInput(e.target.value) })
            }
            placeholder="(555) 123-4567"
            autoComplete="tel"
            // Only the FIRST row carries the HTML5 `required` flag —
            // additional rows are intentionally optional, since the
            // common case is "1 number, sometimes 2" and we don't
            // want to block submit just because Mary added a Home
            // row and then thought better of it.
            required={required && idx === 0}
            disabled={disabled}
            className={cn('flex-1', inputClassName)}
          />
          <select
            value={row.label}
            onChange={(e) =>
              updateRow(idx, { label: e.target.value as LabelOption })
            }
            disabled={disabled}
            className={cn(
              'rounded-md border border-zinc-200 bg-white px-2 py-2 text-sm focus:border-blue-500 focus:outline-none disabled:opacity-50 dark:border-zinc-700 dark:bg-zinc-900',
              'flex-shrink-0'
            )}
            aria-label="Phone label"
          >
            <option value="">— No label —</option>
            {LABEL_OPTIONS.map((opt) => (
              <option key={opt} value={opt}>
                {opt}
              </option>
            ))}
          </select>
          {rows.length > 1 && (
            <button
              type="button"
              onClick={() => removeRow(idx)}
              disabled={disabled}
              className="rounded-md p-2 text-zinc-400 transition hover:bg-rose-50 hover:text-rose-600 disabled:opacity-50 dark:hover:bg-rose-950/40"
              aria-label="Remove this phone number"
              title="Remove"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
      ))}
      <button
        type="button"
        onClick={addRow}
        disabled={disabled || rows.length >= 4}
        className="inline-flex w-fit items-center gap-1 rounded-md border border-dashed border-zinc-300 px-2 py-1 text-[11px] font-medium text-zinc-600 transition hover:border-blue-400 hover:bg-blue-50 hover:text-blue-700 disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-400 dark:hover:bg-blue-950/30"
      >
        <Plus className="h-3 w-3" />
        Add another phone
      </button>
      {rows.length > 1 && (
        <p className="text-[10px] text-zinc-500">
          The first <em>Mobile</em> entry (or the first number, if
          unlabeled) gets the SMS reminder. Other numbers are stored
          for reference only.
        </p>
      )}
    </div>
  )
}
