/**
 * GHL's toll-free registration form, filled from the client's filing (the
 * same one Hell-level files with Twilio: src/lib/hl/verification.ts,
 * tollFreeFiling). Pure so it is unit-tested; browser.ts (runGhlRegistration)
 * drives the form and queue.ts runs it.
 *
 * The form, seen 2026-11-13 on a client's "Verification Required" number and
 * in GHL's guide (modified 2026-11-08), is "Messaging Toll-Free Verification":
 * - Step 1/3 Business and contact information: Legal Entity Name, Website URL,
 *   Business DBA (Doing Business As) name, Legal entity type (Sole Proprietor,
 *   Private Profit, Public Profit, Non Profit, Government), First Name, Last
 *   Name, Email, Country Code (+1), Phone Number → "Continue to Business account".
 * - Step 2/3 Business location: Country, State/province/region, Address Line
 *   1, City, Postal/ZIP code → "Continue to Messaging Use Case".
 * - Step 3/3 Messaging use case: Estimated Monthly Volume, Opt-In Type,
 *   Use Case Category, Opt-In Workflow Image URL, Privacy Policy URL, Terms &
 *   Conditions URL, Use Case Description, Message Content.
 * - Review: "I agree to the Terms of Service", "Send Information for Verification".
 */

/** The parts of a filing the form needs (tollFreeFiling's result has them all). */
export type FilingLike = {
  businessName: string
  doingBusinessAs?: string
  businessWebsite: string
  businessType: 'PRIVATE_PROFIT' | 'SOLE_PROPRIETOR'
  businessContactFirstName?: string
  businessContactLastName?: string
  businessContactEmail: string
  businessContactPhone?: string
  businessStreetAddress: string
  businessCity: string
  businessStateProvinceRegion: string
  businessPostalCode: string
  useCaseCategories: string[]
  useCaseSummary: string
  productionMessageSample: string
  optInImageUrls: string[]
  messageVolume: string
  privacyPolicyUrl: string
  termsAndConditionsUrl: string
}

export type FormField = {
  /** The start of the label as GHL shows it (matched loosely: case, punctuation and extra words after it don't matter). */
  label: string
  kind: 'text' | 'select' | 'multi'
  /** For a select, what to pick; for multi, each one; for text, what to type. Several forms of one choice can be listed (e.g. "New York", "NY"). */
  value: string[]
  optional?: boolean
}

export type GhlForm = { step1: FormField[]; step2: FormField[]; step3: FormField[] }

const STATES: Record<string, string> = {
  AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California', CO: 'Colorado', CT: 'Connecticut', DE: 'Delaware', DC: 'District of Columbia',
  FL: 'Florida', GA: 'Georgia', HI: 'Hawaii', ID: 'Idaho', IL: 'Illinois', IN: 'Indiana', IA: 'Iowa', KS: 'Kansas', KY: 'Kentucky', LA: 'Louisiana', ME: 'Maine',
  MD: 'Maryland', MA: 'Massachusetts', MI: 'Michigan', MN: 'Minnesota', MS: 'Mississippi', MO: 'Missouri', MT: 'Montana', NE: 'Nebraska', NV: 'Nevada',
  NH: 'New Hampshire', NJ: 'New Jersey', NM: 'New Mexico', NY: 'New York', NC: 'North Carolina', ND: 'North Dakota', OH: 'Ohio', OK: 'Oklahoma', OR: 'Oregon',
  PA: 'Pennsylvania', RI: 'Rhode Island', SC: 'South Carolina', SD: 'South Dakota', TN: 'Tennessee', TX: 'Texas', UT: 'Utah', VT: 'Vermont', VA: 'Virginia',
  WA: 'Washington', WV: 'West Virginia', WI: 'Wisconsin', WY: 'Wyoming', PR: 'Puerto Rico',
}

/** "NY" or "new york" → both forms, full name first. */
export function stateForms(state: string): string[] {
  const s = state.trim()
  const code = s.length === 2 ? s.toUpperCase() : Object.keys(STATES).find((k) => STATES[k].toLowerCase() === s.toLowerCase())
  return code && STATES[code] ? [STATES[code], code] : [s]
}

/** Twilio's use case category codes (CUSTOMER_CARE) → GHL's words (Customer Care). */
export function categoryLabel(code: string): string {
  return code
    .toLowerCase()
    .split('_')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ')
}

const tenDigits = (phone: string | undefined) => (phone ?? '').replace(/\D/g, '').replace(/^1(?=\d{10}$)/, '')

export function ghlFormFields(f: FilingLike): GhlForm {
  return {
    step1: [
      { label: 'Legal Entity Name', kind: 'text', value: [f.businessName] },
      { label: 'Website URL', kind: 'text', value: [f.businessWebsite] },
      { label: 'Business DBA', kind: 'text', value: [f.doingBusinessAs ?? ''], optional: true },
      { label: 'Legal entity type', kind: 'select', value: [f.businessType === 'PRIVATE_PROFIT' ? 'Private Profit' : 'Sole Proprietor'] },
      { label: 'First Name', kind: 'text', value: [f.businessContactFirstName ?? ''] },
      { label: 'Last Name', kind: 'text', value: [f.businessContactLastName ?? ''] },
      { label: 'Email', kind: 'text', value: [f.businessContactEmail] },
      { label: 'Phone Number', kind: 'text', value: [tenDigits(f.businessContactPhone)] },
    ],
    step2: [
      { label: 'Country', kind: 'select', value: ['United States', 'US'] },
      { label: 'State', kind: 'select', value: stateForms(f.businessStateProvinceRegion) },
      { label: 'Address Line 1', kind: 'text', value: [f.businessStreetAddress] },
      { label: 'City', kind: 'text', value: [f.businessCity] },
      { label: 'Postal', kind: 'text', value: [f.businessPostalCode] },
    ],
    step3: [
      { label: 'Estimated Monthly Volume', kind: 'select', value: [f.messageVolume] },
      { label: 'Opt-In Type', kind: 'select', value: ['Web Form'] },
      { label: 'Use Case Category', kind: 'multi', value: f.useCaseCategories.map(categoryLabel) },
      { label: 'Opt-In Workflow Image URL', kind: 'text', value: [f.optInImageUrls[0] ?? f.businessWebsite] },
      { label: 'Privacy Policy URL', kind: 'text', value: [f.privacyPolicyUrl] },
      { label: 'Terms', kind: 'text', value: [f.termsAndConditionsUrl] },
      { label: 'Use Case Description', kind: 'text', value: [f.useCaseSummary] },
      { label: 'Message Content', kind: 'text', value: [f.productionMessageSample] },
    ],
  }
}

