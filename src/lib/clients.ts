import { formatPhoneInput } from './phone'

/**
 * Server-side validation + normalization helpers for the Client
 * create + patch endpoints. Kept in one file so the rules stay
 * consistent — UI is allowed to be loose, the API is the bouncer.
 */

const HEX_COLOR_RE = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i

export const VALID_LIFECYCLES = ['active', 'onboarding', 'paused', 'churned'] as const
export type ClientLifecycle = (typeof VALID_LIFECYCLES)[number]

function isValidLifecycle(v: unknown): v is ClientLifecycle {
  return typeof v === 'string' && (VALID_LIFECYCLES as readonly string[]).includes(v)
}

/** Contract tiers. PPA = pay per appt (no nominal cap), Growth + Pro
 *  have nominal caps that drive the Clients-page progress bar, and
 *  Custom is the bespoke deal where the cap is set entirely by the
 *  admin (or left blank for sit-down-guarantee arrangements). */
export const VALID_PACKAGES = ['ppa', 'growth', 'pro', 'custom'] as const
export type ClientPackage = (typeof VALID_PACKAGES)[number]

function isValidPackage(v: unknown): v is ClientPackage {
  return typeof v === 'string' && (VALID_PACKAGES as readonly string[]).includes(v)
}

/** Coerce a raw apptCap value (number / numeric string / null /
 *  undefined / empty string) into either a positive integer or
 *  null. Rejects negative / zero / NaN — those would be a typo
 *  rather than "they have a 0-appt cap". Returning null = unlimited. */
function normalizeApptCap(v: unknown): number | null {
  if (v == null || v === '') return null
  const n = typeof v === 'number' ? v : Number.parseInt(String(v).trim(), 10)
  if (!Number.isFinite(n) || n <= 0) return null
  return Math.round(n)
}

function trimOrNull(v: unknown): string | null {
  if (typeof v !== 'string') return null
  const t = v.trim()
  return t.length > 0 ? t : null
}

/** Used by POST /api/clients. Returns either the validated payload
 *  ready for prisma.create, or a human-readable error string. */
export function validateClientCreate(
  body: unknown
):
  | {
      ok: true
      data: {
        name: string
        state: string | null
        color: string
        contactName: string | null
        contactRole: string | null
        contactEmail: string | null
        contactPhone: string | null
        address: string | null
        notes: string | null
        intakeFormUrl: string | null
        ghlSubaccountUrl: string | null
        servicingZipcodes: string | null
        lifecycle: ClientLifecycle
        package: ClientPackage
        apptCap: number | null
        sortOrder: number
      }
    }
  | { ok: false; error: string } {
  if (!body || typeof body !== 'object') {
    return { ok: false, error: 'invalid body' }
  }
  const b = body as Record<string, unknown>

  const name = typeof b.name === 'string' ? b.name.trim() : ''
  if (!name) return { ok: false, error: 'name is required' }

  // Loose hex validation — fall back to schema default if the picker
  // wasn't touched, so a typo doesn't surface as a Prisma error.
  const colorRaw = typeof b.color === 'string' ? b.color.trim() : ''
  const color = HEX_COLOR_RE.test(colorRaw) ? colorRaw : '#3b82f6'

  const lifecycleIn = b.lifecycle
  const lifecycle: ClientLifecycle = isValidLifecycle(lifecycleIn)
    ? lifecycleIn
    : 'active'

  const sortOrder =
    typeof b.sortOrder === 'number' && Number.isFinite(b.sortOrder)
      ? Math.round(b.sortOrder)
      : 0

  // Phone — auto-format on the server so the DB always has a
  // canonical "(555) 123-4567" representation regardless of how the
  // admin typed it in the form.
  const rawPhone = trimOrNull(b.contactPhone)
  const contactPhone = rawPhone ? formatPhoneInput(rawPhone) : null

  const pkg: ClientPackage = isValidPackage(b.package) ? b.package : 'custom'
  const apptCap = normalizeApptCap(b.apptCap)

  return {
    ok: true,
    data: {
      name,
      state: trimOrNull(b.state),
      color,
      contactName: trimOrNull(b.contactName),
      contactRole: trimOrNull(b.contactRole),
      contactEmail: trimOrNull(b.contactEmail),
      contactPhone,
      address: trimOrNull(b.address),
      notes: trimOrNull(b.notes),
      intakeFormUrl: trimOrNull(b.intakeFormUrl),
      ghlSubaccountUrl: trimOrNull(b.ghlSubaccountUrl),
      servicingZipcodes: trimOrNull(b.servicingZipcodes),
      lifecycle,
      package: pkg,
      apptCap,
      sortOrder,
    },
  }
}

