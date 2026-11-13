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

/** The answers an Office number question takes: Hell-level, GHL, Identification complete, or No. */
export type NumberChoice = 'hl' | 'ghl' | 'identified' | 'no'

/**
 * Where an answer leads, or null when it doesn't fit the question's state.
 * Asked: Hell-level buys now, GHL waits for the ID check, No declines.
 * Waiting on the ID check: Identification complete hands it to the browser
 * worker; Hell-level and No still work (a change of mind).
 */
export function nextNumberState(status: string, choice: NumberChoice): string | null {
  if (status === 'awaiting_approval') return choice === 'hl' ? 'buying' : choice === 'ghl' ? 'awaiting_identity' : choice === 'no' ? 'declined' : null
  if (status === 'awaiting_identity') return choice === 'identified' ? 'ghl_working' : choice === 'hl' ? 'buying' : choice === 'no' ? 'declined' : null
  return null
}

/**
 * Where the number's calls ring: the business phone leads are told to call,
 * else the owner's notification phone. Null leaves it a missed-call catcher
 * (every call to it counts as missed and gets the text-back).
 */
export function ringTo(p: { businessPhone?: string | null; notifyPhone?: string | null }): string | null {
  return toE164(p.businessPhone) ?? toE164((p.notifyPhone ?? '').split(',')[0]) ?? null
}

/**
 * Where the number's texts are forwarded: the phone the owner gave on the
 * onboarding form (the notification phone, a cell), else the business phone.
 */
export function textsTo(p: { businessPhone?: string | null; notifyPhone?: string | null }): string | null {
  return toE164((p.notifyPhone ?? '').split(',')[0]) ?? toE164(p.businessPhone) ?? null
}

/** The owner's own phones for a number: texts from these are the owner, never a lead. */
export function ownerPhones(n: { forwardTo?: string | null; forwardTextsTo?: string | null }, p: { notifyPhone?: string | null; businessPhone?: string | null }): Set<string> {
  const out = new Set<string>()
  for (const raw of [n.forwardTo, n.forwardTextsTo, p.businessPhone, ...(p.notifyPhone ?? '').split(',')]) {
    const e = toE164(raw)
    if (e) out.add(e)
  }
  return out
}

/**
 * The forwarded copy of a lead's text, sent to the owner from the Hub's own
 * number. It says who wrote and how to answer: a reply to the Hub's number
 * doesn't reach the lead.
 */
export function forwardTextBody(o: { business: string; from: string; name?: string | null; body: string; media: number }): string {
  const who = `${o.name?.trim() ? `${o.name.trim()} ` : ''}${prettyPhone(o.from)}`
  const flat = o.body.replace(/\s+/g, ' ').trim()
  const text = flat.length > 220 ? `${flat.slice(0, 219)}…` : flat
  const extra = o.media ? ` (+${o.media} photo${o.media === 1 ? '' : 's'})` : ''
  const said = text ? `"${text}"${extra}` : extra.trim() || '(empty text)'
  return `${o.business}: new text from ${who}: ${said} Reply to them at ${prettyPhone(o.from)}.`
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

/** What a bought number's request should say once Twilio has answered its texting verification. */
export function rejectionNote(verificationNote: string | null | undefined): string {
  const why = (verificationNote ?? '').trim()
  return `Twilio rejected the texting verification${why ? `: ${why}` : ''}. Fix it and file it again in Hell-level → Settings → Phone Numbers.`
}

/**
 * Keep a bought request's note in step with its number's verification:
 * a rejection becomes the note (and a text); a re-filed or approved number
 * clears an old note. A note from a filing that couldn't go in yet (status
 * still none) stays until the filing works.
 */
export function reconcileVerify(c: { verificationStatus: string | null; verificationNote: string | null; currentNote: string | null }): { note: string | null; text: boolean } | null {
  const status = c.verificationStatus ?? 'none'
  if (status === 'rejected') {
    const note = rejectionNote(c.verificationNote)
    return c.currentNote === note ? null : { note, text: true }
  }
  if (c.currentNote && (status === 'pending' || status === 'in_review' || status === 'approved')) return { note: null, text: false }
  return null
}
