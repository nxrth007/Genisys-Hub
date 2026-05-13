/**
 * Audit trail for appointment edits. Captures who changed what on
 * existing appointments so admin can spot accidental status changes,
 * date moves, etc. without having to ask Mary or Ethan after the fact.
 *
 * Two write paths feed this:
 *   1. /api/agent/appointments/[id] PATCH — Hub agent form full edits
 *   2. /api/call-center/master-tracker/[rowNumber] PATCH — inline
 *      status / sent-to-client edits + the full-edit modal
 *
 * Read path: /api/admin/appointment-edits → "Appointment edits" tab
 * on /agents.
 *
 * Design notes:
 *   - We only log when SOMETHING actually changed. A save with no
 *     diff is a no-op; logging it would just be noise.
 *   - Field-level diff stored as JSON: { field: { from, to } }.
 *     Values are stringified for display so the log renders without
 *     having to re-derive type info per field.
 *   - Snapshot fields (editorEmail / customerName / etc.) are
 *     written at capture time so deleting the User or Appointment
 *     later doesn't erase the audit trail. The FK relations cascade
 *     / null appropriately, but the snapshot stays put.
 */
import { prisma } from './prisma'

export type EditSource = 'agent-form' | 'master-tracker'

export type FieldChange = { from: unknown; to: unknown }
export type ChangeMap = Record<string, FieldChange>

/** Compare two snapshots of an appointment and return only the keys
 *  whose values differ. Date / null / undefined are normalized so a
 *  silent same-value write (e.g. PATCH re-sends the existing status)
 *  doesn't generate a phantom log row. */
export function diffSnapshots<T extends Record<string, unknown>>(
  before: T,
  after: T,
  /** Keys to consider. Anything outside this set is ignored even if
   *  it appears in both snapshots — keeps the diff scoped to the
   *  fields admin actually wants in the audit log. */
  keys: ReadonlyArray<keyof T>,
): ChangeMap {
  const changes: ChangeMap = {}
  for (const k of keys) {
    const a = normalize(before[k])
    const b = normalize(after[k])
    if (a === b) continue
    changes[String(k)] = { from: before[k] ?? null, to: after[k] ?? null }
  }
  return changes
}

/** Normalize a value into a primitive for equality comparison.
 *  Dates serialize to ISO so two Date instances pointing at the same
 *  instant compare equal. Null / undefined collapse so "field was
 *  unset" and "field is still unset" don't differ. */
function normalize(v: unknown): string | null {
  if (v === null || v === undefined) return null
  if (v instanceof Date) return v.toISOString()
  if (typeof v === 'string') return v
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  // Objects / arrays — JSON.stringify is fine for the few cases we
  // see (json columns aren't in our edit scope today).
  try {
    return JSON.stringify(v)
  } catch {
    return String(v)
  }
}

/** Write an AppointmentEditLog row. No-op when `changes` is empty,
 *  so callers can blindly call this after any PATCH without first
 *  checking for diffs. Errors are swallowed + logged — the audit
 *  trail is nice-to-have, never blocking. */
export async function recordAppointmentEdit(input: {
  appointmentId?: string | null
  sheetTabTitle?: string | null
  sheetRowNumber?: number | null
  clientId?: string | null
  clientName?: string | null
  editorUserId?: string | null
  editorEmail?: string | null
  editorName?: string | null
  customerName?: string | null
  customerPhone?: string | null
  apptDateTime?: Date | string | null
  source: EditSource
  changes: ChangeMap
}): Promise<void> {
  if (!input.changes || Object.keys(input.changes).length === 0) return

  const apptDateTime = (() => {
    if (!input.apptDateTime) return null
    if (input.apptDateTime instanceof Date) return input.apptDateTime
    const d = new Date(input.apptDateTime)
    return isNaN(d.getTime()) ? null : d
  })()

  try {
    await prisma.appointmentEditLog.create({
      data: {
        appointmentId: input.appointmentId ?? null,
        sheetTabTitle: input.sheetTabTitle ?? null,
        sheetRowNumber: input.sheetRowNumber ?? null,
        clientId: input.clientId ?? null,
        clientName: input.clientName ?? null,
        editorUserId: input.editorUserId ?? null,
        editorEmail: input.editorEmail ?? null,
        editorName: input.editorName ?? null,
        customerName: input.customerName ?? null,
        customerPhone: input.customerPhone ?? null,
        apptDateTime,
        source: input.source,
        changes: input.changes as object,
      },
    })
  } catch (err) {
    console.error('[appointment-edit-log] failed to record:', err)
  }
}
