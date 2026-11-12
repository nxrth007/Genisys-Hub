import { prisma } from '@/lib/prisma'
import { textTeam } from '@/lib/team-sms'
import { TEXT_AGAIN_AFTER_MS, textsTeamFor, workerAlertText, type WorkerAlertKind } from './alert-text'

/**
 * Text Alex and Ethan about one sub-account problem (Slack is not read).
 * At most once per key (a job or client id) and kind every 12 hours. The
 * send is recorded in the database first, so a restart or a repeating
 * failure never texts twice. Never throws.
 */
export async function textWorkerProblem(opts: {
  key: string
  kind: WorkerAlertKind
  client: string
  subAccountName?: string
  reason?: string
  link: string
}): Promise<void> {
  try {
    if (!textsTeamFor(opts.subAccountName ?? opts.client)) return
    const settingKey = `ghlWorker.texted.${opts.kind}.${opts.key}`
    const row = await prisma.appSetting.findUnique({ where: { key: settingKey } })
    if (row && Date.now() - Date.parse(row.value) < TEXT_AGAIN_AFTER_MS) return
    const value = new Date().toISOString()
    await prisma.appSetting.upsert({ where: { key: settingKey }, create: { key: settingKey, value }, update: { value } })
    await textTeam(workerAlertText(opts.kind, opts.client, opts.reason ?? '', opts.link), 'GHL sub-account')
  } catch (err) {
    console.warn('[ghl-subaccount-worker] team text failed:', err instanceof Error ? err.message : err)
  }
}
