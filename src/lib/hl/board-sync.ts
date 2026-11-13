/**
 * The Automation Copy board → a client's Hell-level Business Profile (pure;
 * the saving is syncProfileFromBoard in ./accounts.ts).
 *
 * A sub-account copies the board once, when onboarding makes it. After that,
 * a save on the board carries over what that save changed (Alex, 2026-11-13),
 * so a corrected owner name or phone reaches the texts. Anything typed in
 * Hell-level itself stays until the same detail is changed on the board.
 */

/** Board detail → Business Profile field (the same pairs the first copy uses). */
export const BOARD_TO_PROFILE = {
  businessName: 'businessName',
  ownerFirstName: 'ownerFirstName',
  ownerFullName: 'ownerName',
  quoteLink: 'website',
  phone: 'businessPhone',
  notifyEmail: 'notifyEmail',
} as const

export type BoardKey = keyof typeof BOARD_TO_PROFILE
export type ProfileKey = (typeof BOARD_TO_PROFILE)[BoardKey]

/**
 * The profile fields a board save changed: each detail whose value differs
 * after the save, unless it's now blank (clearing a detail on the board
 * leaves Hell-level's) or `ok` turns it down (not a real business name or
 * email, say).
 */
export function boardProfileChanges(
  before: Partial<Record<BoardKey, string>>,
  after: Partial<Record<BoardKey, string>>,
  ok: (key: BoardKey, value: string) => boolean = () => true,
): Partial<Record<ProfileKey, string>> {
  const out: Partial<Record<ProfileKey, string>> = {}
  for (const key of Object.keys(BOARD_TO_PROFILE) as BoardKey[]) {
    const was = (before[key] ?? '').replace(/\s+/g, ' ').trim()
    const now = (after[key] ?? '').replace(/\s+/g, ' ').trim()
    if (!now || now === was || !ok(key, now)) continue
    out[BOARD_TO_PROFILE[key]] = now
  }
  return out
}
