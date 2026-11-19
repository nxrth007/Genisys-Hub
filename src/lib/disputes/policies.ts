/**
 * Policy text the Stripe dispute packet may quote.
 *
 * The page text is the onboarding site's src/lib/policies.ts
 * (nxrth007/genisysclientonboarding, branch main). PolicyPage renders
 * `text`, and the intake hashes that same string. Checked 2026-11-19:
 * https://clientonboarding.leadgenisys.com/terms, /refund-policy,
 * /cancellation-policy, and /recurring-billing each returned HTTP 404,
 * so this copy is from GitHub, not from the live HTML.
 *
 * textHash is SHA-256 (utf8) of `text`, the same digest the onboarding
 * site stores on the acceptance record. Quote `summary` only when the
 * client's textHash equals that digest. Cite version, textHash, and
 * textUrl from the intake either way. Do not fill a missing or different
 * hash with another policy's words.
 *
 * When the owner removes a DRAFT banner, add a new edition. Leave the
 * old edition in POLICY_EDITIONS so an intake that hashed the draft still
 * quotes the draft.
 */
import { createHash } from 'node:crypto'

export const POLICY_SOURCE = 'nxrth007/genisysclientonboarding main src/lib/policies.ts'
export const POLICY_ORIGIN = 'https://clientonboarding.leadgenisys.com'
export const POLICY_CONTACT_EMAIL = 'ethan@leadgenisys.com'

/** Signup checkout line. The recurring page uses this sentence. */
export const BILLING_SUMMARY = "$0 due today on the 30-day free trial, then $297 per month."

/** Terms of Service version published on the onboarding site. */
export const PUBLISHED_TERMS_VERSION = '2026-08-06'
/** Refund, cancellation, and recurring pages. Still marked draft there. */
export const DRAFT_POLICY_VERSION = '2026-11-19'

export const POLICY_KINDS = ['terms', 'refund_policy', 'cancellation_policy', 'recurring_billing'] as const
export type PolicyKind = (typeof POLICY_KINDS)[number]

export type PolicyEdition = {
  kind: PolicyKind
  title: string
  version: string
  draft: boolean
  path: string
  textUrl: string
  /** Exact characters shown on the policy page and hashed at acceptance. */
  text: string
  textHash: string
  /**
   * Short quote for Stripe text fields. Same rules as the page.
   * No price, notice period, or contact address that the page does not state.
   */
  summary: string
}

