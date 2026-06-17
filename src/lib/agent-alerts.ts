/**
 * Agent alerts — the feedback loop that tells the booking agent when
 * something happens to one of their appointments: the customer
 * replied "N" / asked to reschedule, or a client marked it no-show /
 * cancelled. Alerts surface in the /agent portal so Mary can
 * re-engage or rebook without anyone relaying it by hand.
 *
 * Two entry points used by the triggers:
 *   - resolveBookingAgentUserId(): map an appointment / sheet agent
 *     name to the Hub user the alert should route to.
 *   - createAgentAlert(): idempotent insert keyed on dedupKey.
 */
import { prisma } from './prisma'

export type AgentAlertType =
  | 'negative_reply'
  | 'reschedule'
  | 'no_show'
  | 'cancelled'

type CreateInput = {
  agentUserId: string
  type: AgentAlertType
  dedupKey: string
  appointmentId?: string | null
  customerName?: string | null
  customerPhone?: string | null
  clientName?: string | null
  apptDateTime?: Date | null
  detail?: string | null
}

/**
 * Idempotent insert — re-firing the same (source event, type) is a
 * no-op via the unique dedupKey. Returns true when a new alert was
 * actually created (so callers can log / count), false on dedupe.
 */
export async function createAgentAlert(input: CreateInput): Promise<boolean> {
  try {
    await prisma.agentAlert.create({
      data: {
        agentUserId: input.agentUserId,
        type: input.type,
        dedupKey: input.dedupKey,
        appointmentId: input.appointmentId ?? null,
        customerName: input.customerName ?? null,
        customerPhone: input.customerPhone ?? null,
        clientName: input.clientName ?? null,
        apptDateTime: input.apptDateTime ?? null,
        detail: input.detail ?? null,
      },
    })
    return true
  } catch (err) {
    const code =
      err instanceof Error && 'code' in err
        ? (err as { code?: string }).code
        : undefined
    if (code === 'P2002') return false // already alerted
    console.error('[agent-alerts] create failed:', err)
    return false
  }
}

/**
 * Resolve which Hub user an alert should route to.
 *
 *   1. appointmentId → Appointment.agentUserId (the authoritative
 *      link for Hub-booked appointments).
 *   2. agentName → a User whose name matches (case-insensitive),
 *      restricted to agent / team_member roles. Covers sheet-only
 *      rows where there's no DB appointment, just the agent's name
 *      in the sheet (e.g. "Mary Faith").
 *
 * Returns null when neither resolves — the caller skips the alert
 * rather than guessing.
 */
export async function resolveBookingAgentUserId(params: {
  appointmentId?: string | null
  agentName?: string | null
}): Promise<string | null> {
  if (params.appointmentId) {
    const appt = await prisma.appointment.findUnique({
      where: { id: params.appointmentId },
      select: { agentUserId: true },
    })
    if (appt?.agentUserId) return appt.agentUserId
  }
  const name = params.agentName?.trim()
  if (name) {
    const user = await prisma.user.findFirst({
      where: {
        name: { equals: name, mode: 'insensitive' },
        role: { in: ['agent', 'team_member'] },
      },
      select: { id: true },
    })
    if (user) return user.id
  }
  return null
}
