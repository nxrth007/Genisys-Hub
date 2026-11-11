/**
 * Standalone loop for a Render worker that is not the Hub web service.
 *
 *   GHL_SUBACCOUNT_WORKER_ENABLED=1
 *   GHL_SUBACCOUNT_WORKER_RUN=1
 *   npx tsx scripts/ghl-subaccount-worker.ts
 *
 * The Hub web process should then set GHL_SUBACCOUNT_WORKER_RUN=0 so
 * it still enqueues submissions but does not launch a second browser.
 * Leases make two runners safe; they would still fight over one GHL login.
 */
import 'dotenv/config'
import { runGhlSubaccountWorkerTick } from '../src/lib/ghl-subaccount-worker/queue'

const intervalMs = Math.max(5_000, Number(process.env.GHL_SUBACCOUNT_WORKER_POLL_MS) || 15_000)

async function main() {
  console.log('[ghl-subaccount-worker] loop started')
  for (;;) {
    const began = Date.now()
    try {
      const result = await runGhlSubaccountWorkerTick()
      if (result.claimed || result.enqueued || result.outcome) {
        console.log(`[ghl-subaccount-worker] ${JSON.stringify(result)}`)
      }
    } catch (err) {
      console.error('[ghl-subaccount-worker] tick failed:', err)
    }
    const wait = Math.max(1_000, intervalMs - (Date.now() - began))
    await new Promise((resolve) => setTimeout(resolve, wait))
  }
}

void main()
