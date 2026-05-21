/**
 * Orchestrates Google Sheets sync for agent appointments. Each function is
 * best-effort — any failure is recorded on the Appointment.syncError field
 * so the agent's UI can surface the warning without blocking the main flow.
 */
import { prisma } from './prisma'
import {
  ensureAgentTab,
  appendAppointmentRows,
  updateAppointmentRows,
  clearAppointmentRows,
  readMasterTableRows,
  type AppointmentSyncData,
} from './drive'
import { rekeySlackDeliveryAfterSheetSync } from './client-delivery'
import { rekeyClientAlertAfterSheetSync } from './client-alert'
import { rekeyClientEmailAlertAfterSheetSync } from './client-email-alert'

type AgentLite = {
  id: string
  name: string | null
  email: string
  agentSheetTab: string | null
}

function toSyncData(
  appt: {
    apptDateTime: Date
    customerName: string
    customerPhone: string
    address: string | null
    email: string | null
    monthlyBill: string | null
    utilityProvider: string | null
    roofType: string | null
    roofAge: string | null
    status: string
    estimatedDealValue: string | null
    notes: string | null
    callRecordingLink: string | null
    bookedByName: string | null
    createdAt: Date
    client?: { name: string; state: string | null } | null
  },
  agent: AgentLite
): AppointmentSyncData {
  return {
    apptDateTime: appt.apptDateTime,
    clientName: appt.client?.name || null,
    clientState: appt.client?.state || null,
    customerName: appt.customerName,
    customerPhone: appt.customerPhone,
    address: appt.address,
    email: appt.email,
    monthlyBill: appt.monthlyBill,
    utilityProvider: appt.utilityProvider,
    roofType: appt.roofType,
    roofAge: appt.roofAge,
    status: appt.status,
    estimatedDealValue: appt.estimatedDealValue,
    notes: appt.notes,
    callRecordingLink: appt.callRecordingLink,
    // Prefer the explicit "Booked by" name when Mary recorded one;
    // fall back to the booking user's name for older rows + cases
    // where the field was left blank. The sheet's "Agent Name"
    // column thus shows the *call-center* agent, which is what
    // clients reading the master tracker actually care about.
    agentName: appt.bookedByName?.trim() || agent.name,
    agentEmail: agent.email,
    createdAt: appt.createdAt,
  }
}

async function resolveAgentTab(agent: AgentLite): Promise<string | null> {
  if (agent.agentSheetTab) return agent.agentSheetTab
  // Approval didn't create one (maybe Drive wasn't connected yet). Try now.
  try {
    const tab = await ensureAgentTab({ agentName: agent.name, agentEmail: agent.email })
    await prisma.user.update({ where: { id: agent.id }, data: { agentSheetTab: tab } })
    return tab
  } catch (err) {
    console.error('[appointment-sync] ensureAgentTab failed:', err)
    return null
  }
}

/** Sync a newly-created appointment. Safe to call in a fire-and-forget manner. */
export async function syncAppointmentCreate(appointmentId: string): Promise<void> {
  const appt = await prisma.appointment.findUnique({
    where: { id: appointmentId },
    include: {
      agent: { select: { id: true, name: true, email: true, agentSheetTab: true } },
      client: { select: { name: true, state: true } },
    },
  })
  if (!appt) return

  const tab = await resolveAgentTab(appt.agent)
  if (!tab) {
    await prisma.appointment.update({
      where: { id: appointmentId },
      data: { syncError: 'No master spreadsheet tab available for this agent yet.' },
    })
    return
  }

  try {
    const result = await appendAppointmentRows({
      agentTabTitle: tab,
      appt: toSyncData(appt, appt.agent),
    })
    await prisma.appointment.update({
      where: { id: appointmentId },
      data: {
        agentSheetRowNumber: result.agentRow || null,
        masterSheetRowNumber: result.masterRow || null,
        lastSyncedAt: new Date(),
        syncError: null,
      },
    })
    // Slack + SMS notifications are NOT triggered here — they fire
    // directly from /api/agent/appointments POST against the DB row
    // so they don't depend on the sheet round-trip succeeding.
    // Sheet sync is now strictly an audit / backup path.
    //
    // Re-key the delivery records (created by the direct-fire path)
    // from sourceKey "db:appointment:{id}" to "sheet:Master Table:N"
    // so the cron's later scan of the same row dedup-matches by
    // sourceKey too. Without this, the cron would fall back to the
    // content-key check which has a 48h window — fine for near-term
    // appointments, but a row scheduled 60 days out would re-post
    // once the window expired.
    if (result.masterRow) {
      void rekeySlackDeliveryAfterSheetSync(appointmentId, result.masterRow)
      void rekeyClientAlertAfterSheetSync(appointmentId, result.masterRow)
      void rekeyClientEmailAlertAfterSheetSync(appointmentId, result.masterRow)
    }
  } catch (err) {
    console.error('[appointment-sync create] failed:', err)
    await prisma.appointment.update({
      where: { id: appointmentId },
      data: { syncError: (err as Error).message.slice(0, 500) },
    })
  }
}

