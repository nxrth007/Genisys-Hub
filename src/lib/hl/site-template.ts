/**
 * Ethan's Lovable one-shot for a new client site (pure; no imports).
 *
 * Ethan remixes Robert Taylor's Lovable site and sends the copy this prompt,
 * filled from the client's onboarding answers. His template ("With
 * Variables.txt", 2026-11-13) is kept word for word except:
 *   - sections 4, 5 and 8 put the client's Hell-level quote form and chat
 *     widget on the site instead of GHL's (wording from
 *     src/components/hell-level/embed.ts), and the GHL form-height rule is
 *     gone: the iframe sizes itself;
 *   - "his photos" reads "the client's photos" (owners aren't all men);
 *   - an optional line for other facts the owner supplied (financing, free
 *     estimates…), which Ethan's filled examples add by hand;
 *   - each photo link carries what it shows, so Lovable can place it.
 *
 * Fill it with renderOneShot(vars): {{NAME}} takes a value, and
 * [IF NAME] … [/IF] / [IF NO NAME] … [/IF] / [IF A OR B] … [/IF] keep their
 * text only when the condition holds (a value counts when it isn't blank).
 */

export const ONE_SHOT_TEMPLATE = `# LOVABLE ONE-SHOT — {{LEGAL_NAME}}

Keep this project exactly the same, but swap out the current information with the following.
- You can generate AI images where needed. Make sure they make sense for the actual section and its description. Do not mess this up.
- Make sure you use the client's photos and match each photo with the correct service and description.
- Every section must use different photos. Never reuse the same photo (real or generated) in more than one section, so no section looks like a copy of another.
- AI-generated photos must look like real, professional job-site photography, not AI art: natural lighting, realistic textures and imperfections, true-to-life proportions, real-world settings, and believable details (tools, materials, homes). People may appear only if their faces are not visible: show them from behind, cropped at the shoulders, or as hands and arms at work. Never show a face, even partially or blurred. No glossy or plastic surfaces, no over-saturated colors, no warped hands, text, or logos, and no fantasy-perfect scenes.
- Never add captions, labels, badges, or disclaimers to any image. Do not write "Illustrative image," "Illustration," "Stock photo," "AI-generated," "Representative image," "Example," or any similar text under, over, or near an image, or anywhere else on the site, including alt text, tooltips, and footers. Images should appear clean, with no text attached.
- You'll have to generate the client's logo. Make it an icon logo (a clean, original icon mark next to the business name) that's legible at small sizes, plus a matching favicon from the icon.
- Make "Our Services" centered, and center anything that isn't 3 across in the rest of the project.
- Image layout: if a section has 4 images, put all 4 on one row. If a section has 6 images, show them as two rows of 3. On mobile, let them stack so they stay readable.
- Do not add any sections that aren't currently in this project template. Just replace content. If a section mentioned below doesn't exist in the template, skip it.
- Make sure it has a map in the proper section, exactly like it is in this project. If they have many service areas, zoom the map out to cover most of the service area.
- Make sure every service in the service dropdowns has an icon.
- Only create 9 blog posts.
- Use as few credits as possible while still completing every task in this prompt. Make all changes in as few passes as possible, edit existing components instead of rebuilding them, and only generate AI images where a real photo isn't available.

## 1. BUSINESS INFORMATION — USE THESE DETAILS EXACTLY

- **Business name:** {{LEGAL_NAME}}
- **Display name:** {{DISPLAY_NAME}}
- **Owner/contact:** {{OWNER_NAME}}
- **Phone:** {{PHONE_DISPLAY}} (tel:{{PHONE_E164}})
- **Email:** {{EMAIL}}
- **Business address (Terms and Privacy pages only):** {{FULL_ADDRESS}}. Everywhere else on the site, show the location as "{{CITY_STATE}}" only. Do not invent a ZIP code or coordinates.
- **Service area:** {{SERVICE_AREA_SUMMARY}}
- **Time zone:** {{TIME_ZONE}}
- **Domain:** {{DOMAIN}}
[IF YEAR_STARTED] - **Year established:** {{YEAR_STARTED}}. Display as "Serving {{SERVICE_AREA_SUMMARY}} since {{YEAR_STARTED}}." [/IF]
[IF NO YEAR_STARTED] - **Year established:** Not provided. Do not display a founding year or years in business. [/IF]
[IF EXPERIENCE_LINE] - **Experience:** {{EXPERIENCE_LINE}}. Always describe this as experience, never as the company's age. [/IF]
[IF LICENSE_LINE] - **License/registration:** {{LICENSE_LINE}}. Display it exactly as written in the footer and contact section. Do not add insurance, bonding, or other license claims. [/IF]
[IF NO LICENSE_LINE] - **License information:** None provided. Do not claim the business is licensed, insured, bonded, or certified, and do not invent a license number. [/IF]
[IF SOCIAL_LINKS] - **Social media:** {{SOCIAL_LINKS}} [/IF]
[IF NO SOCIAL_LINKS] - **Social media:** None. Remove any social icons from the template. [/IF]
[IF GBP_LINK] - **Google Business Profile:** {{GBP_LINK}} [/IF]
- **Reviews:** Do not create testimonials, star ratings, or review counts.
[IF EXTRA_FACTS] - **Also supplied by the owner (use exactly as written; don't add terms, rates or conditions):** {{EXTRA_FACTS}} [/IF]

**About (supplied by the owner):** {{ABOUT}}

**Why choose us (supplied by the owner):**
{{WHY_CHOOSE_US}}

[IF PROMO] **Current promotion (use exactly):** {{PROMO}}. Do not invent other discounts, eligibility rules, or expiration dates. [/IF]
[IF NO PROMO] **Special offer:** None. Remove any promotions or discounts from the template. [/IF]

[IF TRADE_CLAIM_RULES]
## 1B. TRADE CLAIM RULES — STRICT
{{TRADE_CLAIM_RULES}}
[/IF]

## 2. COLORS AND DESIGN SYSTEM — MATCH THE LOGO

The client's colors are: {{BRAND_COLORS}}. {{COLOR_DIRECTION}} Create the icon logo in these colors, then pull the exact colors from that logo and build the entire design system around them:
- All buttons and CTAs (primary and secondary), including hover and active states
- All banners, hero overlays, promo strips, and section header bars
- Header, navigation, footer, and the fixed mobile call bar
- Links, icons (including the service dropdown icons), dividers, and accent elements
- Section backgrounds: white and light tints of the logo colors, with charcoal text

Define the logo colors once as CSS variables/design tokens and use them everywhere, so the entire site is visually consistent with the logo. Do not introduce colors that aren't in the logo, other than neutral white, light gray, and charcoal. Keep text contrast accessible.

## 3. CONTENT TO SWAP IN

### Hero
- Headline: **{{HERO_HEADLINE}}**
- Supporting copy: "{{HERO_COPY}}"
- Primary CTA: "{{PRIMARY_CTA}}"
- Secondary CTA: "Call {{PHONE_DISPLAY}}"
[IF PROMO] - Promo callout: "{{PROMO}}" [/IF]
- Hero image: {{HERO_IMAGE}}
- Do not claim free estimates (unless supplied), same-day or emergency service, warranties, guarantees, financing, or pricing.

### Our Services (centered; every service needs an icon in the dropdown)
Give each a concise, accurate description. Do not invent materials, brands, methods, timelines, warranties, permit handling, or prices.

{{SERVICES_LIST}}

### Photos
- View each of the client's photos and place it with the service it actually shows. Use the rest in the gallery.
- Do not invent captions, customer names, cities, or project descriptions. Write alt text based on what each photo actually shows.
- Exclude any image that is a logo, document, EIN letter, or screenshot of text or messages.
- Where a section has no matching real photo, generate a realistic, photo-style image that clearly shows that exact service, each one different, with no visible faces: {{AI_IMAGE_SCENES}}

[IF CLIENT_PHOTO_URLS]
The client's photos (after each link: what it shows). Save them into the project and use the saved copies rather than linking to these addresses:
{{CLIENT_PHOTO_URLS}}
[/IF]
[IF NO CLIENT_PHOTO_URLS]
The client has not supplied photos. Generate realistic, photo-style images for every image slot as described above.
[/IF]

### Why Choose Us (replace existing content only)
{{WHY_CHOOSE_US}}

Do not invent review counts, project totals, awards, certifications, licensing, insurance, warranties, or claims of being "the best."

[IF GBP_LINK]
### Reviews
If the template has a reviews area, replace it with a simple button linking to the client's Google Business Profile: {{GBP_LINK}}. Do not offer any discount or reward for leaving a review.
[/IF]

### Service Areas
Replace ALL existing service areas with:
{{SERVICE_AREA_LIST}}

Do not add extra cities without approval.

**Map:** Keep the map in the same section it is in now. {{MAP_INSTRUCTIONS}} Do not pin a street address.

### FAQ (replace existing questions)
{{FAQ_BLOCK}}

Do not promise prices, timelines, free estimates (unless supplied), permits, licensing, insurance, or warranties beyond what is stated in this prompt.

### Blog (replace existing posts with 9 GEO/SEO-optimized posts)
Write exactly 9 original posts for homeowners in {{SERVICE_AREA_SUMMARY}} using GEO/SEO best practices: one clear H1, a direct answer near the top, scannable H2/H3s, short FAQ blocks, regional context ({{REGION_CONTEXT}}), internal links to services and the estimate form, and a CTA at the end. Do not invent statistics, prices, building codes, regulations, or customer stories. Use varied images with no captions.

Suggested topics:
{{BLOG_TOPICS}}

### Footer
- Logo and business name
- ALL services
- Service areas: {{SERVICE_AREA_SUMMARY}}
- Phone and email
[IF LICENSE_LINE] - "{{LICENSE_LINE}}" [/IF]
[IF SOCIAL_LINKS OR GBP_LINK] - Social and Google Business Profile links [/IF]
- Privacy Policy and Terms of Service links
- © {{LEGAL_NAME}}

## 4. QUOTE FORM — REPLACE THE EXISTING HERO FORM

Replace the existing SMS opt-in consent form in the hero (and the contact section) with our hosted quote form. Embed this iframe where the form is (full width), keep the surrounding heading and layout, and include the small script right after it so the iframe resizes to fit. Use it exactly as given: do not rebuild it or alter the form ID. Remove any old GoHighLevel / LeadConnector form embed (its iframe and its form_embed.js script). Don't give the form's container a fixed height or a max-height: the iframe sets its own height, so nothing is clipped.

{{FORM_EMBED}}

## 5. CHAT WIDGET — REPLACE THE EXISTING CHATBOT

Remove the current chatbot and add our chat widget to every page of the site. Load this script once, in the root layout, just before the closing body tag. Remove the old GoHighLevel / LeadConnector chat widget (its <chat-widget> tag and its leadconnectorhq loader script), so there's only one chat bubble; don't remove any other scripts. Make sure it doesn't cover buttons, the mobile call bar, or the form.

{{CHAT_WIDGET_CODE}}

## 6. A2P COMPLIANCE — REPLACE THE PRIVACY POLICY AND TERMS OF SERVICE

Replace the existing Terms of Service and Privacy Policy content with the text below. Keep the "Last updated" date at the top set to the publish date.

### Terms of Service

By using this website, submitting a form, or joining our text messaging program, you agree to these terms. You must be at least 18 years old to use this site, request a quote, or receive text messages from us.

**Website information**
Website content is general information. Services, availability, timing, and pricing are confirmed in a written estimate or agreement.

**Quote requests**
Submitting a form or sending an email does not create a contract. A project begins only after both parties accept a written agreement.

**SMS text messaging program**
{{LEGAL_NAME}} operates a customer service and project messaging program for customers who ask to hear from us.

- How you join: check the optional, unchecked consent box on the quote form {{DOMAIN_AT}}, give verbal or written consent during a consultation or phone call, or text us first at {{PHONE_DISPLAY}}. Consent is never a condition of purchase and is never bought from a third party.
- Use cases and message types: replies to quote requests, estimate details, appointment scheduling and reminders, crew arrival and project status updates, questions needed to complete your project, invoice and payment notices, and occasional promotional offers from {{LEGAL_NAME}}.
- Message frequency: varies with your project. Generally no more than 4 to 8 messages per month. Conversational replies happen as needed.
- Message and data rates: message and data rates may apply, based on your plan with your mobile carrier. We do not charge a fee for these messages.
- Opt out: reply STOP to any message at any time to end all texts. You will receive one confirmation, then no further messages. You can also call {{PHONE_DISPLAY}} or email {{EMAIL}} to be removed.
- Help and support: reply HELP, call {{PHONE_DISPLAY}}, or email {{EMAIL}}.
- Supported carriers: major U.S. carriers, including AT&T, Verizon, T-Mobile, and their affiliates. Carrier support may change.
- Carrier liability: mobile carriers are not liable for delayed or undelivered messages.
- Privacy: we do not sell or share your mobile number or SMS consent with third parties or affiliates for marketing.
- Devices: messaging requires a compatible mobile device and an active plan with text messaging.

**Acceptable use**
Do not use this site or our messaging to send unlawful, abusive, or misleading content, or to attempt to disrupt the site.

**Intellectual property**
Website copy, branding, photography, and original materials may not be reproduced without permission.

**Limitation of liability**
We work to keep website information accurate but cannot promise that every page will always be error-free or uninterrupted. To the extent allowed by law, we are not liable for indirect or incidental damages arising from use of this website or the messaging program.

**Changes**
We may update these terms and will post the revised date above.

**Contact and support**
{{LEGAL_NAME}}, {{FULL_ADDRESS}}. {{PHONE_DISPLAY}}. Email: {{EMAIL}}. Support hours: by appointment, Monday through Saturday.

### Privacy Policy

{{LEGAL_NAME}} ("we", "us", "our") respects your privacy. This policy explains what we collect through this website and our text messaging program, how we use it, how we protect it, and the choices you have.

**Information we collect**
We collect only what we need to respond to you:

- Contact details you submit: name, phone number, email address.
- Project details: the service you need and anything you tell us about your home or project.
- Consent records: whether you checked the text message consent box, plus the date, time, and page where you gave consent.
- Basic technical information from standard hosting and analytics tools, such as browser type, device type, pages viewed, and approximate location by region.

We do not knowingly collect information from anyone under 18. Our services and text messaging program are for adults 18 and older.

**How we use information**
- To reply to your quote request and schedule a consultation.
- To send estimates, appointment reminders, and project updates by phone, text, or email.
- To provide and improve our services and our website.
- To meet legal, tax, insurance, and record keeping obligations.

**SMS text messaging opt-in**
Text message consent is separate and optional. You opt in by checking the unchecked text message consent box on our quote form, or by texting us first at {{PHONE_DISPLAY}}. Consent is never required to get a quote or hire us.

- Program: {{LEGAL_NAME}} customer service and project messaging.
- Message types: estimate and quote follow-ups, appointment scheduling and reminders, project updates, and occasional promotional offers.
- Frequency: varies by project, generally no more than 4 to 8 messages per month.
- Cost: message and data rates may apply. We do not charge for the messages.
- Opt out: reply STOP to any message to stop all texts. Reply HELP for help, or contact us at {{PHONE_DISPLAY}} or {{EMAIL}}.
- Carriers: mobile carriers are not liable for delayed or undelivered messages.
- No sharing of SMS consent or phone numbers: We do not sell, rent, trade, or share your mobile phone number, your text message consent, or the contents of your messages with any third party, affiliate, lead buyer, or marketing partner for their own marketing purposes. Phone numbers collected for SMS are used only by {{LEGAL_NAME}} to communicate with you, and are shared only with the messaging service provider that delivers our texts on our behalf under contract.

**Cookies and tracking**
Our website uses cookies and similar technologies for essential site function, remembering preferences, and understanding how visitors use our pages. We may use privacy-respecting analytics to count visits and see which pages perform well. You can block or delete cookies in your browser settings; essential parts of the site will still work. We do not run cross-site advertising trackers that build profiles of you.

**Sharing and retention**
We may share information with service providers who help us run the website, host data, deliver messages and email, and manage estimates. They may use it only to provide services to us. We may also disclose information if required by law or to protect our rights. We keep information only as long as reasonably needed for business, insurance, warranty, and legal purposes, then delete or anonymize it.

**Data security**
We use reasonable administrative and technical safeguards, including encrypted connections (HTTPS) for data sent through this site, access limited to staff who need it, and reputable vendors with their own security controls. No method of transmission or storage is completely secure, so we cannot guarantee absolute security.

**Your rights and choices**
- Unsubscribe from texts: reply STOP.
- Unsubscribe from email: use the unsubscribe link or email us.
- Do not call: ask us to stop calling and we will.
- Access, update, or delete: email {{EMAIL}} and we will confirm and act on your request.
- No sale of personal information: we do not sell your personal information.

**Changes**
If we update this policy we will change the date above and post the new version on this page.

**Contact**
{{LEGAL_NAME}}, {{FULL_ADDRESS}}. {{PHONE_DISPLAY}}. Email: {{EMAIL}}

## 7. SEO

- Page title: "{{DISPLAY_NAME}} | {{TRADE}} in {{CITY_STATE}}"
- Meta description: one or two sentences naming the main services, the main service areas, and "Call {{PHONE_DISPLAY}}." Include the promotion or the license line only if one is given above.
[IF DOMAIN IS A REAL DOMAIN] - Canonical URL: https://{{DOMAIN}} [/IF]
- LocalBusiness structured data: name, phone, email, {{CITY_STATE}}, areaServed ({{SERVICE_AREA_SUMMARY}}), foundingDate (only if supplied), and sameAs (only real social/GBP links). Do not invent reviews, ratings, licenses, hours, or prices.

## 8. FINAL CHECK

1. Name is "{{LEGAL_NAME}}" (legal pages, footer) or "{{DISPLAY_NAME}}" (display), owner is {{OWNER_NAME}}, phone is {{PHONE_DISPLAY}}, and email is {{EMAIL}}.
2. A new icon logo and favicon were generated in the brand colors.
3. No new sections were added; only content was replaced.
4. "Our Services" is centered, every service has an icon in the dropdown, anything not 3 across is centered, 4-image sections are on one row, and 6-image sections are two rows of 3.
5. Client photos are matched to the correct services, every section uses different images, AI images look like real photos, and no image shows a face.
6. No image anywhere has a caption, label, or "Illustrative image" text.
7. The map is in its original section, covering the service area, with no street address pinned.
8. Our quote form (iframe id hl-form-{{FORM_ID}}, with its resize script) is in the hero and the contact section, and our chat widget (data-form="{{WIDGET_ID}}") loads once on every page, both exactly as given. No GoHighLevel / LeadConnector form or chat is left, the form grows to fit with nothing clipped, and the chat bubble covers nothing.
9. The street address appears only on the legal pages.
10. Only supplied promotions, licenses, and claims appear. No invented licensing, insurance, warranty, pricing, or review claims.
11. Exactly 9 blog posts are live.
12. Buttons, banners, header, footer, icons, and accents all use the colors from the generated logo, defined once as design tokens and applied consistently.
13. Test on desktop and mobile.
`

