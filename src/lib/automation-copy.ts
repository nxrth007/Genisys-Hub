import { formatPhone } from './a2p'

/**
 * Copy for the GHL automations every client gets, personalized per client.
 *
 * GHL's Agency Pro plan would let the Hub write this into each sub-account's
 * workflows over the API; on the $297 plan a person pastes it in. So this is
 * a copy-and-paste board like the A2P one: values come from the client's
 * onboarding answers, anything missing is typed on the board and saved per
 * client, and each box copies exactly what goes into GHL.
 *
 * Two kinds of braces show up in the copy:
 *   {{contact.first_name}}  — a GHL merge field, kept as is; GHL fills it per lead.
 *   ⟦OWNER FIRST NAME⟧       — a client detail still missing; copies as [OWNER FIRST NAME].
 * (The A2P board marks blanks with {{…}}; that would collide with GHL's own fields here.)
 *
 * Templates are the A Plus Fence & Construction originals with the
 * business-specific parts swapped out. Straight apostrophes on purpose: a
 * curly ’ turns an SMS into Unicode, which halves the characters per segment.
 */

export type AutomationInputs = {
  businessName: string
  ownerFirstName: string
  ownerFullName: string
  /** Where "click this link for a free quote" goes: the site we built. */
  quoteLink: string
  /** The number leads are told to call. */
  phone: string
  /** Where internal notifications go: the email on the onboarding form. */
  notifyEmail: string
}

export const AUTOMATION_INPUT_KEYS = [
  'businessName',
  'ownerFirstName',
  'ownerFullName',
  'quoteLink',
  'phone',
  'notifyEmail',
] as const satisfies readonly (keyof AutomationInputs)[]

/**
 * The board's details as GHL custom values, so the snapshot's workflows can
 * use {{custom_values.<key>}} instead of typed names. GHL derives the key
 * from the name; the Hub matches existing values by name.
 */
export const AUTOMATION_VALUE_DEFS: { key: string; name: string; input: keyof AutomationInputs }[] = [
  { key: 'owner_first_name', name: 'Owner First Name', input: 'ownerFirstName' },
  { key: 'owner_full_name', name: 'Owner Full Name', input: 'ownerFullName' },
  { key: 'business_name', name: 'Business Name', input: 'businessName' },
  { key: 'business_phone', name: 'Business Phone', input: 'phone' },
  { key: 'website_link', name: 'Website Link', input: 'quoteLink' },
  { key: 'notification_email', name: 'Notification Email', input: 'notifyEmail' },
]

export type AutomationSource = {
  name: string
  contactName: string | null
  contactEmail: string | null
  contactPhone: string | null
  siteUrl: string | null
  website: string | null
  intake: {
    fullName: string | null
    businessName: string | null
    customerPhone: string | null
    leadEmail: string | null
    website: string | null
    domainName: string | null
  } | null
}

const clean = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim()

/** "aplusconstruction.org" / "http://x.com" → "https://aplusconstruction.org/". */
export function siteLink(raw: string | null | undefined): string {
  const s = clean(raw)
  if (!s) return ''
  try {
    const u = new URL(/^https?:\/\//i.test(s) ? s : `https://${s}`)
    return `https://${u.host.toLowerCase()}${u.pathname === '/' ? '/' : u.pathname}`
  } catch {
    return ''
  }
}

/** Everything the client record and onboarding answers can fill in. */
export function automationPrefill(src: AutomationSource): AutomationInputs {
  const i = src.intake
  const fullName = clean(i?.fullName) || clean(src.contactName)
  return {
    businessName: clean(i?.businessName) || clean(src.name),
    ownerFirstName: fullName.split(' ')[0] ?? '',
    ownerFullName: fullName,
    quoteLink: siteLink(src.siteUrl) || siteLink(i?.domainName) || siteLink(i?.website) || siteLink(src.website),
    phone: formatPhone(i?.customerPhone || src.contactPhone),
    notifyEmail: clean(i?.leadEmail) || clean(src.contactEmail),
  }
}

// ---------------------------------------------------------------------------
// Blanks and merge fields
// ---------------------------------------------------------------------------

const BLANK = /⟦([^⟧]+)⟧/g
const TOKEN = /⟦([^⟧]+)⟧|\{\{\s*([^}]+?)\s*\}\}/g

/** A value, or a marked blank when it's missing. */
const v = (value: string, label: string) => clean(value) || `⟦${label}⟧`

export function blanksIn(text: string): string[] {
  return [...text.matchAll(BLANK)].map((m) => m[1]).filter((b, i, all) => all.indexOf(b) === i)
}

/** The text as it goes into GHL: blanks become [LABEL]; merge fields stay. */
export function forCopy(text: string): string {
  return text.replace(BLANK, (_m, label: string) => `[${label}]`)
}

export type Segment = { text: string; kind: 'plain' | 'blank' | 'merge' }

