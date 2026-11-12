/**
 * The GHL agency sign-in the browser jobs share: the login, the saved
 * browser session (sealed in Postgres, never on disk), and the security
 * code a person pastes or the worker reads from the inbox. Used by the
 * sub-account create job and the workflow customize job.
 */
import { prisma } from '@/lib/prisma'
import { getSecretByName } from '@/lib/vault-service'
import { loginFromEnv, parseAgencyLogin, VAULT_LOGIN_NAME } from './config'
import { fetchLatestSecurityCode, imapSettings } from './otp-mail'
import { openString, sealString } from './session'

export const SESSION_KEY = 'ghlSubaccountWorker.session'
export const OTP_KEY = 'ghlSubaccountWorker.otp'

export async function loadLogin(): Promise<{ email: string; password: string } | null> {
  const fromEnv = loginFromEnv()
  if (fromEnv) return fromEnv
  try {
    return parseAgencyLogin(await getSecretByName(VAULT_LOGIN_NAME))
  } catch {
    return null
  }
}

export async function loadSession(): Promise<string | null> {
  const row = await prisma.appSetting.findUnique({ where: { key: SESSION_KEY } })
  return openString(row?.value)
}

export async function saveSession(json: string): Promise<void> {
  if (json.length > 500_000) return
  const value = sealString(json)
  await prisma.appSetting.upsert({
    where: { key: SESSION_KEY },
    create: { key: SESSION_KEY, value },
    update: { value },
  })
}

async function takeWorkerOtp(clientId: string): Promise<string | null> {
  const row = await prisma.appSetting.findUnique({ where: { key: OTP_KEY } })
  if (!row) return null
  const raw = openString(row.value)
  if (!raw) return null
  let parsed: { code?: unknown; at?: unknown; clientId?: unknown }
  try {
    parsed = JSON.parse(raw) as { code?: unknown; at?: unknown; clientId?: unknown }
  } catch {
    return null
  }
  if (typeof parsed.code !== 'string') return null
  if (typeof parsed.clientId === 'string' && parsed.clientId && parsed.clientId !== clientId) return null
  const at = typeof parsed.at === 'string' ? Date.parse(parsed.at) : NaN
  if (Number.isNaN(at) || Date.now() - at > 5 * 60_000) {
    await prisma.appSetting.delete({ where: { key: OTP_KEY } }).catch(() => {})
    return null
  }
  await prisma.appSetting.delete({ where: { key: OTP_KEY } }).catch(() => {})
  return parsed.code
}

export async function pollOtp(clientId: string, waitMs: number): Promise<string | null> {
  const deadline = Date.now() + waitMs
  for (;;) {
    const code = await takeWorkerOtp(clientId)
    if (code) return code
    const left = deadline - Date.now()
    if (left <= 0) return null
    await new Promise((resolve) => setTimeout(resolve, Math.min(1000, left)))
  }
}

/**
 * The security-code source for one browser run: a code pasted in Settings
 * first, then (for the first three minutes after GHL sent it) the newest
 * code in the agency inbox, checked at most every 8 seconds.
 */
export function makeOtpPuller(clientId: string, log: (line: string) => Promise<void>) {
  let codeSentAt = 0
  let lastImapAt = 0
  return {
    noteCodeSent(): void {
      if (!codeSentAt) codeSentAt = Date.now()
    },
    async pull(ms: number): Promise<string | null> {
      const pasted = await pollOtp(clientId, 0)
      if (pasted) return pasted
      const started = codeSentAt || Date.now()
      if (imapSettings() && Date.now() - started < 3 * 60 * 1000 && Date.now() - lastImapAt >= 8_000) {
        lastImapAt = Date.now()
        const notes: string[] = []
        try {
          const mailed = await fetchLatestSecurityCode(new Date(started), process.env, (line) => notes.push(line))
          if (notes.length) await log(notes.join('\n')).catch(() => {})
          if (mailed) return mailed
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          notes.push(`IMAP read failed: ${message.slice(0, 300)}`)
          await log(notes.join('\n')).catch(() => {})
          console.warn('[ghl-subaccount-worker] inbox read failed; waiting for a pasted code:', message)
        }
      }
      if (ms > 0) await new Promise((resolve) => setTimeout(resolve, ms))
      return null
    },
  }
}
