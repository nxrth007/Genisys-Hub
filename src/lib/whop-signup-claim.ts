/**
 * Atomic "announce this Whop sign-up once" claim, shared by the webhook and
 * the 5-minute poll. No Hub imports, so it can be unit-tested with a fake store.
 *
 * The store's insert must be atomic insert-or-ignore (a unique key): exactly one
 * concurrent caller gets `true`. In the Hub that's the WhopSignupClaim table.
 */
export type ClaimSource = 'webhook' | 'poll'

export type ClaimStore = {
  /** Insert the row if absent. Resolves true only for the caller that inserted it. */
  insertIfAbsent(membershipId: string, source: ClaimSource): Promise<boolean>
}

export async function claimSignup(store: ClaimStore, membershipId: string, source: ClaimSource): Promise<boolean> {
  const id = membershipId.trim()
  if (!id) return false
  return store.insertIfAbsent(id, source)
}

/** Prisma's unique-constraint error, without importing Prisma. */
export function isUniqueViolation(err: unknown): boolean {
  return !!err && typeof err === 'object' && (err as { code?: unknown }).code === 'P2002'
}
