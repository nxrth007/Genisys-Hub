/**
 * The kit's "SMS Hard Opt Out -> Update Date - DND" workflow (A2P Compliance), as GHL's agency snapshot
 * has it, switched a lead's texting off when their reply CONTAINED "no", "stop" or "not interested" as a
 * word: "No problem, see you Tuesday", "Yes, no rush" and "Can you stop by Thursday?" all did, and from
 * then on every text to them was refused (follow-ups, reminders, the review request, the owner's own).
 * Alex, 2026-11-24: fix it on Genisys OS. Now only a reply that is nothing but an opt-out does it.
 *
 * A real STOP needs none of this: STOP, UNSUBSCRIBE and the like switch texting off before any workflow
 * runs (recordInboundSms in ./messages.ts), as carriers require. Pure (tests load it); the kit
 * (./client-kit.ts) and the one-time update of existing sub-accounts (./optout-fixes.ts) share it.
 */
import type { HlTrigger } from './types'

export const OPTOUT_TRIGGER_ID = 'kit_optout_reply'

/** Replies that switch texting off, matched against the WHOLE reply (case, quotes and end punctuation aside). */
export const OPTOUT_REPLIES = ['no', 'nope', 'no thanks', 'no thank you', 'no, thanks', 'no, thank you', 'not interested', 'stop']

/** The snapshot's words, matched anywhere in the reply: what an existing sub-account still has until updated. */
const SNAPSHOT_REPLIES = ['not interested', 'no', 'stop']

export function optoutReplyTrigger(): HlTrigger {
  return { id: OPTOUT_TRIGGER_ID, name: 'Customer replied only "No", "Not interested" or "Stop"', type: 'inbound_sms', keywords: [...OPTOUT_REPLIES], match: 'exact' }
}

const sameWords = (a: string[] | undefined, b: string[]) => {
  const x = (a ?? []).map((w) => w.trim().toLowerCase())
  return x.length === b.length && b.every((w) => x.includes(w))
}

/**
 * An existing opt-out workflow's triggers brought up to date. Only the snapshot's own reply trigger is
 * replaced (kept switched off if someone switched it off); one whose words someone changed, or a
 * workflow rebuilt without it, is left as it is.
 */
export function patchOptoutTriggers(triggers: HlTrigger[]): { changed: boolean; value: HlTrigger[]; note: string } {
  const i = triggers.findIndex((t) => t.id === OPTOUT_TRIGGER_ID)
  if (i === -1) return { changed: false, value: triggers, note: 'no reply trigger (rebuilt by hand): left as it is' }
  const t = triggers[i]
  if (t.match === 'exact' && sameWords(t.keywords, OPTOUT_REPLIES)) return { changed: false, value: triggers, note: 'already up to date' }
  if (t.type !== 'inbound_sms' || t.match !== 'contains' || !sameWords(t.keywords, SNAPSHOT_REPLIES)) return { changed: false, value: triggers, note: 'its reply words were changed by hand: left as they are' }
  const now = optoutReplyTrigger()
  return { changed: true, value: triggers.map((x, j) => (j === i ? (x.active === false ? { ...now, active: false } : now) : x)), note: 'updated' }
}
