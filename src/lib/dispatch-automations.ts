import { deliverAppointmentToSlack } from './client-delivery'
import { deliverAppointmentAsSms } from './client-alert'
import { deliverAppointmentAsEmail } from './client-email-alert'
import { upsertRemindersForAppointment } from './reminders'

/**
 * Fire every client-facing automation for an appointment the moment an
 * agent marks it "confirmed" — i.e. everything is locked with the
 * homeowner. Until confirm, booking only sends the customer a short
 * confirmation FYI; nothing reaches the client and no timed reminder is
 * armed.
 *
 * On confirm this:
 *   - posts the appointment details to the client's Slack channel,
 *   - queues the buffered client SMS + email (per-client opt-in),
 *   - arms the customer's timed reminders (4hr / 2hr / 30min / start —
 *     upsertRemindersForAppointment only creates these once the appt's
 *     status is 'dispatched').
 *
 * Fire-and-forget; each path logs + no-ops internally when its channel
 * is disabled / not-opted-in. Callers MUST only invoke this on the
 * transition INTO 'dispatched' (old status !== 'dispatched'), so a
 * re-save of an already-dispatched row doesn't re-post. Each delivery
 * also dedups on its own sourceKey as a backstop.
 */
export function triggerDispatchAutomations(appointmentId: string): void {
  void deliverAppointmentToSlack(appointmentId)
    .then((r) => {
      console.log(
        `[dispatch] slack: ${r.status}${r.reason ? ` (${r.reason})` : ''} for ${appointmentId}`,
      )
    })
    .catch((err) => console.error('[dispatch] slack threw:', err))

  void deliverAppointmentAsSms(appointmentId)
    .then((r) => {
      if (r.status !== 'disabled') {
        console.log(
          `[dispatch] client sms: ${r.status}${r.reason ? ` (${r.reason})` : ''} for ${appointmentId}`,
        )
      }
    })
    .catch((err) => console.error('[dispatch] client sms threw:', err))

  void deliverAppointmentAsEmail(appointmentId)
    .then((r) => {
      if (
        r.status !== 'disabled' &&
        r.status !== 'not-opted-in' &&
        r.status !== 'no-email'
      ) {
        console.log(
          `[dispatch] client email: ${r.status}${r.reason ? ` (${r.reason})` : ''} for ${appointmentId}`,
        )
      }
    })
    .catch((err) => console.error('[dispatch] client email threw:', err))

  void upsertRemindersForAppointment(appointmentId)
    .then((r) => {
      if (!r.skippedDisabled) {
        console.log(
          `[dispatch] reminders armed: ${r.upserted} new, ${r.skippedPast} past for ${appointmentId}`,
        )
      }
    })
    .catch((err) => console.error('[dispatch] reminders threw:', err))
}