/** Every {{NAME}} the template uses. */
export const ONE_SHOT_VARIABLES = [
  'LEGAL_NAME',
  'DISPLAY_NAME',
  'OWNER_NAME',
  'PHONE_DISPLAY',
  'PHONE_E164',
  'EMAIL',
  'FULL_ADDRESS',
  'CITY_STATE',
  'SERVICE_AREA_SUMMARY',
  'SERVICE_AREA_LIST',
  'TIME_ZONE',
  'DOMAIN',
  'DOMAIN_AT',
  'YEAR_STARTED',
  'EXPERIENCE_LINE',
  'LICENSE_LINE',
  'SOCIAL_LINKS',
  'GBP_LINK',
  'EXTRA_FACTS',
  'ABOUT',
  'WHY_CHOOSE_US',
  'PROMO',
  'TRADE_CLAIM_RULES',
  'BRAND_COLORS',
  'COLOR_DIRECTION',
  'TRADE',
  'REGION_CONTEXT',
  'HERO_HEADLINE',
  'HERO_COPY',
  'HERO_IMAGE',
  'PRIMARY_CTA',
  'SERVICES_LIST',
  'AI_IMAGE_SCENES',
  'CLIENT_PHOTO_URLS',
  'MAP_INSTRUCTIONS',
  'FAQ_BLOCK',
  'BLOG_TOPICS',
  'FORM_EMBED',
  'FORM_ID',
  'CHAT_WIDGET_CODE',
  'WIDGET_ID',
] as const