/** Text split into plain runs, missing details and GHL merge fields, for rendering. */
export function segments(text: string): Segment[] {
  const out: Segment[] = []
  let last = 0
  for (const m of text.matchAll(TOKEN)) {
    if (m.index! > last) out.push({ text: text.slice(last, m.index), kind: 'plain' })
    out.push(m[1] ? { text: `[${m[1]}]`, kind: 'blank' } : { text: m[0], kind: 'merge' })
    last = m.index! + m[0].length
  }
  if (last < text.length) out.push({ text: text.slice(last), kind: 'plain' })
  return out
}

/**
 * SMS segments for a message as sent. Plain GSM-7 text fits 160 characters
 * in one segment (153 each when split); a single emoji or curly quote makes
 * the whole message Unicode: 70 (67 each). Merge fields count at their
 * typical length, so this is an estimate.
 */
export function smsSegments(text: string): { chars: number; segments: number; unicode: boolean } {
  const sent = forCopy(text).replace(/\{\{\s*contact\.first_name\s*\}\}/g, 'Jennifer')
  // GSM-7 basic set plus the common extension characters.
  const unicode = /[^\n\r !"#$%&'()*+,\-./0-9:;<=>?@A-Z[\\\]^_`a-z{|}~£¥èéùìòÇØøÅåΔΦΓΛΩΠΨΣΘΞÆæßÉÄÖÑÜ§¿äöñüà€]/.test(sent)
  const chars = [...sent].length
  const single = unicode ? 70 : 160
  const multi = unicode ? 67 : 153
  return { chars, unicode, segments: chars <= single ? 1 : Math.ceil(chars / multi) }
}

// ---------------------------------------------------------------------------
// The folders, automations and their copy
// ---------------------------------------------------------------------------

export type CopyPiece = {
  id: string
  label: string
  /** sms = a text to the lead; email = an internal email; value = a single field (an address to paste). */
  kind: 'sms' | 'email' | 'value'
  text: string
  note?: string
}

export type Automation = {
  id: string
  name: string
  /** Where it lives in GHL. */
  where: string
  pieces: CopyPiece[]
}

export type AutomationFolder = { id: string; name: string; automations: Automation[] }

export function automationFolders(x: AutomationInputs): AutomationFolder[] {
  const B = v(x.businessName, 'BUSINESS NAME')
  const first = v(x.ownerFirstName, 'OWNER FIRST NAME')
  const full = v(x.ownerFullName, 'OWNER FULL NAME')
  const phone = v(x.phone, 'BUSINESS PHONE')
  const link = v(x.quoteLink, 'WEBSITE LINK')
  const email = v(x.notifyEmail, 'NOTIFICATION EMAIL')

  const customerSms = (what: string) =>
    `Hey {{contact.first_name}}! Just got your ${what}.\n\nI'll be in touch with you shortly. Please feel free to reach out to us directly at ${phone}\n\n- ${full} at ${B}`

  return [
    {
      id: 'incoming-leads',
      name: 'Incoming Lead Workflows',
      automations: [
        {
          id: 'missed-call',
          name: 'Auto Missed Call Text-Back',
          where: 'Automation → Workflows → Auto Missed Call Text-Back → the SMS action',
          pieces: [
            {
              id: 'missed-call-sms',
              label: 'SMS to the caller',
              kind: 'sms',
              text: `Hey, sorry I missed your call! I'll get back to you asap.\n\nIf you want to give me a few details about the job that would be great. You can click this link for a free quote ${link}\n\n- ${first} from ${B}`,
            },
          ],
        },
        {
          id: 'chat-widget',
          name: 'Website Chat Widget Form Submitted',
          where: 'Automation → Workflows → Website Chat Widget Form Submitted',
          pieces: [
            {
              id: 'chat-notify-to',
              label: 'Internal notification: send to',
              kind: 'value',
              text: email,
              note: 'The email the client gave on the onboarding form. Paste it into the notification action’s recipient field.',
            },
            {
              id: 'chat-notify-body',
              label: 'Internal notification: message',
              kind: 'email',
              text: `Hey ${first},\n\nSomeone requested a quote for service:\n\nHere's their info:\nName: {{contact.name}}\nEmail: {{contact.email}}\nPhone: {{contact.phone}}\nProject Details: {{project details}}\n\nWe've let them know you'll be in touch.\nCall them back ASAP to book their quote!`,
              note: '{{project details}} must match the merge field of the chat widget’s project-details question in this sub-account. Pick it from the merge-field menu in the action if it shows up blank.',
            },
            {
              id: 'chat-customer-sms',
              label: 'SMS to the lead',
              kind: 'sms',
              text: customerSms('chat submission'),
            },
          ],
        },
        {
          id: 'quote-form',
          name: 'Website Quote Form Submitted',
          where: 'Automation → Workflows → Website Quote Form Submitted → the SMS action',
          pieces: [
            {
              id: 'quote-customer-sms',
              label: 'SMS to the lead',
              kind: 'sms',
              text: customerSms('quote form'),
            },
          ],
        },
      ],
    },
  ]
}

export const AUTOMATION_IDS: string[] = automationFolders({
  businessName: '',
  ownerFirstName: '',
  ownerFullName: '',
  quoteLink: '',
  phone: '',
  notifyEmail: '',
}).flatMap((f) => f.automations.map((a) => a.id))
