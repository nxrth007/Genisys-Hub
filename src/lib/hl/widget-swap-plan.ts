/**
 * Swapping a client's website from GoHighLevel's quote form and chat bubble to Hell-level's (Alex,
 * 2026-11-14: clients that aren't A2P or toll-free verified on GoHighLevel move to Hell-level). Pure
 * (tests load it): who is never swapped, what Lovable is asked, and how the site's code and the live
 * site show it's done. ./widget-swap.ts runs it.
 */

/**
 * The 13 clients verified on GoHighLevel (A2P, or toll-free for Gary Shining) stay there for now
 * (Alex, 2026-11-14): their sites keep GoHighLevel's form and chat. Matched on the business name
 * with spaces and punctuation dropped.
 */
const STAYS_ON_GHL = [
  'aplusfence',
  'a1mconstruction',
  'bluediamondconstruction',
  'cjconcretecoatings',
  'esparzasolutions',
  'esparazasolutions',
  'garyshining',
  'robertpaulcontracting',
  'varietypros',
  'roofrejuvenate',
  'royaldriveway',
  'venturaproject',
  'skystonehomes',
  'lmspest',
]

export function staysOnGhl(name: string | null | undefined): boolean {
  const n = (name ?? '').toLowerCase().replace(/[^a-z0-9]/g, '')
  return !!n && STAYS_ON_GHL.some((s) => n.includes(s))
}

/** The ids the swap puts on the site: the sub-account's quote form and its chat widget. */
export type SwapIds = { formId: string; chatId: string }

/** The one message to the client's Lovable project: both swaps, nothing else changed. */
export function widgetSwapMessage(embeds: { form: string; chat: string }): string {
  return [
    'Switch this website’s quote form and chat bubble from GoHighLevel to ours. Change nothing else: the text, images, colours, layout and pages stay exactly as they are.',
    '',
    '1. The quote form. Wherever the site shows a GoHighLevel / LeadConnector form (an iframe from leadconnectorhq.com or msgsndr.com, for example in the hero and in the contact or get-a-quote section), put this form in its place, full width, keeping the heading and layout around it, with the small script right after it so the form resizes to fit. Remove the old form’s code. Leave any GoHighLevel booking calendar as it is.',
    '',
    embeds.form,
    '',
    '2. The chat bubble. Remove the GoHighLevel / LeadConnector chat widget (a <chat-widget> tag, or the widgets.leadconnectorhq.com loader script) and load this script once, in the root layout just before the closing body tag, so the site has exactly one chat bubble:',
    '',
    embeds.chat,
    '',
    'Use both embed codes exactly as given: the same addresses and ids.',
  ].join('\n')
}

/** One line Lovable's code search found. */
export type CodeHit = { path: string; line: number; text: string }

/** Notes and plans in the project (Lovable's .lovable folder, docs, READMEs) aren't the site's code. */
const notCode = (path: string) => /(^|\/)(\.lovable|docs?)\//i.test(path) || /\.(md|mdx|txt)$/i.test(path) || /(^|\/)package(-lock)?\.json$/i.test(path)

const BOOKING = /widget\/(booking|bookings|appointment|calendars?|group)\b|form_embed\.js/i
const GHL_FORM = /widget\/(form|survey|quiz)\b/i
const GHL_CHAT = /widgets\.leadconnectorhq\.com|chat-widget|data-widget-id/i

/**
 * GoHighLevel's form and chat in the code, from searches for "leadconnectorhq", "msgsndr" and
 * "chat-widget". A booking calendar stays (it isn't part of the swap), and so does the form_embed.js
 * resizer it may use.
 */
export function ghlInCode(hits: CodeHit[]): { form: CodeHit[]; chat: CodeHit[] } {
  const seen = new Set<string>()
  const form: CodeHit[] = []
  const chat: CodeHit[] = []
  for (const h of hits) {
    const key = `${h.path}:${h.line}`
    if (seen.has(key) || notCode(h.path) || BOOKING.test(h.text)) continue
    seen.add(key)
    if (GHL_FORM.test(h.text)) form.push(h)
    else if (GHL_CHAT.test(h.text)) chat.push(h)
  }
  return { form, chat }
}

/** Whether the code holds Hell-level's form and chat: its form id, and the widget script with its chat id. */
export function hlInCode(o: { formHits: CodeHit[]; widgetHits: CodeHit[]; chatHits: CodeHit[] }): { form: boolean; chat: boolean } {
  const code = (hs: CodeHit[]) => hs.some((h) => !notCode(h.path))
  return { form: code(o.formHits), chat: code(o.widgetHits) && code(o.chatHits) }
}

const where = (hs: CodeHit[]) =>
  hs
    .slice(0, 4)
    .map((h) => `${h.path} line ${h.line}`)
    .join(', ')

/** What's still to do in the code, one line each (none: the code is swapped). */
export function codeGaps(o: { ghl: { form: CodeHit[]; chat: CodeHit[] }; hl: { form: boolean; chat: boolean } }): string[] {
  return [
    o.ghl.form.length ? `GoHighLevel’s form is still in the code (${where(o.ghl.form)}): replace it with our form.` : null,
    o.ghl.chat.length ? `GoHighLevel’s chat widget is still in the code (${where(o.ghl.chat)}): remove it.` : null,
    !o.hl.form ? 'Our form (the iframe from the first message) isn’t in the code yet.' : null,
    !o.hl.chat ? 'Our chat script (widget.js, from the first message) isn’t in the root layout yet.' : null,
  ].filter((x): x is string => !!x)
}

/** The one follow-up when Lovable's turn left something undone. */
export function followUpMessage(gaps: string[]): string {
  return ['Almost there. Still to do, changing nothing else:', ...gaps.map((g) => `- ${g}`), '', 'Use the embed codes from my last message exactly as given.'].join('\n')
}

export type LiveState = { ghlForm: boolean; ghlChat: boolean; hlForm: boolean; hlChat: boolean }

/** What the live site's own code (its page and the scripts it loads) embeds. */
export function liveState(code: string, ids: SwapIds): LiveState {
  return {
    ghlForm: /leadconnectorhq\.com\/widget\/(?:form|survey|quiz)\/|msgsndr\.com\/widget\/(?:form|survey|quiz)\//i.test(code),
    ghlChat: /widgets\.leadconnectorhq\.com|<chat-widget|["']chat-widget["']|data-widget-id/i.test(code),
    hlForm: code.includes(ids.formId),
    hlChat: code.includes('/hl/widget.js') && code.includes(ids.chatId),
  }
}

/**
 * The live site shows the swap: Hell-level's chat (in the root layout, so on the home page) and no
 * GoHighLevel form or chat. The form can sit on a page the home page doesn't load, so it's proven by
 * the code check before publishing; on the live site it only must not be GoHighLevel's.
 */
export const liveSwapped = (s: LiveState): boolean => s.hlChat && !s.ghlChat && !s.ghlForm

/** What's wrong on the live site, in a sentence; null when it's swapped. */
export function liveGaps(s: LiveState): string | null {
  const gaps = [
    !s.hlChat && 'Hell-level’s chat bubble isn’t on it',
    s.ghlForm && 'GoHighLevel’s form is still on it',
    s.ghlChat && 'GoHighLevel’s chat is still on it',
  ].filter((x): x is string => !!x)
  return gaps.length ? `${gaps.join('; ')}.` : null
}