/** Fields the form needs that the filing left blank (the worker stops instead of sending a half-filled form). */
export function blankFields(form: GhlForm): string[] {
  return [...form.step1, ...form.step2, ...form.step3].filter((x) => !x.optional && !x.value.some((v) => v.trim())).map((x) => x.label)
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()

/** Does a label on screen ("State, province, or region *") answer to the wanted one ("State")? */
export function labelMatches(onScreen: string, want: string): boolean {
  const a = norm(onScreen)
  const b = norm(want)
  return !!b && (a === b || a.startsWith(`${b} `))
}

/**
 * Which option of a list to pick for any of the wanted forms: an exact match
 * first, then the same digits ("1,000" vs "1000"), then an option starting
 * with it. Null when nothing fits: the worker stops rather than guess.
 */
export function pickOption(options: string[], wants: string[]): string | null {
  for (const want of wants) {
    const w = norm(want)
    if (!w) continue
    const exact = options.find((o) => norm(o) === w)
    if (exact) return exact
    const digits = want.replace(/\D/g, '')
    if (digits && /^[\d,.\s+]+$/.test(want.trim())) {
      const same = options.find((o) => o.replace(/\D/g, '') === digits)
      if (same) return same
    }
    const starts = options.find((o) => norm(o).startsWith(`${w} `))
    if (starts) return starts
  }
  return null
}

/** A field as a person checks it: which step, GHL's words for it, and what goes in. */
export type FormRow = { step: number; label: string; value: string }

/** GHL's fuller words for the labels matched by their start. */
const SHOWN: Record<string, string> = {
  'Business DBA': 'Business DBA name',
  Postal: 'Postal/ZIP code',
  Terms: 'Terms & Conditions URL',
}

/** What goes into each field (a list shows the first form of its choice; a multi list shows them all). */
export function formRows(form: GhlForm): FormRow[] {
  return [form.step1, form.step2, form.step3].flatMap((fields, i) =>
    fields
      .filter((f) => f.value.some((v) => v.trim()))
      .map((f) => ({
        step: i + 1,
        label: SHOWN[f.label] ?? f.label,
        value: f.kind === 'multi' ? f.value.filter((v) => v.trim()).join(', ') : f.value.find((v) => v.trim())!.trim(),
      })),
  )
}

/**
 * Did what goes into the form change since a person saw these rows (saved as
 * JSON, so key order may differ)? Anything unreadable counts as changed: Send
 * then fills the form again and asks again instead of sending.
 */
export function rowsChanged(seen: unknown, form: GhlForm): boolean {
  if (!Array.isArray(seen)) return true
  const key = (r: unknown) => {
    const x = (r ?? {}) as { step?: unknown; label?: unknown; value?: unknown }
    return `${String(x.step)}\u241f${String(x.label)}\u241f${String(x.value)}`
  }
  const a = seen.map(key)
  const b = formRows(form).map(key)
  return a.length !== b.length || a.some((x, i) => x !== b[i])
}

/** GHL's toll-free registration for a number in GHL (src/lib/ghl-number/queue.ts), as the client's folder shows it. */
export type GhlRegistrationView = {
  /** The GHL number job (the Office answers name it). */
  jobId: string
  /** none | waiting_site | queued | review | approved | submitted | held | needs_human */
  state: string
  running: boolean
  detail: string | null
  at: string | null
  /** What the Hub put in GHL's form the last time it filled it. */
  rows: { step: number; label: string; value: string }[]
  /** Pictures of the latest run's form, oldest first. */
  shots: { id: string; step: string; at: string }[]
}

const REGISTRATION_SHOT = /toll-free form|registration failure|identity check at send|still verification required/i

export function registrationView(j: {
  id: string
  status: string
  phase: string
  registration: string
  regDetail: string | null
  regAt: Date | null
  regFields: unknown
  shots: { id: string; step: string; createdAt: Date }[]
}): GhlRegistrationView {
  const rows = Array.isArray(j.regFields)
    ? j.regFields.flatMap((r) => {
        const x = (r ?? {}) as { step?: unknown; label?: unknown; value?: unknown }
        return typeof x.label === 'string' && typeof x.value === 'string' ? [{ step: Number(x.step) || 0, label: x.label, value: x.value }] : []
      })
    : []
  // The latest run's pictures: newest first back to its first step.
  const shots: GhlRegistrationView['shots'] = []
  for (const s of j.shots) {
    if (!REGISTRATION_SHOT.test(s.step)) continue
    shots.push({ id: s.id, step: s.step, at: s.createdAt.toISOString() })
    if (/step 1 filled/i.test(s.step) || shots.length >= 6) break
  }
  return {
    jobId: j.id,
    state: j.registration,
    running: j.status === 'running' && j.phase === 'register',
    detail: j.regDetail,
    at: j.regAt?.toISOString() ?? null,
    rows,
    shots: shots.reverse(),
  }
}
