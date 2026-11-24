/** The snippets that put a Genisys OS form or chat widget on a client's website. */

type EmbedForm = { id: string; kind: string; name: string }

export function embedCode(origin: string, f: EmbedForm): string {
  // The bubble asks the Hub for its colour, greeting and logo, so changing them there changes the site.
  if (f.kind === 'chat') return `<script src="${origin}/hl/widget.js" data-form="${f.id}" async></script>`
  // The form can sit twice on one page (a site's hero and its contact section): each copy takes the height its own frame reports.
  return [
    `<iframe src="${origin}/hl/f/${f.id}" id="hl-form-${f.id}" title="${f.name.replace(/"/g, '')}" style="width:100%;min-height:640px;border:0" loading="lazy"></iframe>`,
    `<script>window.addEventListener('message',function(e){if(e.data&&e.data.hlForm==='${f.id}'){document.querySelectorAll('iframe[id="hl-form-${f.id}"]').forEach(function(el){if(el.contentWindow===e.source)el.style.height=e.data.height+'px'})}})</script>`,
  ].join('\n')
}

export function lovablePrompt(origin: string, f: EmbedForm): string {
  return f.kind === 'chat'
    ? `Add our chat widget to every page of the site. Load this script once, in the root layout, just before the closing body tag. Remove the old GoHighLevel / LeadConnector chat widget (its <chat-widget> tag and its leadconnectorhq loader script), so there's only one chat bubble; don't remove any other scripts:\n\n${embedCode(origin, f)}`
    : `Replace the quote form on the contact / get-a-quote section with our hosted form. Embed this iframe where the form is (full width), keep the surrounding heading and layout, and include the small script right after it so the iframe resizes to fit. Remove any old GoHighLevel form embed:\n\n${embedCode(origin, f)}`
}

/** A booking calendar on the client's site: the booking page in an iframe that grows to fit. */
export function bookingEmbedCode(origin: string, c: { id: string; name: string }): string {
  return [
    `<iframe src="${origin}/hl/b/${c.id}" id="hl-book-${c.id}" title="${c.name.replace(/"/g, '')}" style="width:100%;min-height:720px;border:0" loading="lazy"></iframe>`,
    `<script>window.addEventListener('message',function(e){if(e.data&&e.data.hlForm==='${c.id}'){var el=document.getElementById('hl-book-${c.id}');if(el)el.style.height=e.data.height+'px'}})</script>`,
  ].join('\n')
}

/**
 * The Recent Work feed on the client's site: photos the owner texts in (src/lib/hl/work-photos.ts). The
 * script loads once (the site's index.html, like the chat widget); the placeholder goes where the feed
 * shows (the top of the Gallery page). It renders nothing until there's a photo.
 */
export const workScriptCode = (origin: string, accountId: string) => `<script src="${origin}/hl/work.js" data-account="${accountId}" async></script>`
export const workPlaceholderCode = (accountId: string) => `<div data-hl-work="${accountId}"></div>`
export const workEmbedCode = (origin: string, accountId: string) => `${workScriptCode(origin, accountId)}\n${workPlaceholderCode(accountId)}`

export function workLovablePrompt(origin: string, accountId: string): string {
  return `Add our recent-work feed. Load this script once, in index.html just before the closing body tag (next to our chat widget):\n\n${workScriptCode(origin, accountId)}\n\nThen put this placeholder at the top of the Gallery page, above the gallery grid, exactly as given:\n\n${workPlaceholderCode(accountId)}\n\nThe feed fills the placeholder with photos the owner texts in after launch and shows nothing until there are some, so keep the gallery photos below it. Don't give the placeholder a fixed height.`
}

export function bookingLovablePrompt(origin: string, c: { id: string; name: string }): string {
  return `Add our booking calendar where visitors book an appointment (a "Book a call" / "Schedule" section or page). Embed this iframe full width, keep the surrounding heading and layout, and include the small script right after it so the iframe resizes to fit. Remove any old GoHighLevel calendar embed:\n\n${bookingEmbedCode(origin, c)}`
}
