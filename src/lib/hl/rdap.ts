/**
 * A domain's public registration record (RDAP, WHOIS's successor): which
 * registrar holds it, when it was registered and last transferred, and
 * whether it's locked. A domain can't move to another registrar until 60
 * days after the later of those two dates (GoHighLevel's rule too).
 */

type Rdap = {
  status?: string[]
  events?: { eventAction?: string; eventDate?: string }[]
  entities?: { roles?: string[]; vcardArray?: [string, [string, unknown, string, string][]] }[]
}

export type Registration = {
  registrar: string | null
  registeredAt: Date | null
  transferredAt: Date | null
  /** "client transfer prohibited": the registrar lock the current registrar lifts on request. */
  locked: boolean
  /** 60 days after it was registered or last transferred. */
  transferableFrom: Date | null
}

const DAY = 86_400_000

// IANA's list of which RDAP server answers for each TLD, kept for a day.
let servers: { at: number; byTld: Map<string, string> } | null = null

async function serverFor(tld: string): Promise<string | null> {
  if (!servers || Date.now() - servers.at > DAY) {
    const res = await fetch('https://data.iana.org/rdap/dns.json', { signal: AbortSignal.timeout(8000) })
    if (!res.ok) throw new Error(`RDAP directory unavailable (${res.status})`)
    const body = (await res.json()) as { services?: [string[], string[]][] }
    const byTld = new Map<string, string>()
    for (const [tlds, urls] of body.services ?? []) {
      const url = urls.find((u) => u.startsWith('https://')) ?? urls[0]
      if (url) for (const t of tlds) byTld.set(t.toLowerCase(), url.endsWith('/') ? url : `${url}/`)
    }
    servers = { at: Date.now(), byTld }
  }
  return servers.byTld.get(tld.toLowerCase()) ?? null
}

/** Null when the TLD has no RDAP server or the registry doesn't answer. */
export async function registration(domain: string): Promise<Registration | null> {
  const base = await serverFor(domain.split('.').pop() ?? '')
  if (!base) return null
  const res = await fetch(`${base}domain/${encodeURIComponent(domain)}`, {
    headers: { accept: 'application/rdap+json', 'user-agent': 'GenisysHub/1.0 (+https://genisys-hub.onrender.com)' },
    signal: AbortSignal.timeout(8000),
  })
  if (!res.ok) return null
  const body = (await res.json()) as Rdap
  const at = (action: string) => {
    const when = body.events?.find((e) => e.eventAction === action)?.eventDate
    return when ? new Date(when) : null
  }
  const registeredAt = at('registration')
  const transferredAt = at('transfer')
  const since = transferredAt && registeredAt && transferredAt > registeredAt ? transferredAt : (registeredAt ?? transferredAt)
  const registrar = body.entities?.find((e) => e.roles?.includes('registrar'))?.vcardArray?.[1]?.find((f) => f[0] === 'fn')?.[3] ?? null
  return {
    registrar,
    registeredAt,
    transferredAt,
    locked: (body.status ?? []).some((s) => /client transfer prohibited/i.test(s)),
    transferableFrom: since ? new Date(since.getTime() + 60 * DAY) : null,
  }
}
