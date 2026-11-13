import { prisma } from '@/lib/prisma'
import { textTeam } from '@/lib/team-sms'
import {
  customizeAlertText,
  numberAlertText,
  TEXT_AGAIN_AFTER_MS,
  textsTeamFor,
  workerAlertText,
  type CustomizeAlertKind,
  type NumberAlertKind,
  type WorkerAlertKind,
} from './alert-text'

type Problem = { key: string; client: string; subAccountName?: string; reason?: string; link: string }

/**
 * Send one text to Alex and Ethan (Slack is not read), at most once per
 * setting key every 12 hours. The send is recorded in the database first,
 * so a restart or a repeating failure never texts twice. Test runs
 * ("Test: …" sub-accounts) don't text. Never throws.
 */
async function textOnce(settingKey: string, p: Problem, message: string, label: string): Promise<void> {
  try {
    if (!textsTeamFor(p.subAccountName ?? p.client)) return
    const row = await prisma.appSetting.findUnique({ where: { key: settingKey } })
    if (row && Date.now() - Date.parse(row.value) < TEXT_AGAIN_AFTER_MS) return
    const value = new Date().toISOString()
    await prisma.appSetting.upsert({ where: { key: settingKey }, create: { key: settingKey, value }, update: { value } })
    await textTeam(message, label)
  } catch (err) {
    console.warn('[ghl-subaccount-worker] team text failed:', err instanceof Error ? err.message : err)
  }
}

/** One sub-account problem, keyed by a job or client id. */
export async function textWorkerProblem(opts: Problem & { kind: WorkerAlertKind }): Promise<void> {
  await textOnce(`ghlWorker.texted.${opts.kind}.${opts.key}`, opts, workerAlertText(opts.kind, opts.client, opts.reason ?? '', opts.link), 'GHL sub-account')
}

/** One toll-free number event (an approval to give, a purchase, a problem), keyed by a job id. */
export async function textNumberEvent(opts: Problem & { kind: NumberAlertKind }): Promise<void> {
  await textOnce(`ghlNumber.texted.${opts.kind}.${opts.key}`, opts, numberAlertText(opts.kind, opts.client, opts.reason ?? '', opts.link), 'GHL number')
}

/** One lead-workflow customize problem, keyed by a job or client id. */
export async function textCustomizeProblem(opts: Problem & { kind: CustomizeAlertKind }): Promise<void> {
  await textOnce(`ghlCustomize.texted.${opts.kind}.${opts.key}`, opts, customizeAlertText(opts.kind, opts.client, opts.reason ?? '', opts.link), 'GHL lead workflows')
}
