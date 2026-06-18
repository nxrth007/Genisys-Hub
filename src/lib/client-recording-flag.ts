/**
 * Feature flag: are call-recording links exposed to CLIENTS?
 *
 * Controls the three client-facing recording surfaces — the client
 * Slack channel post, the client email alert, and the client
 * dashboard "Listen" button. Internal/admin/agent playback (Mary's
 * callbacks, the admin master tracker, etc.) goes through different
 * code paths and is NOT affected by this flag.
 *
 * Disabled by Alex 2026-06-17 ("doing more harm than good for now").
 * Reversible without a deploy: flip the AppSetting row
 * `clientRecordingLinks.enabled` to 'true'.
 *
 * Default when the row is absent is TRUE (preserve historical
 * behavior for any environment that never set it); the disable
 * migration writes an explicit 'false'. On a DB read error we bias
 * to FALSE — the stated intent is "don't expose recordings to
 * clients right now," so a transient blip must not re-expose them.
 */
import { prisma } from './prisma'

const KEY = 'clientRecordingLinks.enabled'

export async function clientRecordingLinksEnabled(): Promise<boolean> {
  try {
    const row = await prisma.appSetting.findUnique({ where: { key: KEY } })
    if (!row) return true
    return row.value === 'true'
  } catch (err) {
    console.error(
      '[client-recording-flag] read failed — biasing to OFF (clients see no recordings)',
      err,
    )
    return false
  }
}

export async function setClientRecordingLinksEnabled(
  enabled: boolean,
): Promise<void> {
  await prisma.appSetting.upsert({
    where: { key: KEY },
    create: { key: KEY, value: enabled ? 'true' : 'false' },
    update: { value: enabled ? 'true' : 'false' },
  })
}
