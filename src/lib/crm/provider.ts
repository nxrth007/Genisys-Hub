/**
 * A small CRM seam so the fulfillment pipeline doesn't talk to GHL
 * directly. Only the calls the journey work touches live here; the GHL
 * implementation delegates to the existing ghl.ts / ghl-agency.ts code.
 */
import { GHL_AGENCY_KEY_VAULT_NAME, upsertContactByEmail } from '../ghl'
import { getAgencyContext, getLocation, GhlAgencyError, listAllLocations } from '../ghl-agency'

export type CrmContactInput = Parameters<typeof upsertContactByEmail>[1]
export type CrmContactResult = { id: string; created: boolean; skippedFields: string[]; credential: string }
export type CrmLocation = { id: string; name: string; phone?: string | null; email?: string | null }

export interface CrmProvider {
  readonly name: string
  /**
   * Upsert a contact by email. Tries each credential (Vault entry name) in
   * order and returns the first success; throws the last error if all fail.
   */
  upsertContactByEmail(credentials: string[], input: CrmContactInput): Promise<CrmContactResult>
  /** Look up a sub-account / location in the agency; null when it doesn't exist. */
  getLocation(locationId: string): Promise<CrmLocation | null>
  /** Every sub-account / location in the agency (read-only). */
  listLocations(): Promise<{ locations: CrmLocation[]; truncated: boolean }>
  /** True when an error means the plan or key refuses the call (retrying won't help). */
  isPermissionError(err: unknown): boolean
}

export const ghlProvider: CrmProvider = {
  name: 'ghl',
  async upsertContactByEmail(credentials, input) {
    let lastErr: unknown = new Error('no CRM credential given')
    for (const credential of credentials) {
      try {
        const res = await upsertContactByEmail(credential, input)
        return { ...res, credential }
      } catch (err) {
        lastErr = err
        console.warn(`[crm:ghl] upsertContactByEmail with "${credential}" failed:`, err instanceof Error ? err.message.slice(0, 300) : err)
      }
    }
    throw lastErr
  },
  async getLocation(locationId) {
    const loc = await getLocation(await getAgencyContext(), locationId)
    return loc ? { id: loc.id, name: loc.name } : null
  },
  async listLocations() {
    return listAllLocations(await getAgencyContext())
  },
  isPermissionError(err) {
    return err instanceof GhlAgencyError && (err.status === 401 || err.status === 403)
  },
}

export { GHL_AGENCY_KEY_VAULT_NAME }

export function getCrmProvider(): CrmProvider {
  return ghlProvider
}
