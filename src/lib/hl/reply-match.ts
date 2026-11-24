/**
 * Does a contact's text match a "Customer replied" trigger's phrases? Pure,
 * so the tests can load it (./automation.ts uses it for every reply).
 */

/** A reply as GHL compares it: lower case, no surrounding quotes or end punctuation. */
export const squashReply = (s: string) => s.trim().toLowerCase().replace(/^["'“”‘’]+|["'“”‘’.!?]+$/g, '').trim()

/**
 * Does the reply match one of the trigger's phrases? "exact" = the whole reply
 * is the phrase; "contains" = the phrase appears as whole words, so "no"
 * catches "No thanks" but not "I know".
 */
export function replyMatches(text: string, phrases: string[], match: 'contains' | 'exact' | undefined): boolean {
  const reply = squashReply(text)
  return phrases.some((p) => {
    const want = squashReply(p)
    if (!want) return false
    if (match === 'exact') return reply === want
    return new RegExp(`(^|[^a-z0-9])${want.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^a-z0-9])`).test(reply)
  })
}
