import { prisma } from '@/lib/prisma'
import { decryptSecret } from '@/lib/crypto'

/**
 * Credentials for the SEO engine, resolved from the Vault.
 *
 * Vault entry names are free text and people name things differently
 * ("Anthropic", "Anthropic API Key", "Claude key"…), so each secret is
 * found by a list of preferred exact names, then by a case-insensitive
 * name match — and a candidate only counts if its value has the shape of
 * that kind of key. The most recently updated match wins, so rotating a
 * key in /vault takes effect without touching code.
 *
 * Values never leave the server. Callers get the decrypted string; the
 * status helpers report presence and the entry name only.
 */

type Spec = {
  label: string
  exact: string[]
  /** Case-insensitive substrings to search entry names for. */
  contains: string[]
  /** Does the decrypted value look like this kind of secret? */
  looksRight: (value: string) => boolean
  env?: string
}

const SPECS = {
  anthropic: {
    label: 'Anthropic API key',
    exact: ['Anthropic API Key', 'Anthropic', 'Claude API Key', 'ANTHROPIC_API_KEY'],
    contains: ['anthropic', 'claude'],
    looksRight: (v) => v.startsWith('sk-ant-'),
    env: 'ANTHROPIC_API_KEY',
  },
  github: {
    label: 'GitHub token',
    exact: ['GitHub Token', 'GitHub SEO Token', 'GitHub PAT', 'Github Token', 'GITHUB_TOKEN'],
    contains: ['github'],
    looksRight: (v) => /^(github_pat_|ghp_|gho_|ghu_|ghs_)/.test(v),
  },
  googleApiKey: {
    label: 'Google API key (PageSpeed)',
    exact: ['Google API Key', 'PageSpeed API Key', 'Google PageSpeed Key', 'Google Maps Key'],
    contains: ['pagespeed', 'google api', 'google maps'],
    looksRight: (v) => v.startsWith('AIza'),
  },
  gscServiceAccount: {
    label: 'Search Console service account',
    exact: [
      'Google Search Console Service Account',
      'Search Console Service Account',
      'GSC Service Account',
    ],
    contains: ['search console', 'service account', 'gsc'],
    looksRight: (v) => {
      try {
        const j = JSON.parse(v) as { client_email?: unknown; private_key?: unknown }
        return typeof j.client_email === 'string' && typeof j.private_key === 'string'
      } catch {
        return false
      }
    },
  },
  lovable: {
    label: 'Lovable API key',
    exact: ['Lovable API Key', 'Lovable'],
    contains: ['lovable'],
    looksRight: (v) => v.startsWith('lov_'),
  },
} satisfies Record<string, Spec>

export type SecretKind = keyof typeof SPECS

export type ResolvedSecret = { value: string; source: 'vault' | 'env'; entryName: string | null }

const CACHE_MS = 5 * 60_000
/** A missing key is re-checked quickly, so adding it in /vault takes effect almost at once. */
const MISS_CACHE_MS = 15_000
const cache = new Map<SecretKind, { at: number; secret: ResolvedSecret | null }>()

async function resolve(kind: SecretKind): Promise<ResolvedSecret | null> {
  const hit = cache.get(kind)
  if (hit && Date.now() - hit.at < (hit.secret ? CACHE_MS : MISS_CACHE_MS)) return hit.secret

  const spec: Spec = SPECS[kind]
  const entries = await prisma.vaultEntry.findMany({
    where: {
      OR: [
        ...spec.exact.map((name) => ({ name: { equals: name, mode: 'insensitive' as const } })),
        ...spec.contains.map((part) => ({ name: { contains: part, mode: 'insensitive' as const } })),
      ],
    },
    select: { id: true, name: true, ciphertext: true, nonce: true, updatedAt: true },
    orderBy: { updatedAt: 'desc' },
    take: 20,
  })

  const rank = (name: string) => {
    const i = spec.exact.findIndex((e) => e.toLowerCase() === name.toLowerCase())
    return i === -1 ? spec.exact.length : i
  }
  // Exact names first (in preference order), then newest.
  entries.sort((a, b) => rank(a.name) - rank(b.name) || b.updatedAt.getTime() - a.updatedAt.getTime())

  let secret: ResolvedSecret | null = null
  for (const e of entries) {
    let value: string
    try {
      value = decryptSecret(e.ciphertext, e.nonce).trim()
    } catch {
      continue
    }
    if (!value || !spec.looksRight(value)) continue
    secret = { value, source: 'vault', entryName: e.name }
    await prisma.vaultEntry
      .update({ where: { id: e.id }, data: { lastUsedAt: new Date() } })
      .catch(() => {})
    break
  }

  if (!secret && spec.env) {
    const v = process.env[spec.env]?.trim()
    if (v && spec.looksRight(v)) secret = { value: v, source: 'env', entryName: null }
  }

  cache.set(kind, { at: Date.now(), secret })
  return secret
}

/** The secret's value, or null when it isn't configured. */
export async function getSecret(kind: SecretKind): Promise<string | null> {
  return (await resolve(kind))?.value ?? null
}

/** The secret's value, or a thrown error naming what to add to the Vault. */
export async function requireSecret(kind: SecretKind): Promise<string> {
  const s = await resolve(kind)
  if (!s) {
    const spec: Spec = SPECS[kind]
    throw new Error(`${spec.label} is not configured. Add a Vault entry named "${spec.exact[0]}".`)
  }
  return s.value
}

/** Presence and origin only — safe to send to the browser. */
export async function describeSecret(kind: SecretKind): Promise<{ present: boolean; source: 'vault' | 'env' | null; entryName: string | null }> {
  try {
    const s = await resolve(kind)
    return { present: !!s, source: s?.source ?? null, entryName: s?.entryName ?? null }
  } catch {
    return { present: false, source: null, entryName: null }
  }
}

/** The vault entry name a person should create for this secret. */
export function preferredEntryName(kind: SecretKind): string {
  return SPECS[kind].exact[0]
}

/** Drop cached lookups — call after someone edits the Vault. */
export function clearSecretCache(): void {
  cache.clear()
}
