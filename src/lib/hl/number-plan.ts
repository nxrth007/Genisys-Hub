/**
 * The decisions behind a client's Hell-level toll-free number, pure so they
 * are unit-tested: whether Echo asks in the Office, where the number's calls
 * ring, and whether its texting verification can be filed yet. The work
 * itself is in ./number-request.ts.
 */
import { toE164 } from './phone'

/** "+18556762067" → "(855) 676-2067"; anything else comes back as it was. */
export function prettyPhone(n: string | null | undefined): string {
  const d = (n ?? '').replace(/\D/g, '').replace(/^1(?=\d{10}$)/, '')
  return d.length === 10 ? `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}` : (n ?? '')
}

export type AskCandidate = {
  archived: boolean
  /** The client's Hell-level sub-account. */
  accountId: string | null
  accountCreatedAt: Date | null
  /** That sub-account already has an active toll-free number. */
  hasTollFree: boolean
  /** This client's request, if any. */
  request: { status: string } | null
  /** When asking started: sub-accounts made before it are only asked about by hand. */
  since: Date
  trigger: 'onboarding' | 'sweep' | 'manual'
}

export type AskDecision = { ask: boolean; reason: string }

/**
 * Echo asks once per client, right after onboarding made their sub-account.
 * Older sub-accounts, and a client someone already answered No for, are only
 * asked again by hand.
 */
export function askDecision(c: AskCandidate): AskDecision {
  if (c.archived) return { ask: false, reason: 'the client is archived' }
  if (!c.accountId) return { ask: false, reason: 'no Hell-level sub-account yet' }
  if (c.hasTollFree) return { ask: false, reason: 'its sub-account already has a toll-free number' }
  const r = c.request?.status
  if (r === 'awaiting_approval' || r === 'buying') return { ask: false, reason: 'already asked' }
  if (r === 'bought') return { ask: false, reason: 'it already has its number' }
  if (c.trigger !== 'manual') {
    if (r === 'declined') return { ask: false, reason: 'someone answered No' }
    if (r) return { ask: false, reason: 'the last try failed; a person picks it up' }
  }
  // Onboarding just made the sub-account; the sweep only picks up ones made since asking began.
  if (c.trigger === 'sweep' && (!c.accountCreatedAt || c.accountCreatedAt.getTime() < c.since.getTime())) {
    return { ask: false, reason: 'its sub-account is older than the number question' }
  }
  return { ask: true, reason: 'its sub-account is ready' }
}

/**
 * Where the number's calls ring: the business phone leads are told to call,
 * else the owner's notification phone. Null leaves it a missed-call catcher
 * (every call to it counts as missed and gets the text-back).
 */
export function ringTo(p: { businessPhone?: string | null; notifyPhone?: string | null }): string | null {
  return toE164(p.businessPhone) ?? toE164((p.notifyPhone ?? '').split(',')[0]) ?? null
}

export type FileCandidate = {
  siteUrl: string | null
  numberActive: boolean
  kind: string | null
  /** HlPhoneNumber.verificationStatus: none | pending | in_review | approved | rejected */
  verificationStatus: string | null
}

/**
 * Texting verification goes in once the client's site link is in: Twilio's
 * reviewers check the site's opt-in form and its privacy and terms pages.
 * A rejected one is left for a person to fix and re-file in Hell-level.
 */
export function readyToFile(c: FileCandidate): { file: boolean; reason: string } {
  if (!c.numberActive) return { file: false, reason: 'no active number' }
  if (c.kind !== 'toll_free') return { file: false, reason: 'not a toll-free number' }
  if ((c.verificationStatus ?? 'none') !== 'none') return { file: false, reason: `its verification is ${c.verificationStatus}` }
  if (!c.siteUrl?.trim()) return { file: false, reason: 'waiting for the site link' }
  return { file: true, reason: 'the site is in' }
}

/** A blocked filing is tried again at most this often (the site or profile may have been fixed meanwhile). */
export const FILE_RETRY_MS = 6 * 60 * 60_000