/** Sync an edited appointment. Falls back to append if no row numbers exist yet. */
export async function syncAppointmentUpdate(appointmentId: string): Promise<void> {
  const appt = await prisma.appointment.findUnique({
    where: { id: appointmentId },
    include: {
      agent: { select: { id: true, name: true, email: true, agentSheetTab: true } },
      client: { select: { name: true, state: true } },
    },
  })
  if (!appt) return

  const tab = await resolveAgentTab(appt.agent)
  if (!tab) {
    await prisma.appointment.update({
      where: { id: appointmentId },
      data: { syncError: 'No master spreadsheet tab available for this agent yet.' },
    })
    return
  }

  try {
    if (appt.agentSheetRowNumber && appt.masterSheetRowNumber) {
      await updateAppointmentRows({
        agentTabTitle: tab,
        agentRowNumber: appt.agentSheetRowNumber,
        masterRowNumber: appt.masterSheetRowNumber,
        appt: toSyncData(appt, appt.agent),
      })
      await prisma.appointment.update({
        where: { id: appointmentId },
        data: { lastSyncedAt: new Date(), syncError: null },
      })
    } else {
      // Never synced before — append as though it were a fresh create.
      const result = await appendAppointmentRows({
        agentTabTitle: tab,
        appt: toSyncData(appt, appt.agent),
      })
      await prisma.appointment.update({
        where: { id: appointmentId },
        data: {
          agentSheetRowNumber: result.agentRow || null,
          masterSheetRowNumber: result.masterRow || null,
          lastSyncedAt: new Date(),
          syncError: null,
        },
      })
    }
    // Client notifications (Slack + SMS) fire from the POST /api/
    // agent/appointments handler against the DB row, not from here.
    // Sheet sync stays decoupled.
  } catch (err) {
    console.error('[appointment-sync update] failed:', err)
    await prisma.appointment.update({
      where: { id: appointmentId },
      data: { syncError: (err as Error).message.slice(0, 500) },
    })
  }
}

/**
 * Clear the sheet rows for a deleted appointment. Caller passes the data
 * captured before the DB row was deleted (we can't look it up after).
 */
export async function syncAppointmentDelete(params: {
  agentTabTitle: string | null
  agentRowNumber: number | null
  masterRowNumber: number | null
}): Promise<void> {
  if (!params.agentTabTitle || !params.agentRowNumber || !params.masterRowNumber) return
  try {
    await clearAppointmentRows({
      agentTabTitle: params.agentTabTitle,
      agentRowNumber: params.agentRowNumber,
      masterRowNumber: params.masterRowNumber,
    })
  } catch (err) {
    console.error('[appointment-sync delete] failed:', err)
  }
}

/* -------------------------------------------------------------------------- */
/*  Reconciliation — DB ↔ master sheet                                         */
/* -------------------------------------------------------------------------- */

/**
 * Stable content key for matching a DB Appointment to a master-sheet
 * row. Phone is normalized to E.164, time is rounded to the minute so
 * the sheet's FORMATTED_VALUE read (which can drop sub-minute precision)
 * still aligns with the DB's ms-precision DateTime.
 */
function contentKey(
  phone: string | null | undefined,
  apptDateTime: Date | string | null,
): string | null {
  if (!phone) return null
  const digits = String(phone).replace(/\D/g, '')
  let normalized: string
  if (digits.length === 10) normalized = `+1${digits}`
  else if (digits.length === 11 && digits.startsWith('1')) normalized = `+${digits}`
  else if (digits.length >= 10) normalized = `+${digits}`
  else return null
  if (!apptDateTime) return null
  const d = typeof apptDateTime === 'string' ? new Date(apptDateTime) : apptDateTime
  if (isNaN(d.getTime())) return null
  const minute = new Date(Math.floor(d.getTime() / 60_000) * 60_000).toISOString()
  return `${normalized}|${minute}`
}

export type MissingAppointmentSummary = {
  id: string
  customerName: string
  customerPhone: string
  apptDateTime: string
  clientName: string | null
  reason: 'never-synced' | 'sync-failed' | 'sheet-row-missing'
  syncError: string | null
}

