/**
 * Hell-level became Genisys OS on 2026-11-16 (the name people read, and /hell-level → /genisys-os).
 * Pure (tests load it): the same change for text the Hub had already saved. ./rename-notes.ts runs it once.
 */

/** A saved note or link as it reads now: the old name and the old web path replaced, nothing else. */
export function renamedText(s: string): string {
  return s.split('Hell-level').join('Genisys OS').split('/hell-level').join('/genisys-os')
}

/** Whether a saved text still carries the old name or path (what the one-time rename looks for). */
export const OLD_NAME_PART = 'ell-level'
