/**
 * Shared "which client owns this appointment row?" brain.
 *
 * Two callers consume this:
 *   1. Master Tracker API — for the UI's client badge / state-inference hint
 *   2. Client → Slack delivery sync — for "which channel does this post to?"
 *
 * Both paths used to roll their own matching logic, with two problems:
 *   - The master-tracker route hardcoded a state→client map (AZ/CA/UT)
 *     that didn't update when new clients were added.
 *   - Neither path had an explicit story for the "two clients in the
 *     same state" case — the lookup just returned whichever happened
 *     to land first in the map. Fine today; a silent footgun the
 *     moment a second AZ client is onboarded.
 *
 * This module is the single source of truth. It returns a tagged
 * RoutingResult so callers can react to the *reason* a row matched
 * (or didn't), not just the final Client object. Pure — no Prisma,
 * no Slack, no I/O — so it's trivially testable and reusable.
 */

import { STATE_NAME_TO_CODE } from './address'

/** Minimum shape any routing client needs. Callers parameterize on
 *  their richer DB record so they can carry channel IDs, colors, etc.
 *  without losing them through the routing pipeline. */
export type RoutingClient = {
  id: string
  name: string
  state: string | null
}

export type RoutingRow = {
  /** Raw "Client" column from the master sheet. May be null/blank. */
  client: string | null
  /** Customer address — used for state-based fallback inference. */
  address: string | null
}

export type RoutingResult<T extends RoutingClient> =
  | {
      /** Client column on the sheet matched a registered Client by
       *  name (case-insensitive). Highest confidence. */
      source: 'explicit'
      client: T
      confidence: 'high'
    }
  | {
      /** Client column was blank or unmatched, but the customer's
       *  address state maps unambiguously to exactly one registered
       *  client. Medium confidence. */
      source: 'inferred-state'
      client: T
      confidence: 'medium'
      matchedState: string
    }
  | {
      /** Couldn't route. The reason field explains why so callers can
       *  log/surface it intelligently. */
      source: 'unrouted'
      reason: UnroutedReason
      /** When the failure was 'ambiguous-state', the candidates that
       *  collided are surfaced so admin tooling can show a useful
       *  "this row could be either of these" message. */
      candidates?: T[]
    }

export type UnroutedReason =
  /** Client column blank, address state didn't match any client. */
  | 'no-match'
  /** Client column had a value but no exact name match, AND state
   *  inference also yielded nothing useful. Almost always a typo on
   *  the source row. */
  | 'name-mismatch-no-state-match'
  /** Address state matches 2+ registered clients — refusing to guess.
   *  Admin needs to fill in the Client column on the source row to
   *  disambiguate. */
  | 'ambiguous-state-match'

/* -------------------------------------------------------------------------- */
/*  Index                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Pre-computed lookup tables built from the active client list.
 * Build it once per sync pass and reuse across rows — the regex
 * compilation alone is heavy enough that we don't want to repeat it
 * per-row on a 500-row sheet.
 */
export type RoutingIndex<T extends RoutingClient> = {
  /** Lowercase Client.name → client. Used for explicit matching. */
  byLowerName: Map<string, T>
  /** Lowercase state key (both "az" and "arizona" point at the same
   *  list) → list of clients in that state. List length > 1 = the
   *  "two clients in same state" case. */
  byStateKey: Map<string, T[]>
  /** Single combined regex over every state key in byStateKey. Null
   *  if the client list is empty or none have a state set. */
  stateRegex: RegExp | null
}

export function buildRoutingIndex<T extends RoutingClient>(
  clients: readonly T[]
): RoutingIndex<T> {
  const byLowerName = new Map<string, T>()
  for (const c of clients) {
    byLowerName.set(c.name.toLowerCase(), c)
  }

  // Build state lookup. Each client contributes both keys for its
  // state — the spelled-out form ("arizona") and the 2-letter code
  // ("az") — so the address regex hits regardless of whether the
  // sheet entry says "Phoenix, AZ" or "Tucson, Arizona".
  const byStateKey = new Map<string, T[]>()
  for (const c of clients) {
    if (!c.state) continue
    const stateLower = c.state.toLowerCase().trim()
    if (!stateLower) continue
    pushKey(byStateKey, stateLower, c)
    const code = STATE_NAME_TO_CODE[stateLower]
    if (code) pushKey(byStateKey, code.toLowerCase(), c)
  }

  // Compile the address-scanning regex from every key we registered.
  // Keys get escaped because some state names contain spaces ("new
  // hampshire"); also any future key with a regex metacharacter
  // (unlikely for state names, defensive for future-proofing).
  const keys = Array.from(byStateKey.keys())
  const stateRegex =
    keys.length > 0
      ? new RegExp(`\\b(${keys.map(escapeRegex).join('|')})\\b`, 'i')
      : null

  return { byLowerName, byStateKey, stateRegex }
}

function pushKey<T>(map: Map<string, T[]>, key: string, value: T): void {
  const list = map.get(key)
  if (list) list.push(value)
  else map.set(key, [value])
}

/** Escape a string for safe inclusion in a regex pattern. Standard
 *  backslash-escape over every regex metacharacter. */
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/* -------------------------------------------------------------------------- */
/*  Routing                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Apply the matching tiers in order:
 *   1. Explicit Client-column name match  → 'explicit' / high
 *   2. Address state inference, exactly 1 candidate → 'inferred-state' / medium
 *   3. Address state inference, 2+ candidates → 'unrouted' / 'ambiguous-state-match'
 *   4. Nothing matched → 'unrouted' / 'no-match' (or 'name-mismatch-no-state-match'
 *      when the Client column had a value the renderer couldn't resolve)
 *
 * Callers decide what to do with each result. Master Tracker shows
 * inferred rows with a small "auto" hint and unrouted rows as "no
 * client". Slack delivery posts on explicit + inferred, and skips
 * everything else (logging the reason).
 */
export function routeRowToClient<T extends RoutingClient>(
  row: RoutingRow,
  index: RoutingIndex<T>
): RoutingResult<T> {
  const explicitName = row.client?.trim()
  // Tier 1 — explicit name match wins outright.
  if (explicitName) {
    const hit = index.byLowerName.get(explicitName.toLowerCase())
    if (hit) {
      return { source: 'explicit', client: hit, confidence: 'high' }
    }
    // Had a value but didn't resolve. Fall through to state inference
    // so a typo in the Client column doesn't kill routing entirely —
    // but remember we had a name attempt, so we can surface a more
    // specific 'name-mismatch' reason if state inference also fails.
  }

  // Tier 2 / 3 — state inference from the customer address.
  if (index.stateRegex && row.address) {
    const m = row.address.match(index.stateRegex)
    if (m) {
      const candidates = index.byStateKey.get(m[1].toLowerCase()) ?? []
      if (candidates.length === 1) {
        return {
          source: 'inferred-state',
          client: candidates[0],
          confidence: 'medium',
          matchedState: m[1],
        }
      }
      if (candidates.length > 1) {
        // Two or more clients share this state. Refuse to guess —
        // post to the wrong channel is worse than no post at all.
        return {
          source: 'unrouted',
          reason: 'ambiguous-state-match',
          candidates,
        }
      }
    }
  }

  // Tier 4 — nothing matched. Distinguish "the row attempted a name
  // we didn't know" from "the row didn't try at all" so the cron log
  // can highlight typos vs. blanks separately.
  return {
    source: 'unrouted',
    reason: explicitName ? 'name-mismatch-no-state-match' : 'no-match',
  }
}
