import { toE164 } from './phone'

/**
 * The business number as the owner's whole interface (Alex, 2026-11-24). What a text from the owner's
 * own phone means, and what they're told back. Pure: the tests load it; ./owner-text.ts does the work.
 *
 *   a photo                → onto their website's Recent Work (./work-photos.ts)
 *   DONE 555-123-4567 Jane → that customer gets the review request (the kit's Job Completed trigger)
 *   UNDO                   → the last DONE, within its 20-minute wait
 *   anything else          → sent to the lead they were last alerted about, from the business number
 *
 * Owners get these replies as texts, so they're short and plain ASCII (one cheap SMS segment).
 */

export type OwnerText =
  | { kind: 'done'; phone: string | null; firstName: string | null; lastName: string | null }
  | { kind: 'undo' }
  | { kind: 'photo'; caption: string }
  | { kind: 'help' }
  | { kind: 'reply'; text: string }
  | { kind: 'empty' }

const DONE_RE = /^(?:job\s+)?(?:done|finished|completed?)\b[\s:.,!-]*/i
const UNDO_RE = /^(?:undo|oops|never\s*mind|nevermind)[\s.!]*$/i
const HELP_RE = /^(?:help|\?|commands?|menu|info|options)\s*[.!?]*$/i
/** A US number however it's typed, for taking it out of the words around it. */
const PHONE_IN = /(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b/
/** "ok", "thanks", a thumbs-up: an acknowledgement of the Hub's own confirmation, not something for a lead. */
const ACK_RE = /^(?:ok(?:ay)?|kk?|thanks?|thank you|thx|ty|great|got it|cool|perfect|sounds good|nice|awesome|yep|yup|will do|\u{1F44D}|\u{1F44C}|\u{1F64F})[\s.!]*$/iu
const clean = (s: string) => s.replace(/\s+/g, ' ').trim()

/** "jane", "JANE DOE" → Jane, Doe. Letters only; a word that isn't a name is dropped. */
export function nameWords(s: string): { firstName: string | null; lastName: string | null } {
  const words = s
    .replace(/[^\p{L}\s'’-]/gu, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 1 && !/^(?:for|and|the|at|to|from|job|done|finished|complete|completed|customer|client|name|phone|cell|number|review|request|please|pls|mr|mrs|ms)$/i.test(w))
    .slice(0, 2)
    .map((w) => (w === w.toUpperCase() || w === w.toLowerCase() ? w.charAt(0).toUpperCase() + w.slice(1).toLowerCase() : w))
  return { firstName: words[0] ?? null, lastName: words[1] ?? null }
}

/** The caption to keep with a photo: what they typed with it, tidied, short. */
export function captionOf(body: string): string {
  const t = clean(body).replace(/^(?:caption|photo|pic|picture|image)\s*[:-]\s*/i, '')
  if (!t || /^(?:photo|pic|picture|image|here|here you go|job|done)s?\s*[.!]*$/i.test(t)) return ''
  return t.length > 140 ? `${t.slice(0, 139).replace(/\s+\S*$/, '')}…` : t
}

/**
 * DONE is only ever the keyword, the customer's number and a name or two: "Done, call Jane at
 * 555-123-4567 to schedule the walkthrough" is an answer to a lead, not a finished job.
 */
function readDone(rest: string): Extract<OwnerText, { kind: 'done' }> | null {
  const m = rest.match(PHONE_IN)
  const phone = m ? toE164(m[0]) : null
  const around = clean(rest.replace(PHONE_IN, ' '))
  const words = around.split(' ').filter(Boolean)
  if (/\d/.test(around) || words.length > 3) return null
  if (!phone && words.length > 2) return null
  return { kind: 'done', phone, ...nameWords(around) }
}

export function readOwnerText(body: string, mediaCount: number): OwnerText {
  const t = clean(body)
  if (DONE_RE.test(t)) {
    const done = readDone(t.replace(DONE_RE, ''))
    // "Done" with a photo and no number is the photo, captioned with what they wrote.
    if (done && !done.phone && mediaCount > 0) return { kind: 'photo', caption: /^done\b/i.test(t) ? captionOf(t.replace(DONE_RE, '')) : captionOf(t) }
    if (done) return done
  }
  if (mediaCount > 0) return { kind: 'photo', caption: captionOf(t) }
  if (!t) return { kind: 'empty' }
  if (UNDO_RE.test(t)) return { kind: 'undo' }
  if (HELP_RE.test(t)) return { kind: 'help' }
  return { kind: 'reply', text: t }
}

export const isAck = (text: string) => ACK_RE.test(clean(text))

/** A reply is for the lead they were last told about this recently. */
export const REPLY_WINDOW_MS = 48 * 3_600_000
/** Told about two different leads this close together, a reply could be for either. */
export const TWO_LEADS_MS = 10 * 60_000
/** "ok" this soon after the Hub's own confirmation is for the Hub, not the lead. */
export const ACK_WINDOW_MS = 2 * 60_000
/** DONE can be undone while the review request is still waiting (the kit's 20-minute wait). */
export const UNDO_WINDOW_MS = 20 * 60_000

export type OwnerAlertView = { contactId: string; at: string; prev?: { contactId: string; at: string } | null; confirmedAt?: string | null }

export type ReplyTarget =
  | { byPhone: string; text: string }
  | { contactId: string; text: string }
  /** Two leads just now: the owner says which, with the number first. */
  | { which: [string, string] }
  /** An "ok" to the Hub's own confirmation: nothing to send. */
  | { ack: true }
  | null

/**
 * Who a reply goes to: a number they put first ("555-123-4567: on my way", "to (555) 123-4567 ..."),
 * else the lead they were last alerted about, if that was recent and not one of two in quick succession.
 */
export function pickReplyTarget(alert: OwnerAlertView | null | undefined, text: string, now: Date): ReplyTarget {
  const m = text.match(/^(?:to\s+)?((?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4})\s*[:\-–,]?\s*([\s\S]+)$/)
  const phone = m ? toE164(m[1]) : null
  if (m && phone && clean(m[2])) return { byPhone: phone, text: clean(m[2]) }
  if (!alert || now.getTime() - Date.parse(alert.at) > REPLY_WINDOW_MS) return null
  if (isAck(text) && alert.confirmedAt && now.getTime() - Date.parse(alert.confirmedAt) <= ACK_WINDOW_MS) return { ack: true }
  const p = alert.prev
  if (p && p.contactId !== alert.contactId && now.getTime() - Date.parse(alert.at) <= TWO_LEADS_MS && now.getTime() - Date.parse(p.at) <= TWO_LEADS_MS) return { which: [alert.contactId, p.contactId] }
  return { contactId: alert.contactId, text }
}

// ---------------------------------------------------------------------------
// What the owner is told
// ---------------------------------------------------------------------------

const who = (name: string | null, phone: string | null) => name?.trim() || prettyPhone(phone) || 'the customer'

/** "(555) 123-4567" for a US number; blank for none. */
export function prettyPhone(n: string | null | undefined): string {
  const d = (n ?? '').replace(/\D/g, '').replace(/^1(?=\d{10}$)/, '')
  return d.length === 10 ? `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}` : ''
}

export const DONE_NEEDS_PHONE = "To ask a customer for a review, text DONE and their cell, like: DONE 555-123-4567 Jane"

export function doneReply(o: { name: string | null; phone: string | null; business: string; started: boolean; inIt: boolean; ready: boolean }): string {
  const w = who(o.name, o.phone)
  if (!o.ready) return `Saved: ${w} is marked as a finished job, but ${o.business}'s number isn't approved for texting yet, so no review request goes out. Text DONE again once texting is approved.`
  if (o.inIt) return `${w} is already getting ${o.business}'s review request.`
  if (!o.started) return `Saved: ${w} is marked as a finished job, but the review request couldn't start on our side. We're on it.`
  return `Got it. ${w} gets ${o.business}'s review request in about 20 minutes, then a reminder or two. Reply UNDO in the next 20 minutes to stop it.`
}

export const DONE_OWN_NUMBER = "That's your own number. Text DONE and the customer's cell, like: DONE 555-123-4567 Jane"

export function undoReply(o: { undone: boolean; name: string | null; phone: string | null }): string {
  return o.undone ? `Undone: ${who(o.name, o.phone)} won't get the review request.` : 'Nothing to undo: the last review request already went out, or there wasn\'t one.'
}

export function photoReply(o: { added: number; skipped: number; failed: number; link: string; onSite: boolean }): string {
  if (!o.added) {
    if (o.failed) return "Sorry, that photo didn't come through on our side. Send it again?"
    return o.skipped ? "Photos only: that file isn't one I can show. Send a photo of the job and it goes on your website." : 'Nothing came through. Send the photo again?'
  }
  const n = o.added === 1 ? 'Your photo is' : `${o.added} photos are`
  const where = o.onSite ? 'on your website now' : 'in your Recent Work'
  const left = [o.skipped ? `${o.skipped} file${o.skipped === 1 ? '' : 's'} skipped: photos only` : '', o.failed ? `${o.failed} didn't come through, send ${o.failed === 1 ? 'it' : 'them'} again` : ''].filter(Boolean).join('; ')
  return `Got it. ${n} ${where}: ${o.link}${left ? ` (${left}.)` : ''}`
}

export const PHOTO_WITH_DONE = ' Your photo is in your Recent Work too.'

export const relayReply = (name: string | null, phone: string | null) => `Sent to ${who(name, phone)}.`

export function relayCannot(o: { name: string | null; phone: string | null; reason: string; notApproved: boolean }): string {
  const w = who(o.name, o.phone)
  if (o.notApproved) return `Can't send from your business number yet (texting approval pending). Reply to ${w} directly${prettyPhone(o.phone) ? ` at ${prettyPhone(o.phone)}` : ''}.`
  return `Not sent to ${w}: ${o.reason}`
}

export function whichLead(a: { name: string | null; phone: string | null }, b: { name: string | null; phone: string | null }): string {
  const one = (x: typeof a) => (x.name?.trim() ? `${x.name.trim()} ${prettyPhone(x.phone)}`.trim() : prettyPhone(x.phone) || 'a lead')
  return `Two leads just now: ${one(a)} and ${one(b)}. Put their number first so I know who, like: 555-123-4567: on my way`
}

export const NO_LEAD_TO_ANSWER = "No recent lead to answer. Text DONE + a customer's cell for a review request, or a job photo for your website."
export const NO_SUCH_LEAD = "No lead with that number here. Reply to a lead alert to answer them, or text DONE + their cell for a review request."
export const WHICH_BUSINESS = "This phone is on more than one business, so I can't tell which this is for. Text your business's own number instead."

export function helpText(business: string): string {
  return `${business} on Genisys: text a job photo and it goes on your website. Text DONE 555-123-4567 Jane to ask a customer for a review. Reply to a lead alert to answer them from your business number.`
}
