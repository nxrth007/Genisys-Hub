/**
 * PPA invoicing config — payment links + pricing for the bi-weekly
 * automation. Isolated in its own file so adding new tiers as
 * Genisys grows doesn't require touching scheduler / library code.
 *
 * When Alex wants to support 5+ qualified appointments per cycle,
 * just drop a new entry into PPA_PAYMENT_LINKS keyed on the count.
 * The library re-reads this map at fire time, so no other file
 * needs to change.
 */

/** Standard PPA rate per qualified appointment. Stored in cents so
 *  money math stays integer (1 appt = 27500 cents = $275). */
export const PPA_PRICE_PER_APPOINTMENT_CENTS = 27500

/** Bi-weekly cycle length in milliseconds. Fourteen days exactly —
 *  no holiday / weekend logic for now; the cron fires once daily
 *  and naturally rolls forward by whole days. */
export const PPA_CYCLE_LENGTH_MS = 14 * 24 * 60 * 60 * 1000

/** QuickBooks Commerce payment links keyed by qualified-appointment
 *  count. Each link is a pre-built QuickBooks payment page priced
 *  for exactly N appointments at $275 each. Sourced from Alex on
 *  2026-06-01 — see chat log for the URL provenance.
 *
 *  Adding tiers: drop a new (count → url) pair below. Nothing else
 *  needs to change. The lib's "do we have a link for this count?"
 *  check is just `count in PPA_PAYMENT_LINKS`. */
export const PPA_PAYMENT_LINKS: Record<number, string> = {
  1: 'https://connect.intuit.com/portal/app/CommerceNetwork/view/scs-v1-d1a9dbca60964374afd5c2f35c23575e7e140452f01742598f7222ef6b61e5912d8ff9c25adc48c49facab3184042914?locale=EN_US&cta=copylistmultilink',
  2: 'https://connect.intuit.com/portal/app/CommerceNetwork/view/scs-v1-fabd30254d8e4c9fbbb7c17be6d21f64d0424381e3534bff898d753a1fbb82a19846097ba78541c693859747ca6f1127?locale=EN_US&cta=copylistmultilink',
  3: 'https://connect.intuit.com/portal/app/CommerceNetwork/view/scs-v1-43783df58d5e461a97720ef0d73ffebbb7064808504045df90794c287efcfb0661e60a6ac0b2402cb9a60cc035880295?locale=EN_US&cta=copylistmultilink',
  4: 'https://connect.intuit.com/portal/app/CommerceNetwork/view/scs-v1-b60944eafe6d447c8e3b046ec72c96e7a94949bb0bbc42658417f42053ba822b7b716f419ba1430da28a74641cee19c3?locale=EN_US&cta=copylistmultilink',
}

/** Highest count we have a pre-built link for. Cached so the
 *  scheduler doesn't recompute on every tick. Recomputed from
 *  PPA_PAYMENT_LINKS at module load. */
export const PPA_MAX_LINK_COUNT = Math.max(
  ...Object.keys(PPA_PAYMENT_LINKS).map(Number),
)

/** Format a cents amount as a USD string for display. Used in
 *  emails / SMS / Slack alerts. Stays in this file so a future
 *  multi-currency expansion only touches one place. */
export function formatUsd(cents: number): string {
  const dollars = cents / 100
  return `$${dollars.toLocaleString('en-US', {
    minimumFractionDigits: dollars % 1 === 0 ? 0 : 2,
    maximumFractionDigits: 2,
  })}`
}
