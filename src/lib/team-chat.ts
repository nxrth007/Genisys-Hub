/**
 * Helper constants + role-gate shared between the chat API routes.
 * Centralizes the "who can see/send chat messages" decision so the
 * three route files (list, send, attachment-serve) stay in lockstep.
 */

/** Roles that can read AND post in the Team #1 chat:
 *   - team_member: Mary's offshore agents (the primary audience)
 *   - admin / member: Alex + Ethan supervising
 *  Mary herself signs in as role=agent and is intentionally
 *  excluded here — she has her own surfaces. */
export const CHAT_ALLOWED_ROLES: ReadonlySet<string> = new Set([
  'team_member',
  'admin',
  'member',
])

/** v1 ships with one channel keyed by this slug. The migration
 *  seeds the row with id='chat-channel-team-1-general'. */
export const TEAM_1_CHANNEL_SLUG = 'team-1-general'

/** Cap per chat photo. Smaller than the 25 MB Documents cap
 *  because chat churns faster + the bytea footprint on Render
 *  Starter Postgres tier matters. iOS Safari users may need to
 *  export-to-JPEG once if their original is HEIC > 5 MB. */
export const CHAT_PHOTO_MAX_BYTES = 5 * 1024 * 1024

/** JPEG + PNG only for v1. HEIC is excluded intentionally — see
 *  the gotchas list in the scoping plan. */
export const CHAT_PHOTO_ALLOWED_MIMES: ReadonlySet<string> = new Set([
  'image/png',
  'image/jpeg',
])

/** Days a chat photo lives before the scheduler tick deletes it.
 *  Text messages stay forever; only the bytea attachments are
 *  pruned. 30d per Alex's spec. */
export const CHAT_PHOTO_EXPIRY_DAYS = 30