export type OneShotVariable = (typeof ONE_SHOT_VARIABLES)[number]
export type OneShotVars = Record<OneShotVariable, string>

/** Variables that must never be blank: the prompt (and the legal pages) don't read without them. */
export const REQUIRED_VARIABLES: OneShotVariable[] = [
  'LEGAL_NAME',
  'DISPLAY_NAME',
  'OWNER_NAME',
  'PHONE_DISPLAY',
  'PHONE_E164',
  'EMAIL',
  'FULL_ADDRESS',
  'CITY_STATE',
  'SERVICE_AREA_SUMMARY',
  'SERVICE_AREA_LIST',
  'TIME_ZONE',
  'DOMAIN',
  'DOMAIN_AT',
  'ABOUT',
  'WHY_CHOOSE_US',
  'BRAND_COLORS',
  'COLOR_DIRECTION',
  'TRADE',
  'REGION_CONTEXT',
  'HERO_HEADLINE',
  'HERO_COPY',
  'HERO_IMAGE',
  'PRIMARY_CTA',
  'SERVICES_LIST',
  'AI_IMAGE_SCENES',
  'MAP_INSTRUCTIONS',
  'FAQ_BLOCK',
  'BLOG_TOPICS',
  'FORM_EMBED',
  'FORM_ID',
  'CHAT_WIDGET_CODE',
  'WIDGET_ID',
]

