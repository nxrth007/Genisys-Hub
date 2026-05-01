/**
 * Pull the list of GHL conversations created by the reminder system.
 *
 * Every successful reminder send writes ghlConversationId +
 * ghlContactId to the AppointmentReminder row. Multiple reminders
 * for the same customer share the same GHL conversation thread (GHL
 * groups by contact), so we de-duplicate down to one row per
 * conversation, keeping the most recent reminder's metadata for
 * context on the list view (customer name, phone, appt date).
 *
 * The list view renders this directly — no GHL round-trip per row,
 * keeps the page fast. The detail view is what calls GHL to get the
 * actual message thread (including customer replies, which we don't
 * track in our DB).
 */

import { prisma } from './prisma'

export type ReminderConversationSummary = {
  /** GHL conversation id — used as the route param + thread key. */
  ghlConversationId: string
  /** GHL contact id — needed when posting replies via the GHL API. */
  ghlContactId: string
  /** Most recent reminder's customer name. */
  customerName: string
  customerPhone: string
  /** Appointment the latest reminder was for — surfaces as context
   *  on the list row so Mary recognizes which customer this is. */
  apptDateTime: string
  /** Last outbound reminder body from us. Useful as a preview line
   *  on the list view; the detail view fetches full GHL history. */
  lastOutboundBody: string | null
  lastOutboundAt: string
  /** Total number of reminders ever sent to this customer (across
   *  all their appointments). Helps Mary spot frequent flyers. */
  reminderCount: number
  /** Vault entry name for the GHL sub-account this conversation
   *  lives in — needed to call GHL's API on the detail / reply
   *  endpoints. Falls back to the singleton config's
   *  vaultEntryName when null on the row. */
  vaultEntryName: string
}

export async function listReminderConversations(): Promise<
  ReminderConversationSummary[]
> {
  const config = await prisma.remindersConfig.findUnique({
    where: { id: 'singleton' },
    select: { vaultEntryName: true },
  })
  const fallbackVault = config?.vaultEntryName ?? 'GHL Genisys Token'

  // Pull every reminder that successfully created a GHL conversation,
  // newest sentAt first. We'll de-duplicate by conversationId in
  // memory — Postgres' DISTINCT ON would be faster on a million-row
  // table, but our current scale is comfortably small.
  const rows = await prisma.appointmentReminder.findMany({
    where: {
      ghlConversationId: { not: null },
      ghlContactId: { not: null },
      sentAt: { not: null },
    },
    orderBy: { sentAt: 'desc' },
    select: {
      ghlConversationId: true,
      ghlContactId: true,
      customerName: true,
      customerPhone: true,
      apptDateTime: true,
      messageBody: true,
      sentAt: true,
    },
  })

  // De-dupe by ghlConversationId, keeping the first occurrence
  // (which is the most recent due to the orderBy above). Also count
  // total reminders per conversation so the UI can show a small
  // "3 reminders sent" badge for context.
  const seen = new Map<string, ReminderConversationSummary>()
  const counts = new Map<string, number>()
  for (const r of rows) {
    if (!r.ghlConversationId || !r.ghlContactId || !r.sentAt) continue
    counts.set(
      r.ghlConversationId,
      (counts.get(r.ghlConversationId) ?? 0) + 1,
    )
    if (seen.has(r.ghlConversationId)) continue
    seen.set(r.ghlConversationId, {
      ghlConversationId: r.ghlConversationId,
      ghlContactId: r.ghlContactId,
      customerName: r.customerName,
      customerPhone: r.customerPhone,
      apptDateTime: r.apptDateTime.toISOString(),
      lastOutboundBody: r.messageBody,
      lastOutboundAt: r.sentAt.toISOString(),
      reminderCount: 0, // patched below once counts are final
      vaultEntryName: fallbackVault,
    })
  }
  for (const [convId, summary] of seen) {
    summary.reminderCount = counts.get(convId) ?? 1
  }

  return Array.from(seen.values())
}

/**
 * Look up the vault entry name + contact id we'd need to call GHL
 * for a specific conversation. Returns null when no reminder ever
 * created this conversation (i.e. someone navigated to a stale id).
 */
export async function resolveReminderConversation(
  ghlConversationId: string,
): Promise<{
  ghlContactId: string
  vaultEntryName: string
  customerName: string
  customerPhone: string
} | null> {
  const config = await prisma.remindersConfig.findUnique({
    where: { id: 'singleton' },
    select: { vaultEntryName: true },
  })
  const fallbackVault = config?.vaultEntryName ?? 'GHL Genisys Token'

  const row = await prisma.appointmentReminder.findFirst({
    where: { ghlConversationId },
    orderBy: { sentAt: 'desc' },
    select: {
      ghlContactId: true,
      customerName: true,
      customerPhone: true,
    },
  })
  if (!row?.ghlContactId) return null
  return {
    ghlContactId: row.ghlContactId,
    vaultEntryName: fallbackVault,
    customerName: row.customerName,
    customerPhone: row.customerPhone,
  }
}
