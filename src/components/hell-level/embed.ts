/** The snippets that put a Hell-level form or chat widget on a client's website. */

type EmbedForm = { id: string; kind: string; name: string; settings?: { color?: string } }

export function embedCode(origin: string, f: EmbedForm): string {
  if (f.kind === 'chat') {
    return `<script src="${origin}/hl/widget.js" data-form="${f.id}" data-color="${f.settings?.color ?? '#155EEF'}" async></script>`
  }
  return [
    `<iframe src="${origin}/hl/f/${f.id}" id="hl-form-${f.id}" title="${f.name.replace(/"/g, '')}" style="width:100%;min-height:640px;border:0" loading="lazy"></iframe>`,
    `<script>window.addEventListener('message',function(e){if(e.data&&e.data.hlForm==='${f.id}'){var el=document.getElementById('hl-form-${f.id}');if(el)el.style.height=e.data.height+'px'}})</script>`,
  ].join('\n')
}

export function lovablePrompt(origin: string, f: EmbedForm): string {
  return f.kind === 'chat'
    ? `Add our chat widget to every page of the site. Load this script once, in the root layout, just before the closing body tag, and don't remove any other scripts:\n\n${embedCode(origin, f)}`
    : `Replace the quote form on the contact / get-a-quote section with our hosted form. Embed this iframe where the form is (full width), keep the surrounding heading and layout, and include the small script right after it so the iframe resizes to fit. Remove any old GoHighLevel form embed:\n\n${embedCode(origin, f)}`
}
