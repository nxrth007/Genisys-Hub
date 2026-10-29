import { prisma } from '@/lib/prisma'
import { getSecretByName } from '@/lib/vault-service'
import { sendSmsToPhone } from '@/lib/ghl'
import { hubLink } from '@/lib/hub-alerts'
import { RENDER_VAULT_NAME } from '@/lib/render'
import { TEAM_ALERT_PHONES } from '@/lib/team-sms'
import { runRenderMonitor, type MonitorResult, type MonitorState } from '@/lib/render-monitor'

/**
 * Hub wiring for lib/render-monitor.ts: Vault key, AppSetting state, and texts
 * to Ethan only (internal ops alerts) on the same GHL line as the
 * "New client onboarded!" / Whop texts. Env:
 *   RENDER_MONITOR_ENABLED=1            turn the 5-minute check on (off by default)
 *   RENDER_MONITOR_SERVICE_ID=srv-…     optional; else the service named below
 *   RENDER_MONITOR_SERVICE_NAME         default "genisys-hub"
 *   RENDER_MONITOR_VAULT_ENTRY          default "Render API Key"
 *   RENDER_MONITOR_WINDOW_MINUTES       default 10
 *   RENDER_MONITOR_ALERT_TO             default "Ethan" (a TEAM_ALERT_PHONES name)
 */
const STATE_KEY = 'render.monitor'
const EVERY_MS = 5 * 60_000

export const renderMonitorEnabled = () => process.env.RENDER_MONITOR_ENABLED === '1'

export async function renderMonitorOnce(opts: { dryRun?: boolean } = {}): Promise<MonitorResult> {
  const apiKey = (await getSecretByName(process.env.RENDER_MONITOR_VAULT_ENTRY?.trim() || RENDER_VAULT_NAME)).trim()
  const who = process.env.RENDER_MONITOR_ALERT_TO?.trim() || 'Ethan'
  const to = TEAM_ALERT_PHONES.find((p) => p.name.toLowerCase() === who.toLowerCase())
  return runRenderMonitor(
    {
      apiKey,
      serviceId: process.env.RENDER_MONITOR_SERVICE_ID?.trim() || null,
      serviceName: process.env.RENDER_MONITOR_SERVICE_NAME?.trim() || 'genisys-hub',
      healthUrl: hubLink('/api/health'),
      windowMinutes: Number(process.env.RENDER_MONITOR_WINDOW_MINUTES) || 10,
      now: Date.now,
      fetch,
      loadState: async () => {
        const row = await prisma.appSetting.findUnique({ where: { key: STATE_KEY } })
        return row ? (JSON.parse(row.value) as MonitorState) : null
      },
      saveState: async (s) => {
        const value = JSON.stringify(s)
        await prisma.appSetting.upsert({ where: { key: STATE_KEY }, create: { key: STATE_KEY, value }, update: { value } })
      },
      sendText: async (text) => {
        if (!to) return false
        await sendSmsToPhone('GHL Genisys Token', { phone: to.phone, message: text, firstName: to.name })
        return true
      },
    },
    opts,
  )
}

let lastRun = 0
let inFlight = false

/** Scheduler hook: every 5 minutes, live Hub only, when enabled. */
export async function maybeRunRenderMonitor(): Promise<MonitorResult | null> {
  if (!renderMonitorEnabled() || process.env.NODE_ENV !== 'production') return null
  if (inFlight || Date.now() - lastRun < EVERY_MS) return null
  lastRun = Date.now()
  inFlight = true
  try {
    return await renderMonitorOnce()
  } finally {
    inFlight = false
  }
}
