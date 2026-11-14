/**
 * What a client's folder in Sites offers, the Office's questions answered from the folder (Alex,
 * 2026-11-14): pick a domain from Porkbun's suggestions, buy their Hell-level toll-free number,
 * build their website. Each press is the person's Yes (it spends money), so the folder confirms
 * the price first; the Office keeps asking the same questions for clients nobody opened.
 *
 * Pure (tests load it): src/lib/sites.ts decides with it, src/lib/hl/folder-actions.ts acts.
 */
import type { DomainChoice } from './domain-plan'

/** Forge's build is under way: nothing to press until it stops (built, failed, live). */
const BUILD_BUSY = ['filling', 'copying', 'sending', 'building', 'waiting_on_lovable', 'publishing', 'connecting']
/** Live on lovable.app or their domain: not built again from the folder (Lovable keeps the copy). */
const BUILD_LIVE = ['published', 'connected']

export type FolderBuild =
  | {
      kind: 'build'
      /** Their GHL sub-account is linked: the site gets Hell-level's form and chat anyway. */
      overrideGhl: boolean
      /** A copy exists (built, Not now, failed): a new one is made; the earlier stays in Lovable. */
      again: boolean
      /** Forge's question is open in the Office: pressing here answers it. */
      answersOffice: boolean
    }
  | { kind: 'none'; reason: string }

export function folderBuild(f: { hasAccount: boolean; ghlLinked: boolean; status: string | null }): FolderBuild {
  if (!f.hasAccount) return { kind: 'none', reason: 'They have no Hell-level sub-account, which the site’s form and chat need.' }
  const s = f.status
  if (s && BUILD_BUSY.includes(s)) return { kind: 'none', reason: 'Forge is working on it.' }
  if (s && BUILD_LIVE.includes(s)) return { kind: 'none', reason: 'Their site is live. Change it in Lovable’s builder.' }
  return { kind: 'build', overrideGhl: f.ghlLinked, again: !!s && s !== 'awaiting_approval' && s !== 'declined', answersOffice: s === 'awaiting_approval' }
}

export type FolderNumber = { kind: 'buy'; answersOffice: boolean } | { kind: 'none'; reason: string }

/**
 * A Hell-level toll-free number, bought on Genisys's Twilio. Not for a client who has one, nor one
 * whose GHL sub-account has a number (Alex's rule: set up in GHL already), nor while GHL's route
 * (an ID check, then the browser worker) is under way.
 */
export function folderNumber(f: { hasAccount: boolean; hasTollFree: boolean; ghlHasNumber: boolean; status: string | null }): FolderNumber {
  if (!f.hasAccount) return { kind: 'none', reason: 'They have no Hell-level sub-account to put a number on.' }
  if (f.hasTollFree) return { kind: 'none', reason: 'They have their toll-free number.' }
  if (f.ghlHasNumber) return { kind: 'none', reason: 'Their GHL sub-account already has a number, so it’s set up in GHL.' }
  const s = f.status
  if (s === 'buying') return { kind: 'none', reason: 'Buying it now.' }
  if (s === 'bought') return { kind: 'none', reason: 'It was bought.' }
  if (s === 'awaiting_identity') return { kind: 'none', reason: 'GHL was chosen: finish GHL’s ID check, then press Identification complete in the Office.' }
  if (s === 'ghl_working') return { kind: 'none', reason: 'The worker is getting the number in GHL.' }
  return { kind: 'buy', answersOffice: s === 'awaiting_approval' }
}

export type FolderDomain =
  /** No suggestions yet (or the last ones were dropped): ask Porkbun for three. */
  | { kind: 'find' }
  /** Forge's three: pick one to buy, or ask again. */
  | { kind: 'choose'; choices: DomainChoice[] }
  | { kind: 'none'; reason: string }

export function folderDomain(f: { hasAccount: boolean; hasDomain: boolean; status: string | null; choices: DomainChoice[]; buying: string | null }): FolderDomain {
  if (!f.hasAccount) return { kind: 'none', reason: 'They have no Hell-level sub-account to hold a domain.' }
  if (f.hasDomain) return { kind: 'none', reason: 'Their domain is in Hell-level → Domains.' }
  if (f.status === 'buying') return { kind: 'none', reason: `Buying ${f.buying ?? 'it'} now.` }
  if (f.status === 'awaiting_approval' && f.choices.length) return { kind: 'choose', choices: f.choices }
  return { kind: 'find' }
}
