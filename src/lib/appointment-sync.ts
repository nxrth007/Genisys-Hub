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
  type AppointmentSyncData,
} from './drive'

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
    client?: { name: string } | null
  },
  agent: AgentLite
): AppointmentSyncData {
  return {
    apptDateTime: appt.apptDateTime,
    clientName: appt.client?.name || null,
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
      client: { select: { name: true } },
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
      client: { select: { name: true } },
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
