/**
 * Domain shapes the server and the Domains page share (no server imports).
 */

export const LOVABLE_IP = '185.158.133.1' // Lovable's edge, docs.lovable.dev/features/custom-domain

/** A host (the domain itself, or a subdomain) connected to a product, as GHL lists "Connected Products". */
export type HostConnection = {
  /** "" = the domain itself (with www), else the subdomain ("try"). */
  host: string
  product: 'site'
  /** Lovable's verification values. */
  txt?: string | null
  wwwTxt?: string | null
  addedAt: string
  verifiedAt?: string | null
  lastCheck?: { at: string; ok: boolean; a: string[]; txtOk: boolean } | null
}

export type DomainMeta = {
  porkbunNameservers?: string[]
  imported?: { created: number; skipped: number; failed: number }
  /** External domains: who runs their DNS. */
  provider?: string | null
  nameservers?: string[]
  hosts?: HostConnection[]
  /** Domains held here: addresses forwarding email, last seen. */
  emailForwards?: number
}

export const metaOf = (v: unknown): DomainMeta => (v && typeof v === 'object' && !Array.isArray(v) ? (v as DomainMeta) : {})

export const fqdnOf = (domain: string, host: string) => (host ? `${host}.${domain}` : domain)

export type SiteRecord = { type: 'A' | 'TXT'; host: string; value: string }

/** The records a host needs for the Lovable site: A to Lovable's IP (and www for the domain itself), plus Lovable's TXT values. */
export function siteRecords(c: Pick<HostConnection, 'host' | 'txt' | 'wwwTxt'>): SiteRecord[] {
  const at = c.host || '@'
  return [
    { type: 'A', host: at, value: LOVABLE_IP },
    ...(c.host ? [] : [{ type: 'A' as const, host: 'www', value: LOVABLE_IP }]),
    ...(c.txt ? [{ type: 'TXT' as const, host: c.host ? `_lovable.${c.host}` : '_lovable', value: c.txt }] : []),
    ...(!c.host && c.wwwTxt ? [{ type: 'TXT' as const, host: '_lovable.www', value: c.wwwTxt }] : []),
  ]
}
