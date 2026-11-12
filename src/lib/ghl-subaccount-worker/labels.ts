/**
 * Words the browser looks for on GHL's create-sub-account form.
 * GHL renames buttons more often than it changes the flow. Override a
 * key with GHL_SUBACCOUNT_WORKER_LABELS, a JSON object of string arrays.
 *
 * Key order matters: a field is claimed by the first key whose words
 * match, so specific labels come before "name".
 */

export type GhlLabels = Record<string, string[]>

export const DEFAULT_GHL_LABELS: GhlLabels = {
  password: ['Password'],
  otp: ['Verification Code', 'Security Code', 'Enter code', 'Authentication code', 'One-time code', 'One time code', 'OTP', 'Code'],
  search: ['Search sub-accounts', 'Search Sub-Accounts', 'Search accounts', 'Search'],
  firstName: ['First Name'],
  lastName: ['Last Name'],
  email: ['Business Email', 'Email'],
  phone: ['Business Phone', 'Phone'],
  postalCode: ['Postal Code', 'Zip Code', 'Zip', 'Postal'],
  timezone: ['Timezone', 'Time Zone'],
  snapshot: ['Snapshot', 'Load Snapshot', 'Select Snapshot'],
  address: ['Street Address', 'Business Address', 'Address', 'Street'],
  city: ['City'],
  state: ['State', 'Province'],
  country: ['Country'],
  website: ['Website'],
  name: ['Business Name', 'Account Name', 'Location Name', 'Name'],
  subAccountsNav: ['Sub-Accounts', 'Sub Accounts'],
  createButton: ['+ Create Sub-Account', 'Create Sub-Account'],
  addBusiness: ['Add a new business', 'Add new business', 'New business'],
  addManually: ['Add manually'],
  signIn: ['Sign in', 'Sign In', 'Log in', 'Login'],
  verify: ['Verify', 'Continue', 'Confirm', 'Submit', 'Confirm Code', 'Verify Code', 'Login', 'Sign in', 'Sign In', 'Log in', 'Done', 'Next'],
  submit: ['Create', 'Save', 'Add'],
  sendSecurityCode: ['Send security code', 'Send code'],
}

export function ghlLabels(overrideJson?: string | null): GhlLabels {
  const next: GhlLabels = { ...DEFAULT_GHL_LABELS }
  if (!overrideJson?.trim()) return next
  try {
    const parsed = JSON.parse(overrideJson) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return next
    for (const [key, value] of Object.entries(parsed)) {
      if (Array.isArray(value) && value.every((v) => typeof v === 'string' && v.trim())) {
        next[key] = value.map((v) => v.trim())
      }
    }
    return next
  } catch {
    return { ...DEFAULT_GHL_LABELS }
  }
}