/** "acme.com" counts; "this website" (no domain yet) doesn't. */
export const isRealDomain = (d: string) => /^(?=.{4,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i.test(d.trim())

function holds(condition: string, vars: OneShotVars): boolean {
  const c = condition.trim()
  if (c === 'DOMAIN IS A REAL DOMAIN') return isRealDomain(vars.DOMAIN)
  const has = (name: string) => {
    const v = vars[name.trim() as OneShotVariable]
    if (v === undefined) throw new Error(`The one-shot template tests an unknown variable: ${name.trim()}`)
    return v.trim() !== ''
  }
  if (c.startsWith('NO ')) return !has(c.slice(3))
  return c.split(/\s+OR\s+/).some(has)
}

/**
 * The one-shot with every block decided and every variable filled. Throws
 * on a required variable left blank or anything left unfilled, so a broken
 * prompt never reaches Lovable.
 */
export function renderOneShot(vars: OneShotVars, template = ONE_SHOT_TEMPLATE): string {
  const blank = REQUIRED_VARIABLES.filter((k) => !(vars[k] ?? '').trim())
  if (blank.length) throw new Error(`The one-shot is missing ${blank.join(', ')}.`)
  const out: string[] = []
  let block: { keep: boolean } | null = null
  for (const line of template.split('\n')) {
    const inline = /^\s*\[IF ([^\]]+)\]\s?(.*?)\s?\[\/IF\]\s*$/.exec(line)
    if (inline) {
      if (!block || block.keep) {
        if (holds(inline[1], vars)) out.push(inline[2])
      }
      continue
    }
    const open = /^\s*\[IF ([^\]]+)\]\s*$/.exec(line)
    if (open) {
      if (block) throw new Error('The one-shot template nests [IF] blocks, which it can’t.')
      block = { keep: holds(open[1], vars) }
      continue
    }
    if (/^\s*\[\/IF\]\s*$/.test(line)) {
      if (!block) throw new Error('The one-shot template closes an [IF] block it never opened.')
      block = null
      continue
    }
    if (!block || block.keep) out.push(line)
  }
  if (block) throw new Error('The one-shot template leaves an [IF] block open.')
  // A dropped block leaves its blank lines behind: at most one empty line in a row.
  const text = out.join('\n').replace(/\n{3,}/g, '\n\n')
  // One pass, so a value is never read as a variable itself.
  const filled = text.replace(/\{\{([A-Z0-9_]+)\}\}/g, (_m, name: string) => {
    const v = vars[name as OneShotVariable]
    if (v === undefined) throw new Error(`The one-shot template uses an unknown variable: ${name}`)
    return v.trim()
  })
  const left = /\{\{[A-Z0-9_]+\}\}|\[\/?IF\b/.exec(filled)
  if (left) throw new Error(`The one-shot still has "${left[0]}" in it.`)
  return filled.trim() + '\n'
}
