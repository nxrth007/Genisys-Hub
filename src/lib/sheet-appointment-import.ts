/**
 * Import sheet-only appointments into the DB so they're first-class
 * in the Hub — visible on the client dashboard, status-updatable by
 * the client, and editable by staff — exactly like Hub-booked rows.
 *
 * Background: DB Appointment rows are ONLY created by the agent
 * booking form. Appointments that live solely in a Google sheet
 * (e.g. Brighton Capital's) never become DB rows, so the client
 * dashboard — which reads the Appointment table by clientId — shows
 * the client nothing. This sync fills that gap.
 *
 * REMINDER SAFETY (the non-negotiable): imported appointments are
 * created WITHOUT any reminders. The reminder engine's dedup only
 * considers appointments that already have db:appointment reminders
 * (see syncRemindersFromSheet's dbReminderApptIds), so a reminderless
 * imported row is invisible to it — the sheet keeps owning those
 * customers' reminders and nothing can double-fire. We never call
 * upsertRemindersForAppointment here.
 *
 * Ownership: once imported, the DB is the source of truth. We only
 * ever CREATE (keyed on importSourceKey); we never re-sync edits back
 * from the sheet onto an already-imported row, so a stale sheet cell
 * can't clobber a status the client/staff set in the Hub. New sheet
 * rows get imported on the next tick; existing ones are Hub-owned.
 */
import { prisma } from './prisma'
import { readAllSheetRows, rowSourceKey } from './secondary-sheets'

/** Email of the system account that owns imported appointments.
 *  Appointment.agentUserId is required + relational; sheet rows have
 *  no Hub user, so they're attributed here. No password is set, so it
 *  can't be logged into. The real booker shows via bookedByName. */
const IMPORT_AGENT_EMAIL = 'sheet-import@genisys.system'

async function getImportAgentUserId(): Promise<string> {
  const existing = await prisma.user.findUnique({
    where: { email: IMPORT_AGENT_EMAIL },
    select: { id: true },
  })
  if (existing) return existing.id
  const created = await prisma.user.create({
    data: {
      email: IMPORT_AGENT_EMAIL,
      name: 'Sheet Import',
      role: 'agent',
    },
    select: { id: true },
  })
  return created.id
}

/** Map a free-text sheet status cell to the Appointment status enum. */
function mapStatus(raw: string | null | undefined): string {
  const s = (raw ?? '').toLowerCase()
  if (s.includes('cancel')) return 'cancelled'
  if (s.includes('resched')) return 'rescheduled'
  if (s.includes('no') && s.includes('show')) return 'no_show'
  if (s.includes('won')) return 'won'
  if (s.includes('lost')) return 'lost'
  if (s.includes('show')) return 'showed'
  return 'booked'
}

function phoneDigits(raw: string | null | undefined): string {
  if (!raw) return ''
  const d = String(raw).replace(/\D/g, '')
  if (d.length < 10) return ''
  return d.length === 11 && d.startsWith('1') ? d.slice(1) : d.slice(-10)
}

type ImportResult = {
  scanned: number
  imported: number
  skippedExisting: number
  skippedNoClient: number
  skippedHubBooked: number
  /** Diagnostics — distinct client identifiers per bucket so we can
   *  see WHICH clients matched vs didn't (e.g. is Brighton in
   *  noClientSamples because of a name mismatch?). */
  importedClients: string[]
  existingClients: string[]
  noClientSamples: string[]
}

