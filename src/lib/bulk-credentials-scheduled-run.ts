/**
 * One-time scheduled bulk-credential provisioning. Fires the same
 * bulk-credentials logic the admin UI button runs, but on a clock
 * trigger instead of an admin click — used for Alex's 2026-06-01
 * 7AM EDT roll-out of the 9 existing clients.
 *
 * Design constraints:
 *   - Won't double-fire. Once it's run, an AppSetting row records
 *     the firing timestamp + result summary. Subsequent ticks check
 *     that row and short-circuit if it's set.
 *   - Survives reboots. The "already fired" flag lives in the DB,
 *     not memory, so a Render deploy mid-window can't cause a
 *     second run.
 *   - Trigger time configured via env var BULK_CREDENTIALS_FIRE_AT
 *     (ISO 8601 UTC). When unset, this whole feature is a no-op —
 *     keeps the codebase from drifting into "what does this do?"
 *     territory once the one-time roll-out is done. Delete the env
 *     var after firing.
 *   - Same provisioning + delivery code path as the admin UI button.
 *     Calls provisionClientCredentials + sendClientWelcomeMessages
 *     per client; doesn't re-implement.
 */

import { prisma } from './prisma'
import {
  provisionClientCredentials,
  sendClientWelcomeMessages,
} from './client-credentials'

const FIRE_AT_ENV = 'BULK_CREDENTIALS_FIRE_AT'
const SETTING_KEY_FIRED = 'bulkCredentials.firedAt'

/** Hub origin used to build the sign-in URL in the welcome email.
 *  Same shape as the helper in client-delivery / client-email-alert. */
function getHubOrigin(): string {
  const raw = process.env.AUTH_URL || 'http://localhost:3000'
  return raw.replace(/\/$/, '')
}

/**
 * Called once per cron minute from the scheduler. Cheap no-op when:
 *   - BULK_CREDENTIALS_FIRE_AT is unset, OR
 *   - The fire time hasn't arrived yet, OR
 *   - We've already fired (recorded in AppSetting).
 *
 * When all three conditions clear, runs the bulk provision +
 * welcome delivery for every active client without a login.
 * Records the result in AppSetting so the next tick is a no-op.
 */
export async function maybeRunScheduledBulkCredentials(): Promise<void> {
  const fireAtRaw = process.env[FIRE_AT_ENV]
  if (!fireAtRaw) return // feature disabled when env var is unset

  const fireAt = new Date(fireAtRaw)
  if (isNaN(fireAt.getTime())) {
    console.error(
      `[bulk-credentials-scheduled] invalid ${FIRE_AT_ENV} value: ${fireAtRaw}`,
    )
    return
  }
  if (Date.now() < fireAt.getTime()) {
    // Not yet — bail without touching the DB.
    return
  }

  // Has it already fired? AppSetting is the source of truth across
  // restarts. The fired record stores ISO-formatted Date so a future
  // change to the env var can be compared to the actual firing time.
  const firedRecord = await prisma.appSetting
    .findUnique({ where: { key: SETTING_KEY_FIRED } })
    .catch(() => null)
  if (firedRecord?.value) {
    return
  }

  // Reserve the slot BEFORE doing any work so two overlapping
  // scheduler ticks can't double-fire. AppSetting.key is the PK, so
  // a parallel upsert races to a single winner; the loser short-
  // circuits on the next tick by reading the same key.
  try {
    await prisma.appSetting.create({
      data: {
        key: SETTING_KEY_FIRED,
        value: `running:${new Date().toISOString()}`,
      },
    })
  } catch {
    // Another tick beat us to the punch — bail.
    return
  }

  console.log(
    `[bulk-credentials-scheduled] firing — scheduled for ${fireAt.toISOString()}, current time ${new Date().toISOString()}`,
  )

  let generated = 0
  let failed = 0
  let emailsSent = 0
  let smsSent = 0
  let smsSkippedNoPhone = 0
  let smsFailed = 0
  const failures: Array<{ name: string; error: string }> = []

  try {
    const allActiveClients = await prisma.client.findMany({
      where: { active: true },
      orderBy: { name: 'asc' },
      select: {
        id: true,
        name: true,
        contactEmail: true,
        contactName: true,
        contactPhone: true,
        users: {
          where: { role: { startsWith: 'client_' } },
          select: { id: true },
          take: 1,
        },
      },
    })
    const candidates = allActiveClients.filter(
      (c: { users: { id: string }[] }) => c.users.length === 0,
    )

    const hubOrigin = getHubOrigin()

    for (const client of candidates) {
      const provision = await provisionClientCredentials(client.id)
      if (!provision.ok) {
        failed++
        failures.push({ name: client.name, error: provision.error })
        continue
      }

      const delivery = await sendClientWelcomeMessages({
        client: {
          id: client.id,
          name: client.name,
          contactName: client.contactName,
          contactEmail: provision.email,
          contactPhone: client.contactPhone,
        },
        email: provision.email,
        tempPassword: provision.tempPassword,
        hubOrigin,
      })

      generated++
      if (delivery.emailSent) emailsSent++
      if (delivery.smsSent) smsSent++
      if (delivery.smsSkippedReason === 'no_phone') smsSkippedNoPhone++
      if (delivery.smsError) smsFailed++
      if (delivery.emailError) {
        failures.push({
          name: client.name,
          error: `email send failed: ${delivery.emailError}`,
        })
      }
    }

    const summary = {
      firedAt: new Date().toISOString(),
      scheduledFor: fireAt.toISOString(),
      candidates: candidates.length,
      generated,
      failed,
      emailsSent,
      smsSent,
      smsSkippedNoPhone,
      smsFailed,
      failures,
    }
    await prisma.appSetting.update({
      where: { key: SETTING_KEY_FIRED },
      data: { value: JSON.stringify(summary) },
    })
    console.log(
      `[bulk-credentials-scheduled] done — ${generated} generated, ${emailsSent} emails, ${smsSent} SMS, ${failed} failed`,
    )
  } catch (err) {
    // Catastrophic failure (e.g. DB down mid-loop). Leave the
    // "running:" marker so we don't accidentally fire again — admin
    // can clear it from /admin SQL once they've verified state.
    console.error(
      '[bulk-credentials-scheduled] run failed; AppSetting left in running state to prevent retry:',
      err,
    )
    await prisma.appSetting
      .update({
        where: { key: SETTING_KEY_FIRED },
        data: {
          value: `error:${new Date().toISOString()}:${
            err instanceof Error ? err.message : String(err)
          }`,
        },
      })
      .catch(() => {})
  }
}