/**
 * Used by PATCH /api/clients/[id]. Builds a partial-update object —
 * only includes fields the admin actually sent. Empty string / null
 * → clears the column. Skipped (key absent) → leaves the column
 * alone.
 */
export function normalizeClientPatch(
  body: unknown
):
  | {
      ok: true
      data: Partial<{
        name: string
        state: string | null
        color: string
        contactName: string | null
        contactRole: string | null
        contactEmail: string | null
        contactPhone: string | null
        address: string | null
        notes: string | null
        intakeFormUrl: string | null
        ghlSubaccountUrl: string | null
        servicingZipcodes: string | null
        lifecycle: ClientLifecycle
        active: boolean
        package: ClientPackage
        apptCap: number | null
        slackChannelId: string | null
        slackChannelName: string | null
      }>
    }
  | { ok: false; error: string } {
  if (!body || typeof body !== 'object') {
    return { ok: false, error: 'invalid body' }
  }
  const b = body as Record<string, unknown>
  const data: Partial<{
    name: string
    state: string | null
    color: string
    contactName: string | null
    contactRole: string | null
    contactEmail: string | null
    contactPhone: string | null
    address: string | null
    notes: string | null
    intakeFormUrl: string | null
    ghlSubaccountUrl: string | null
    servicingZipcodes: string | null
    lifecycle: ClientLifecycle
    active: boolean
    package: ClientPackage
    apptCap: number | null
    slackChannelId: string | null
    slackChannelName: string | null
  }> = {}

  // Name — required if present, can't be cleared.
  if ('name' in b) {
    const name = typeof b.name === 'string' ? b.name.trim() : ''
    if (!name) return { ok: false, error: 'name cannot be empty' }
    data.name = name
  }

  if ('color' in b) {
    const colorRaw = typeof b.color === 'string' ? b.color.trim() : ''
    if (!HEX_COLOR_RE.test(colorRaw)) {
      return { ok: false, error: 'color must be a hex like #1a73e8' }
    }
    data.color = colorRaw
  }

  if ('lifecycle' in b) {
    if (!isValidLifecycle(b.lifecycle)) {
      return {
        ok: false,
        error: `lifecycle must be one of ${VALID_LIFECYCLES.join(', ')}`,
      }
    }
    data.lifecycle = b.lifecycle
    // Mirror the legacy `active` flag so the GET endpoint's filter
    // (active=true) still hides churned clients from agent pickers.
    data.active = b.lifecycle === 'active' || b.lifecycle === 'onboarding'
  }

  // Free-text fields — empty string/null clears the column.
  const textFields: Array<
    keyof Pick<
      typeof data,
      | 'state'
      | 'contactName'
      | 'contactRole'
      | 'contactEmail'
      | 'address'
      | 'notes'
      | 'intakeFormUrl'
      | 'ghlSubaccountUrl'
      | 'servicingZipcodes'
    >
  > = [
    'state',
    'contactName',
    'contactRole',
    'contactEmail',
    'address',
    'notes',
    'intakeFormUrl',
    'ghlSubaccountUrl',
    'servicingZipcodes',
  ]
  for (const key of textFields) {
    if (key in b) data[key] = trimOrNull(b[key])
  }

  // Phone gets the formatter to keep the DB representation canonical.
  if ('contactPhone' in b) {
    const raw = trimOrNull(b.contactPhone)
    data.contactPhone = raw ? formatPhoneInput(raw) : null
  }

  // Package + cap — admin-set via the client form. Both fields are
  // optional in the patch payload; missing keys leave the column
  // untouched. apptCap explicitly null = clear the cap (unlimited).
  if ('package' in b) {
    if (!isValidPackage(b.package)) {
      return {
        ok: false,
        error: `package must be one of ${VALID_PACKAGES.join(', ')}`,
      }
    }
    data.package = b.package
  }
  if ('apptCap' in b) {
    data.apptCap = normalizeApptCap(b.apptCap)
  }

  // Slack channel routing — admin-set via Settings → Client delivery.
  // Both fields move together: setting the ID requires the cached
  // name (so the UI can render the picked channel without a Slack
  // round-trip), and clearing one clears both.
  if ('slackChannelId' in b) {
    data.slackChannelId = trimOrNull(b.slackChannelId)
    if (!data.slackChannelId) data.slackChannelName = null
  }
  if ('slackChannelName' in b) {
    data.slackChannelName = trimOrNull(b.slackChannelName)
  }

  return { ok: true, data }
}