export async function syncSheetAppointmentsToDb(): Promise<ImportResult> {
  const result: ImportResult = {
    scanned: 0,
    imported: 0,
    skippedExisting: 0,
    skippedNoClient: 0,
    skippedHubBooked: 0,
    importedClients: [],
    existingClients: [],
    noClientSamples: [],
  }
  const importedClients = new Set<string>()
  const existingClients = new Set<string>()
  const noClientSamples = new Set<string>()

  let rows: Awaited<ReturnType<typeof readAllSheetRows>>
  try {
    rows = await readAllSheetRows()
  } catch (err) {
    console.error('[sheet-import] sheet read failed:', err)
    return result
  }

  // Active clients for primary-row (Client column) attribution.
  const clients = await prisma.client.findMany({
    where: { active: true },
    select: { id: true, name: true },
  })
  const clientByLowerName = new Map(
    clients.map((c) => [c.name.toLowerCase(), c.id]),
  )
  const clientNameById = new Map(clients.map((c) => [c.id, c.name]))
  const activeClientIds = new Set(clients.map((c) => c.id))

  // Already-imported keys (skip — Hub owns them now) + content keys of
  // existing NON-imported (Hub-booked) appointments so we never import
  // a sheet row that's really Mary's booking and duplicate it.
  const [importedKeys, hubBooked] = await Promise.all([
    prisma.appointment.findMany({
      where: { importSourceKey: { not: null } },
      select: { importSourceKey: true },
    }),
    prisma.appointment.findMany({
      where: { importedFromSheet: false },
      select: { customerPhone: true, apptDateTime: true },
    }),
  ])
  const seenKeys = new Set(
    importedKeys.map((a) => a.importSourceKey).filter(Boolean) as string[],
  )
  const hubContentKeys = new Set<string>()
  for (const a of hubBooked) {
    const p = phoneDigits(a.customerPhone)
    if (p) hubContentKeys.add(`${p}|${a.apptDateTime.toISOString().slice(0, 13)}`)
  }

  const importAgentId = await getImportAgentUserId()

  for (const r of rows) {
    if (!r.customerName?.trim() || !r.customerPhone?.trim() || !r.apptDateTime) {
      continue
    }
    const apptDate = new Date(r.apptDateTime)
    if (isNaN(apptDate.getTime())) continue
    result.scanned++

    // Attribute to a client: secondary rows carry source.clientId;
    // primary rows resolve via the Client column. Skip if neither
    // maps to an active client.
    let clientId: string | null = null
    if (r.source.kind === 'secondary' && r.source.clientId) {
      if (activeClientIds.has(r.source.clientId)) clientId = r.source.clientId
    } else if (r.client) {
      clientId = clientByLowerName.get(r.client.toLowerCase()) ?? null
    }
    if (!clientId) {
      result.skippedNoClient++
      noClientSamples.add(
        r.source.kind === 'secondary'
          ? `secondary[${r.source.spreadsheetId.slice(0, 8)} clientId=${r.source.clientId ?? 'null'}]`
          : `client="${r.client ?? '(blank)'}"`,
      )
      continue
    }

    const importSourceKey = rowSourceKey(r)
    if (seenKeys.has(importSourceKey)) {
      result.skippedExisting++
      existingClients.add(clientNameById.get(clientId) ?? clientId)
      continue
    }

    // Don't duplicate a Hub-booked appointment that's also on the
    // sheet (same customer + same hour).
    const p = phoneDigits(r.customerPhone)
    if (p && hubContentKeys.has(`${p}|${apptDate.toISOString().slice(0, 13)}`)) {
      result.skippedHubBooked++
      continue
    }

    try {
      await prisma.appointment.create({
        data: {
          agentUserId: importAgentId,
          clientId,
          apptDateTime: apptDate,
          customerName: r.customerName.trim(),
          customerPhone: r.customerPhone.trim(),
          address: r.address ?? null,
          email: r.email ?? null,
          monthlyBill: r.monthlyBill ?? null,
          utilityProvider: r.utilityProvider ?? null,
          roofType: r.roofType ?? null,
          roofAge: r.roofAge ?? null,
          status: mapStatus(r.status),
          notes: r.notes ?? null,
          callRecordingLink: r.callRecordingLink ?? null,
          bookedByName: r.agentName ?? null,
          importedFromSheet: true,
          importSourceKey,
          // Master-sheet rows: keep the row link so staff edits +
          // status writes can round-trip to the sheet via the
          // existing sync. Secondary rows have no master row number.
          masterSheetRowNumber:
            r.source.kind === 'primary' ? r.rowNumber : null,
        },
      })
      seenKeys.add(importSourceKey)
      importedClients.add(clientNameById.get(clientId) ?? clientId)
      result.imported++
    } catch (err) {
      const code =
        err instanceof Error && 'code' in err
          ? (err as { code?: string }).code
          : undefined
      if (code === 'P2002') {
        // Race: another tick imported this key first. Treat as existing.
        result.skippedExisting++
        continue
      }
      console.error(
        `[sheet-import] create failed for ${importSourceKey}:`,
        err,
      )
    }
  }

  result.importedClients = [...importedClients]
  result.existingClients = [...existingClients]
  result.noClientSamples = [...noClientSamples].slice(0, 25)
  return result
}