/**
 * Find every Appointment in the DB that doesn't have a matching row
 * in the master sheet. Three scenarios collapse into one list:
 *
 *   1. never-synced       — masterSheetRowNumber is null and no
 *                            content match in the sheet either
 *   2. sync-failed        — syncError is set; might or might not also
 *                            have a stale row number from a prior run
 *   3. sheet-row-missing  — masterSheetRowNumber is set, but the row
 *                            it points to is gone (Mary deleted it
 *                            from the sheet directly) AND no other
 *                            sheet row matches by content
 *
 * The "sheet-row-missing" case is detected by content match against
 * the current sheet — if the DB row's (phone, apptDateTime) pair
 * doesn't appear anywhere on the sheet, the row was deleted. Phone +
 * apptDateTime are stable across row shuffles so this catches
 * deletions reliably without relying on row numbers.
 *
 * Used by the Settings page reconciliation card to surface the
 * count + sample, and by reconcileMissingAppointments() to pick
 * which rows to retry-sync.
 */
export async function findAppointmentsMissingFromSheet(): Promise<MissingAppointmentSummary[]> {
  const dbAppts = await prisma.appointment.findMany({
    where: { clientId: { not: null } },
    select: {
      id: true,
      customerName: true,
      customerPhone: true,
      apptDateTime: true,
      masterSheetRowNumber: true,
      syncError: true,
      client: { select: { name: true } },
    },
    orderBy: { createdAt: 'desc' },
  })

  let sheetRows: Awaited<ReturnType<typeof readMasterTableRows>>
  try {
    sheetRows = await readMasterTableRows()
  } catch (err) {
    console.error(
      '[appointment-reconcile] sheet read failed; falling back to row-number-only check:',
      err,
    )
    sheetRows = []
  }

  const sheetContentKeys = new Set<string>()
  const sheetRowNumbers = new Set<number>()
  for (const r of sheetRows) {
    sheetRowNumbers.add(r.rowNumber)
    const key = contentKey(r.customerPhone, r.apptDateTime)
    if (key) sheetContentKeys.add(key)
  }

  const missing: MissingAppointmentSummary[] = []
  for (const a of dbAppts) {
    const key = contentKey(a.customerPhone, a.apptDateTime)
    const inSheetByContent = key ? sheetContentKeys.has(key) : false
    const inSheetByRow =
      a.masterSheetRowNumber != null && sheetRowNumbers.has(a.masterSheetRowNumber)

    // Present in sheet by either index → not missing.
    if (inSheetByContent || inSheetByRow) continue

    let reason: MissingAppointmentSummary['reason']
    if (a.syncError) reason = 'sync-failed'
    else if (a.masterSheetRowNumber == null) reason = 'never-synced'
    else reason = 'sheet-row-missing'

    missing.push({
      id: a.id,
      customerName: a.customerName,
      customerPhone: a.customerPhone,
      apptDateTime: a.apptDateTime.toISOString(),
      clientName: a.client?.name ?? null,
      reason,
      syncError: a.syncError,
    })
  }
  return missing
}

export type ReconcileResult = {
  attempted: number
  succeeded: number
  failed: number
  failures: { id: string; customerName: string; error: string }[]
}

/**
 * Re-run the sheet sync for every Appointment in the DB that's
 * currently missing from the master sheet. Uses syncAppointmentUpdate
 * which already handles both append (no row number yet) and update
 * (stale row number) cases — so this is one code path regardless of
 * the original failure mode.
 *
 * Sequential, not parallel, so concurrent appendAppointmentRows
 * calls don't race for the next row number on the sheet. ~1-2s per
 * row in practice; 100 missing rows is ~3 minutes worst case which
 * is fine for an admin-triggered button.
 *
 * Idempotent — calling it again after success is a no-op (the rows
 * are no longer missing, so the loop body skips).
 */
export async function reconcileMissingAppointments(): Promise<ReconcileResult> {
  const missing = await findAppointmentsMissingFromSheet()
  const result: ReconcileResult = {
    attempted: missing.length,
    succeeded: 0,
    failed: 0,
    failures: [],
  }

  for (const m of missing) {
    try {
      await syncAppointmentUpdate(m.id)
      // syncAppointmentUpdate is fire-and-forget about its own
      // errors (writes them to syncError instead of throwing). Re-
      // read the row to see whether the retry actually cleared the
      // syncError or still has it.
      const after = await prisma.appointment.findUnique({
        where: { id: m.id },
        select: { syncError: true, masterSheetRowNumber: true },
      })
      if (after && !after.syncError && after.masterSheetRowNumber != null) {
        result.succeeded++
      } else {
        result.failed++
        result.failures.push({
          id: m.id,
          customerName: m.customerName,
          error: after?.syncError ?? 'sync did not write a row number',
        })
      }
    } catch (err) {
      result.failed++
      result.failures.push({
        id: m.id,
        customerName: m.customerName,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }
  return result
}
