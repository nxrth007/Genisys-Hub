/**
 * A client's Google Business Profile link, as their Genisys OS Business Profile keeps it (Alex,
 * 2026-11-16: "a place to enter a client's Google Business Profile URL… so that known value is
 * saved"). Pure (tests load it): what counts as one, and which link is already known for a client.
 */

/** Google's own addresses for a profile: a Maps page, the Share link, a g.page name, a search panel. */
const GOOGLE_HOST = /(^|\.)google\.[a-z]{2,3}(\.[a-z]{2})?$|^(maps\.app\.)?goo\.gl$|^g\.page$|^g\.co$|^share\.google$/i

export type ProfileLinkCheck = { ok: true; url: string } | { ok: false; error: string }

/**
 * A pasted profile link, tidied ("maps.app.goo.gl/abc" gets its https://), or why it isn't one.
 * Blank is fine (the box is optional). Their review link belongs in the box beside it.
 */
export function checkGoogleProfileLink(raw: string | null | undefined): ProfileLinkCheck {
  const text = (raw ?? '').trim()
  if (!text) return { ok: true, url: '' }
  const notGoogle = 'That doesn’t look like a Google link. On their Google Business Profile, press Share and paste the link it gives.'
  if (/\s/.test(text) || text.length > 2000) return { ok: false, error: notGoogle }
  let url: URL
  try {
    url = new URL(/^https?:\/\//i.test(text) ? text : `https://${text}`)
  } catch {
    return { ok: false, error: notGoogle }
  }
  if (!GOOGLE_HOST.test(url.hostname)) return { ok: false, error: notGoogle }
  // "Ask for reviews" gives g.page/r/<id>/review, and a place's review box is …/writereview?placeid=….
  if (/writereview/i.test(url.pathname) || (/^g\.page$/i.test(url.hostname) && /\/review\/?$/i.test(url.pathname))) {
    return { ok: false, error: 'That’s their review link, which goes in “Google review link”. For this box, press Share on their Google Business Profile and paste that link.' }
  }
  url.protocol = 'https:'
  return { ok: true, url: url.toString() }
}

/**
 * The profile link the Hub already knows for a client: what their Google Profiles board has, else
 * their own onboarding answer when it's a Google link (people also answer "yes" or paste their website).
 */
export function knownGoogleProfileLink(o: { board: string | null | undefined; intake: string | null | undefined }): string {
  for (const candidate of [o.board, o.intake]) {
    const c = checkGoogleProfileLink(candidate)
    if (c.ok && c.url) return c.url
  }
  return ''
}
