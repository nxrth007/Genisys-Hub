/**
 * Whether an EIN can be real, before it goes to a registry. The IRS never
 * issues EINs starting with these two digits (its own list of invalid
 * prefixes), so one that does is a typo. Twilio rejects such a filing as
 * "Business Registration Number Is Missing or Invalid" (30527) only after it
 * has waited in review (a client in Nov 2026 whose onboarding answer started
 * with 09). Pure, for the filings and the tests.
 */
export const INVALID_EIN_PREFIXES: ReadonlySet<string> = new Set(['00', '07', '08', '09', '17', '18', '19', '28', '29', '49', '69', '70', '78', '79', '89', '96', '97'])

/**
 * What's wrong with an EIN as typed, as a clause ("the EIN on file (…) has 8
 * digits; an EIN has 9"), or null when it may be real. A blank one is fine:
 * a sole proprietor files without one.
 */
export function einProblem(raw: string | null | undefined): string | null {
  const digits = (raw ?? '').replace(/\D/g, '')
  if (!digits) return null
  if (digits.length !== 9) return `the EIN on file (${(raw ?? '').trim()}) has ${digits.length} digit${digits.length === 1 ? '' : 's'}; an EIN has 9`
  const prefix = digits.slice(0, 2)
  if (INVALID_EIN_PREFIXES.has(prefix)) return `the EIN on file (${prefix}-${digits.slice(2)}) can’t be real: the IRS never issues EINs starting with ${prefix}`
  return null
}
