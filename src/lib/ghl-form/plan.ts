/**
 * The site form every new client's GHL sub-account gets from the snapshot
 * ("A Plus Fence & Construction Forms"), made the client's own. Pure so it is
 * unit-tested; ./browser.ts does it in GHL and ./queue.ts runs it on the
 * browser worker. Alex, 2026-11-13: "so I don't have to do this manual
 * customization every single time for every client".
 *
 * Seen in GHL on 2026-11-13:
 * - The two consent checkboxes are the options of one Checkbox custom field
 *   (named "a", key contact.a, folder "Form | Form 0"). GHL's public API can't
 *   change checkbox options, so they are edited in Settings → Custom Fields →
 *   the field's pencil → the "Update field" drawer (inputs with placeholder
 *   "Enter option", button "Update field"). The form shows the field's options.
 * - The snapshot (v2, 2026-11-13) no longer has the A Plus logo or the two
 *   "Script Added!" blocks, which linked to aplusconstruction.org's privacy
 *   policy and terms (Ethan's site template shows the client's own links under
 *   the form). Sub-accounts made before it still have them; those are removed
 *   in the form builder (an iframe from leadgen-apps-form-survey-builder).
 * - The public form (api.leadconnectorhq.com/widget/form/<id>) shows what a
 *   lead sees, without signing in: the result is checked there.
 */

export const TEMPLATE_FORM = 'A Plus Fence & Construction Forms'

const templateName = () => /A\s*Plus\s+Fence\s*(?:&|and)\s*Construction/gi

/** Does this text name the template business (A Plus Fence & Construction)? */
export function mentionsTemplate(text: string): boolean {
  return templateName().test(text)
}

/** The name the consent text gives the client: their business name from onboarding, else the client's name. */
export function consentName(o: { businessName?: string | null; clientName: string }): string {
  return (o.businessName?.trim() ? o.businessName : o.clientName).replace(/\s+/g, ' ').trim()
}

/** A consent option with the template business's name swapped for the client's. */
export function renameConsent(option: string, business: string): string {
  return option.replace(templateName(), business.replace(/\s+/g, ' ').trim())
}

/** The drawer's options renamed for the client; null when none names the template (nothing to change). */
export function renamedOptions(options: string[], business: string): string[] | null {
  if (!business.trim() || !options.some(mentionsTemplate)) return null
  return options.map((o) => renameConsent(o, business))
}

/** Is this one of the snapshot's consent options (named or already renamed)? */
export function isConsentOption(text: string): boolean {
  return /By checking this box/i.test(text)
}

/** What a lead sees on the public form. */
export type PublicForm = { text: string; images: number; links: string[] }

/** The template's leftovers the form builder has to remove (sub-accounts made before snapshot v2). */
export function builderWork(f: PublicForm): { logo: boolean; links: boolean } {
  return { logo: f.images > 0, links: f.links.some((h) => /aplusconstruction\.org/i.test(h)) }
}

const squash = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase()

/** What's still wrong with the public form for this client; empty when it's theirs. */
export function formProblems(f: PublicForm, business: string): string[] {
  const out: string[] = []
  if (!isConsentOption(f.text)) out.push('its consent checkboxes are missing')
  if (mentionsTemplate(f.text)) out.push('it still says A Plus Fence & Construction')
  else if (business.trim() && !squash(f.text).includes(squash(business))) out.push(`its consent doesn't name ${business.trim()}`)
  const left = builderWork(f)
  if (left.logo) out.push('it still shows the A Plus logo')
  if (left.links) out.push('it still links to A Plus’s privacy policy and terms')
  return out
}

/** Where a lead fills it in, and the address Ethan's site embeds. */
export function publicFormUrl(formId: string): string {
  return `https://api.leadconnectorhq.com/widget/form/${formId}`
}