export function policyTextHash(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

const TERMS_TEXT = "Lead Genisys LLC Terms of Service\nLast updated: August 6, 2026\nVersion: 2026-08-06\n\n1. Agreement to Terms\nBy accessing or using the services provided by Lead Genisys LLC (\"we,\" \"our,\" or \"us\"), you agree to be bound by these Terms of Service (\"Terms\"). If you do not agree to these Terms, you may not access or use our services.\nThese Terms constitute a legally binding agreement between you (\"Client,\" \"you,\" or \"your\") and Lead Genisys LLC. Please read these Terms carefully before using our services.\n\n2. Description of Services\nLead Genisys LLC provides done-for-you websites, AI-powered follow-up, and 5-star review automation for home service contractors, including but not limited to roofing, solar, HVAC, remodeling, and related trades.\nOur services include:\n- Custom contractor website design, build, and hosting\n- AI-powered speed-to-lead follow-up via text and email\n- Appointment scheduling and calendar management\n- CRM setup and automation\n- Automated 5-star review requests and reputation management\n- Missed-call text back and lead nurturing\n- Performance tracking and reporting\nOur services are designed exclusively for business use. By using our services, you represent that you are using them for commercial purposes related to your business operations.\n\n3. SMS Messaging Terms & Compliance\nProgram Description. This messaging program sends appointment confirmation and reminder messages to customers who have filled out a form with Lead Genisys LLC through our website at https://contractors.leadgenisys.com/contact, or via our scheduling forms, and who have explicitly opted in to receive SMS notifications. Opt-in is collected via web forms with a dedicated checkbox for SMS consent. Messages include scheduling confirmations, appointment reminders, rescheduling updates, and customer support communications.\nMessage types:\n- Appointment confirmations and reminders\n- Service status updates and notifications\n- Performance and review activity updates\n- Follow-up communications regarding your inquiry\n- Promotional messages about our services (with prior consent)\nMessage frequency varies based on your service plan and interaction with our platform. You may receive up to 7 messages per month depending on scheduled appointments and service activity.\nYou can cancel the SMS service at any time. Just text \"STOP\" to +1 213-510-1418. After you send the SMS message \"STOP\" to us, we will send you an SMS message to confirm that you have been unsubscribed. After this, you will no longer receive SMS messages from us. If you want to join again, just sign up as you did the first time and we will start sending SMS messages to you again.\nYou may also opt out by calling us at +1 213-510-1418 or emailing ethan@leadgenisys.com.\nIf you experience issues with the messaging program, reply with the keyword \"HELP\" for more assistance, or reach out directly to ethan@leadgenisys.com or call +1 213-510-1418 during business hours.\nIf you previously opted out of our SMS messages and would like to rejoin the program, you may opt back in at any time by signing up again through the same method you originally used (such as submitting a form on our website or providing consent during registration). Once you re-enroll, you will begin receiving SMS messages from us as before. If you need assistance rejoining or encounter any issues, reply \"HELP\" for support or contact us directly at ethan@leadgenisys.com or call +1 213-510-1418 during business hours.\nCarriers are not liable for delayed or undelivered messages.\nAs always, message and data rates may apply for any messages sent to you from us and to us from you. You will receive messages to confirm your appointment and to remind you of the time and date. If you have any questions about your text plan or data plan, it is best to contact your wireless provider.\nOur SMS program works with all major U.S. wireless carriers, including AT&T, T-Mobile, Verizon, Sprint, and most regional carriers.\nOur SMS messaging program is intended for users who are 18 years of age or older. By opting in to receive text messages, you confirm that you are at least 18 years old.\nConsent to receive text messages is not a condition of purchasing any goods or services from Lead Genisys LLC.\nIf you have any questions regarding privacy, please read the Privacy Policy published with these Terms.\n\n4. Account Registration\nTo use our services, you must:\n- Provide accurate, current, and complete information about yourself and your business\n- Maintain the accuracy of your information and promptly update it as necessary\n- Maintain the security and confidentiality of your account credentials\n- Notify us immediately of any unauthorized access to your account\nYou are solely responsible for all activities that occur under your account.\n\n5. Service Plans and Billing\nOur core offer is a monthly subscription that includes a free website build with ongoing AI follow-up and 5-star review automation. Subscription fees are billed monthly in advance and continue until cancelled in accordance with Section 10.\nThe website is provided at no upfront cost as part of an active subscription. Additional scope, custom work, or add-on services are quoted separately and documented in a service agreement between Lead Genisys LLC and the Client. Late or failed payments may result in suspension of your website, automations, and account access.\n\n6. Results and Performance\nLead Genisys LLC is committed to delivering measurable results. Any specific performance commitments, including lead or appointment targets and timelines, are defined in the Client's individual service agreement.\nDefinition of Qualified Appointment. Where appointment delivery is included, a \"qualified appointment\" is a prospect who:\n- Is a homeowner (not a renter)\n- Is located within your designated service area\n- Has expressed genuine interest in your services\n- Has a project timeline within the next 12 months\n- Shows up to the scheduled appointment or provides advance notice of rescheduling\nTo qualify for any performance commitment, Client must respond to contacts in a reasonable timeframe, keep the provided systems active, and maintain calendar availability for scheduled appointments.\n\n7. Client Responsibilities\nAs a Client, you agree to:\n- Provide the content, photos, licensing, and business details needed to build your website\n- Grant the access required to connect your phone number, calendar, CRM, and Google Business Profile\n- Respond to leads and contacts in a timely manner\n- Provide accurate business information, including service areas and offerings\n- Maintain calendar availability for scheduled appointments\n- Provide feedback on lead quality and appointment outcomes\n- Only request reviews from genuine customers and comply with all review platform policies\n- Conduct business in a professional and ethical manner and comply with all applicable laws\n\n8. Market Exclusivity\nLead Genisys LLC operates on a one-client-per-market basis. Once you secure exclusivity for your market/service area, we will not work with competing businesses in that same market for the same services.\n- Exclusivity is maintained as long as you remain an active, paying client\n- Market boundaries are defined at the start of the engagement\n- Exclusivity does not transfer if you cancel or pause services\n- We reserve the right to define market boundaries at our discretion\n\n9. Intellectual Property\nDuring Active Service. Lead Genisys LLC retains ownership of the website, landing pages, creative assets, CRM workflows, automation sequences, and other materials created as part of the service. Client receives a license to use these materials for the duration of the subscription. Your own content, logos, photos, and customer data remain yours.\nUpon Agreement Completion. Ownership or transfer terms for the website and related assets, if applicable, are specified in the individual service agreement. Client is responsible for any ongoing hosting, maintenance, and updates following such a transfer.\n\n10. Cancellation and Refunds\nCancellation. Either party may cancel services with 30 days written notice. Cancellation requests should be sent to ethan@leadgenisys.com. Upon cancellation, hosting, AI follow-up, and review automation are discontinued at the end of the current billing period.\nRefund Policy.\n- Setup and creative work are non-refundable once work has commenced\n- Fees paid for the current service period are non-refundable\n- Unused prepaid services may be credited toward future services at our discretion\n\n11. Termination\nWe may terminate or suspend your access to our services immediately, without prior notice, for:\n- Breach of these Terms\n- Non-payment of fees\n- Fraudulent or illegal activity\n- Conduct that harms our reputation or other clients\nUpon termination, your access to our systems and platforms will be revoked. Any data collected on your behalf remains subject to our Privacy Policy.\n\n12. Limitation of Liability\nTo the maximum extent permitted by law:\n- Lead Genisys LLC is not responsible for final sales outcomes. Our services generate leads, follow up, and set appointments; closing sales is the Client's responsibility.\n- Results depend on the Client's sales process, pricing, reputation, and ability to convert leads.\n- We are not liable for changes to third-party platforms (including search engines, review platforms, hosting, or messaging carriers) that may affect performance.\n- Our total liability shall not exceed the fees paid by Client in the 3 months preceding any claim.\n\n13. Disclaimer of Warranties\nOur services are provided \"as is\" and \"as available\" without warranties of any kind, either express or implied, including but not limited to implied warranties of merchantability, fitness for a particular purpose, non-infringement, or guaranteed revenue or profit results.\nWhile we strive for excellent results, we cannot guarantee specific revenue outcomes as many factors beyond our control affect sales success.\n\n14. Indemnification\nYou agree to indemnify, defend, and hold harmless Lead Genisys LLC, its officers, directors, employees, and agents from and against any claims, damages, losses, liabilities, costs, and expenses (including reasonable attorneys' fees) arising from or related to: your use of our services, your violation of these Terms, your violation of any rights of another party, or any content or information you provide to us.\n\n15. Dispute Resolution\nGoverning Law: These Terms shall be governed by and construed in accordance with the laws of the State of Florida, without regard to its conflict of law principles.\nInformal Resolution: Before initiating any legal proceeding, you agree to first contact us at ethan@leadgenisys.com to attempt to resolve any dispute informally.\nArbitration: Any dispute arising from these Terms or your use of our services that cannot be resolved informally shall be settled by binding arbitration in accordance with the rules of the American Arbitration Association. The arbitration shall take place in Florida.\n\n16. Changes to Terms\nWe reserve the right to modify these Terms at any time. We will provide notice of material changes by updating the \"Last Updated\" date and, where appropriate, by sending an email notification. Your continued use of our services after such changes constitutes acceptance of the new Terms.\n\n17. Contact Information\nIf you have any questions about these Terms of Service, please contact us:\nLead Genisys LLC\n2 Dalton Lane, Hampton, NH 03842\nPhone: +1 213-510-1418\nEmail: ethan@leadgenisys.com\nWebsite: https://contractors.leadgenisys.com/contact"

const REFUND_POLICY_TEXT = "DRAFT — pending legal review by the owner of Lead Genisys. This is not counsel-approved policy text.\nVersion: 2026-11-19\n\nThis draft repeats the refund terms Lead Genisys already publishes. It does not add a new price.\n\nTrial. A new signup is a 30-day free trial. $0 is due today. Cancel within 30 days and you pay nothing. That is the line on the Lead Genisys signup checkout (\"Cancel within 30 days, pay nothing\" and \"Due today $0.00\").\n\nAfter a charge, the Terms of Service last updated August 6, 2026, section 10, state:\n- Setup and creative work are non-refundable once work has commenced.\n- Fees paid for the current service period are non-refundable.\n- Unused prepaid services may be credited toward future services at Lead Genisys LLC's discretion.\n\nIf you are not bringing your own domain, the price of the domain you requested is still charged on your next invoice. This page does not state that domain's price."

const CANCELLATION_POLICY_TEXT = "DRAFT — pending legal review by the owner of Lead Genisys. This is not counsel-approved policy text.\nVersion: 2026-11-19\n\nThis draft repeats the cancellation terms Lead Genisys already publishes. It does not add a new price.\n\nTrial. Cancel within 30 days of signup and you pay nothing. That is the line on the Lead Genisys signup checkout.\n\nAfter the trial, the Terms of Service last updated August 6, 2026, section 10, state: Either party may cancel services with 30 days written notice. Cancellation requests should be sent to ethan@leadgenisys.com. Upon cancellation, hosting, AI follow-up, and review automation are discontinued at the end of the current billing period."

const RECURRING_BILLING_TEXT = "DRAFT — pending legal review by the owner of Lead Genisys. This is not counsel-approved policy text.\nVersion: 2026-11-19\n\nThis draft repeats the billing schedule Lead Genisys already shows at signup. It does not add a new price.\n\n$0 due today on the 30-day free trial, then $297 per month.\nA card is required to start the trial. After the 30-day trial, the card on file is charged $297 per month. Subscription fees are billed monthly in advance and continue until cancelled, which is what section 5 of the Terms of Service (last updated August 6, 2026) states.\n\nIf you are not bringing your own domain, the price of the domain you requested is still charged on your next invoice. This page does not state that domain's price."

const TERMS_SUMMARY = [
  'Lead Genisys LLC Terms of Service, last updated August 6, 2026, version 2026-08-06.',
  'Contact for these terms is ethan@leadgenisys.com (Lead Genisys LLC, 2 Dalton Lane, Hampton, NH 03842, +1 213-510-1418).',
  'Section 5: the core offer is a monthly subscription. Subscription fees are billed monthly in advance and continue until cancelled in accordance with section 10.',
  'Section 10: either party may cancel services with 30 days written notice sent to ethan@leadgenisys.com. Hosting, AI follow-up, and review automation are discontinued at the end of the current billing period.',
  'Refunds in section 10: setup and creative work are non-refundable once work has commenced; fees paid for the current service period are non-refundable; unused prepaid services may be credited toward future services at Lead Genisys LLC\'s discretion.',
  'Stopping SMS messages by texting STOP, or otherwise leaving the text program, is not cancellation of the subscription.',
].join(' ')

const REFUND_SUMMARY = [
  'A new signup is a 30-day free trial. $0 is due today. Cancel within 30 days and you pay nothing.',
  'After a charge, the Terms of Service last updated August 6, 2026, section 10, state: setup and creative work are non-refundable once work has commenced; fees paid for the current service period are non-refundable; unused prepaid services may be credited toward future services at Lead Genisys LLC\'s discretion.',
  'If you are not bringing your own domain, the price of the domain you requested is still charged on your next invoice. This does not state that domain\'s price.',
].join(' ')

const CANCELLATION_SUMMARY = [
  'Cancel within 30 days of signup and you pay nothing.',
  'After the trial, either party may cancel services with 30 days written notice. Cancellation requests should be sent to ethan@leadgenisys.com.',
  'Upon cancellation, hosting, AI follow-up, and review automation are discontinued at the end of the current billing period.',
].join(' ')

const RECURRING_SUMMARY = [
  BILLING_SUMMARY,
  'A card is required to start the trial. After the 30-day trial, the card on file is charged $297 per month.',
  'Subscription fees are billed monthly in advance and continue until cancelled in accordance with section 10 of the Terms of Service (last updated August 6, 2026): 30 days written notice to ethan@leadgenisys.com.',
  'If you are not bringing your own domain, the price of the domain you requested is still charged on your next invoice. This does not state that domain\'s price.',
].join(' ')

function edition(row: Omit<PolicyEdition, 'textUrl' | 'textHash'>): PolicyEdition {
  return {
    ...row,
    textUrl: POLICY_ORIGIN + row.path,
    textHash: policyTextHash(row.text),
  }
}

export const POLICY_EDITIONS: readonly PolicyEdition[] = [
  edition({
    kind: 'terms',
    title: 'Terms of Service',
    version: PUBLISHED_TERMS_VERSION,
    draft: false,
    path: '/terms',
    text: TERMS_TEXT,
    summary: TERMS_SUMMARY,
  }),
  edition({
    kind: 'refund_policy',
    title: 'Refund Policy',
    version: DRAFT_POLICY_VERSION,
    draft: true,
    path: '/refund-policy',
    text: REFUND_POLICY_TEXT,
    summary: REFUND_SUMMARY,
  }),
  edition({
    kind: 'cancellation_policy',
    title: 'Cancellation Policy',
    version: DRAFT_POLICY_VERSION,
    draft: true,
    path: '/cancellation-policy',
    text: CANCELLATION_POLICY_TEXT,
    summary: CANCELLATION_SUMMARY,
  }),
  edition({
    kind: 'recurring_billing',
    title: 'Recurring Billing',
    version: DRAFT_POLICY_VERSION,
    draft: true,
    path: '/recurring-billing',
    text: RECURRING_BILLING_TEXT,
    summary: RECURRING_SUMMARY,
  }),
]

const KIND_SET = new Set<string>(POLICY_KINDS)

export function currentPolicy(kind: PolicyKind): PolicyEdition {
  const found = [...POLICY_EDITIONS].reverse().find((e) => e.kind === kind)
  if (!found) throw new Error('no policy edition for ' + kind)
  return found
}

/**
 * The edition whose text the intake actually hashed.
 * Version and textUrl are cited by the caller from the record. They do not
 * select a different summary: a hash that is missing or unknown matches nothing.
 */
export function policyEditionForAcceptance(ack: { kind: string; textHash?: string | null }): PolicyEdition | null {
  if (!KIND_SET.has(ack.kind)) return null
  const hash = (ack.textHash ?? '').trim().toLowerCase()
  if (!/^[0-9a-f]{64}$/.test(hash)) return null
  return POLICY_EDITIONS.find((e) => e.kind === ack.kind && e.textHash === hash) ?? null
}

/** Product line for Stripe. Price and cancellation contact come from the pages above. */
export const PRODUCT_DESCRIPTION = [
  'Lead Genisys LLC provides done-for-you websites, AI-powered text and email follow-up, appointment scheduling, CRM automation, and review requests for home service contractors.',
  'The signup offer is ' + BILLING_SUMMARY,
  'A card is required to start the trial. After the 30-day trial the card on file is charged $297 per month, billed monthly in advance, until cancelled with 30 days written notice to ' + POLICY_CONTACT_EMAIL + '.',
  'Cancel within 30 days of signup and you pay nothing.',
  "If the client is not bringing their own domain, the price of the domain they requested is charged on the next invoice. This description does not state that domain's price.",
].join(' ')
