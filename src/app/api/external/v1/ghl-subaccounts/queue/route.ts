import { NextRequest } from 'next/server'
import { withOwnerApi, externalOptions } from '@/lib/external-api'
import { extensionQueue, getGhlSubaccountSettings } from '@/lib/ghl-subaccount-provisioning'

/**
 * GET /api/external/v1/ghl-subaccounts/queue
 *
 * For the browser extension (tools/ghl-subaccount-extension): the new
 * clients that still need a GHL sub-account, with everything GHL's create
 * form asks for. Owner token only — it's what the automation would do,
 * done from a signed-in browser.
 */
export const GET = withOwnerApi(async () => {
  const settings = await getGhlSubaccountSettings()
  const jobs = settings.enabled ? await extensionQueue() : []
  return { enabled: settings.enabled, jobs }
})

export const OPTIONS = (req: NextRequest) => externalOptions(req)
