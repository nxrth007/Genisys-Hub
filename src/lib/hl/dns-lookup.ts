/**
 * Public DNS, read over HTTPS (Cloudflare's resolver): who runs a domain's
 * DNS, and whether the records a connection needs are live yet. For
 * domains registered elsewhere (GHL's "External Domains"), where the Hub
 * can only tell the person what to add and check it.
 */

type Answer = { name: string; type: number; data: string }

const TYPE_CODE: Record<string, number> = { A: 1, NS: 2, CNAME: 5, MX: 15, TXT: 16, AAAA: 28 }

export async function resolve(name: string, type: keyof typeof TYPE_CODE): Promise<string[]> {
  const res = await fetch(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(name)}&type=${type}`, {
    headers: { accept: 'application/dns-json' },
    signal: AbortSignal.timeout(8000),
    cache: 'no-store',
  })
  if (!res.ok) throw new Error(`DNS lookup failed (${res.status})`)
  const body = (await res.json()) as { Status: number; Answer?: Answer[] }
  return (body.Answer ?? [])
    .filter((a) => a.type === TYPE_CODE[type])
    .map((a) => (type === 'TXT' ? a.data.replace(/^"|"$/g, '').replace(/"\s+"/g, '') : a.data.toLowerCase().replace(/\.$/, '')))
}

/** Two-label endings that sit under a country code (acme.co.uk's domain is acme.co.uk, not co.uk). */
const SECOND_LEVEL = new Set(['co.uk', 'org.uk', 'me.uk', 'ltd.uk', 'plc.uk', 'com.au', 'net.au', 'org.au', 'co.nz', 'org.nz', 'com.br', 'co.za', 'com.mx', 'co.in', 'co.jp', 'com.sg'])

/** "try.leadgenisys.com" → { domain: "leadgenisys.com", host: "try" }. */
export function splitHost(name: string): { domain: string; host: string } {
  const labels = name.toLowerCase().replace(/\.$/, '').split('.')
  const take = labels.length >= 3 && SECOND_LEVEL.has(labels.slice(-2).join('.')) ? 3 : 2
  return { domain: labels.slice(-take).join('.'), host: labels.slice(0, -take).join('.') }
}

/** Nameserver hostnames → who they belong to, as GHL shows "DNS managed by NameCheap, Inc.". */
const PROVIDERS: [RegExp, string][] = [
  [/registrar-servers\.com$|namecheaphosting\.com$/, 'Namecheap'],
  [/domaincontrol\.com$/, 'GoDaddy'],
  [/\.ns\.cloudflare\.com$/, 'Cloudflare'],
  [/porkbun\.com$/, 'Porkbun'],
  [/awsdns-/, 'Amazon Route 53'],
  [/googledomains\.com$|ns-cloud-\w+\.googledomains\.com$/, 'Google'],
  [/squarespacedns\.com$/, 'Squarespace'],
  [/wixdns\.net$/, 'Wix'],
  [/name\.com$/, 'Name.com'],
  [/dynadot\.com$/, 'Dynadot'],
  [/hostgator\.com$/, 'HostGator'],
  [/bluehost\.com$/, 'Bluehost'],
  [/dreamhost\.com$/, 'DreamHost'],
  [/ui-dns\.(com|org|biz|de)$/, 'IONOS'],
  [/hover\.com$/, 'Hover'],
  [/nsone\.net$/, 'NS1'],
  [/azure-dns\./, 'Azure DNS'],
  [/vercel-dns\.com$/, 'Vercel'],
  [/netlify/, 'Netlify'],
  [/shopify/, 'Shopify'],
  [/lovable/, 'Lovable'],
  [/leadconnectorhq\.com$|msgsndr\.com$/, 'GoHighLevel'],
]

export async function dnsProvider(domain: string): Promise<{ provider: string | null; nameservers: string[] }> {
  const nameservers = await resolve(domain, 'NS')
  const provider = PROVIDERS.find(([re]) => nameservers.some((n) => re.test(n)))?.[1] ?? (nameservers.length ? nameservers[0].split('.').slice(-2).join('.') : null)
  return { provider, nameservers }
}
