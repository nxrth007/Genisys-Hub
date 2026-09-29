import type { PostDraft } from './prompts'
import type { BusinessFacts, ChangeFile, Draft, GateResult, SeoPostFile } from './types'

/**
 * Turning Claude's post into something safe to publish.
 *
 * The writer is told the rules; this file enforces the ones code can
 * check. Mechanical problems (a made-up image key, a link to a page that
 * doesn't exist) are repaired silently and noted. Problems that need a
 * human — a near-duplicate of an existing post, prices with nothing to
 * back them, a self-ranking "best in town" title — become blocking gates:
 * the draft still reaches the reviewer, but autopilot won't ship it.
 */

export const CONTENT_DIR = 'src/content/blog'

const WORDS_PER_MINUTE = 230

export function slugify(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
    .replace(/-+$/g, '')
}

const LINK_RE = /\[([^\]\n]{1,200})\]\(([^)\s]{1,500})\)/g

/** Visible text of a post (links reduced to their anchors). */
export function postText(p: Pick<SeoPostFile, 'title' | 'answer' | 'sections' | 'faqs'>): string {
  const strip = (s: string) => s.replace(LINK_RE, '$1')
  return [
    p.title,
    strip(p.answer),
    ...p.sections.flatMap((s) => [s.heading, ...s.paragraphs.map(strip)]),
    ...p.faqs.flatMap((f) => [f.q, strip(f.a)]),
  ].join('\n')
}

function words(text: string): string[] {
  return text.toLowerCase().match(/[a-z0-9$%']+/g) ?? []
}

/** Word 5-gram Jaccard similarity — the house near-duplicate measure (≤ 0.5 passes). */
export function similarity(a: string, b: string): number {
  const grams = (t: string) => {
    const w = words(t)
    const out = new Set<string>()
    for (let i = 0; i + 5 <= w.length; i++) out.add(w.slice(i, i + 5).join(' '))
    return out
  }
  const ga = grams(a)
  const gb = grams(b)
  if (!ga.size || !gb.size) return 0
  let inter = 0
  for (const g of ga) if (gb.has(g)) inter++
  return inter / (ga.size + gb.size - inter)
}

function normalizePath(href: string): string {
  const path = href.split(/[?#]/)[0].replace(/\/+$/, '')
  return path || '/'
}

/**
 * Rewrite inline links so every internal one points at a real page and
 * every external one is https. Anything else collapses to its anchor text.
 */
function repairLinks(text: string, validPaths: Set<string>, dropped: string[]): string {
  const once = (t: string) =>
    t.replace(LINK_RE, (_m, anchor: string, href: string) => {
      if (href.startsWith('/') && !href.startsWith('//')) {
        if (validPaths.has(normalizePath(href))) return `[${anchor}](${href})`
        dropped.push(href)
        return anchor
      }
      if (/^https:\/\/[^\s]+$/i.test(href)) return `[${anchor}](${href})`
      dropped.push(href)
      return anchor
    })
  // Collapsing an inner link can expose an outer one ("[[a](/x)](javascript:…)"),
  // so repeat until nothing changes. Each pass only keeps or shortens text.
  let prev: string
  do {
    prev = text
    text = once(text)
  } while (text !== prev)
  return text
}

/** Only site paths and https URLs ever become links in rendered output. */
function safeHref(href: string): boolean {
  return /^https:\/\//i.test(href) || /^\/(?!\/)/.test(href)
}

export type BuildContext = {
  /** YYYY-MM-DD in the site's time zone. */
  date: string
  author: string
  imageKeys: string[]
  serviceSlugs: string[]
  /** Paths that exist on the site, e.g. "/services/concrete-patios", for link repair. */
  sitePaths: string[]
  /** Existing posts (repo + ledger) with whatever text is known, for dedupe. */
  existing: { slug: string; title: string; text: string | null }[]
  facts: BusinessFacts | null
  brand: string
}

export function buildDraft(raw: PostDraft, ctx: BuildContext, costUsd: number): Draft {
  const gates: GateResult[] = []
  const repairs: string[] = []

  const validPaths = new Set(['/', '/blog', ...ctx.sitePaths.map(normalizePath)])
  const dropped: string[] = []
  const fix = (s: string) => repairLinks(s.trim(), validPaths, dropped)

  let slug = slugify(raw.slug || raw.title)
  const taken = new Set(ctx.existing.map((e) => e.slug))
  if (taken.has(slug)) {
    gates.push({ id: 'slug-unique', ok: false, blocking: true, detail: `A post with the slug "${slug}" already exists.` })
    slug = `${slug}-${ctx.date.slice(0, 4)}`
  } else {
    gates.push({ id: 'slug-unique', ok: true, blocking: true, detail: `Slug "${slug}" is new.` })
  }

  const imageKey = raw.imageKey && ctx.imageKeys.includes(raw.imageKey) ? raw.imageKey : null
  if (raw.imageKey && !imageKey) repairs.push(`image "${raw.imageKey}" doesn't exist on the site — left unset`)
  const serviceSlug = raw.serviceSlug && ctx.serviceSlugs.includes(raw.serviceSlug) ? raw.serviceSlug : null
  if (raw.serviceSlug && !serviceSlug) repairs.push(`service "${raw.serviceSlug}" doesn't exist — link removed`)

  const post: SeoPostFile = {
    slug,
    title: raw.title.trim(),
    metaTitle: raw.metaTitle.trim(),
    description: raw.description.trim(),
    eyebrow: raw.eyebrow.trim(),
    readTime: '',
    date: ctx.date,
    updated: ctx.date,
    author: ctx.author,
    serviceSlug,
    imageKey,
    imageAlt: raw.imageAlt.trim(),
    primaryKeyword: raw.primaryKeyword.trim(),
    answer: fix(raw.answer),
    sections: raw.sections
      .map((s) => ({ heading: s.heading.trim(), paragraphs: s.paragraphs.map(fix).filter(Boolean) }))
      .filter((s) => s.heading && s.paragraphs.length),
    faqs: raw.faqs.map((f) => ({ q: f.q.trim(), a: fix(f.a) })).filter((f) => f.q && f.a),
    sources: raw.sources
      .filter((s) => /^https:\/\//i.test(s.url.trim()))
      .map((s) => ({ title: s.title.trim() || s.url.trim(), url: s.url.trim() })),
  }
  if (dropped.length) repairs.push(`${dropped.length} link(s) to pages that don't exist were turned into plain text`)

  const text = postText(post)
  const wordCount = words(text).length
  post.readTime = `${Math.max(2, Math.round(wordCount / WORDS_PER_MINUTE))} min read`

  // Near-duplicates of anything already on the site.
  let worst = { slug: '', score: 0 }
  for (const e of ctx.existing) {
    if (!e.text) continue
    const s = similarity(text, e.text)
    if (s > worst.score) worst = { slug: e.slug, score: s }
  }
  gates.push({
    id: 'not-duplicate',
    ok: worst.score <= 0.5,
    blocking: true,
    detail:
      worst.score > 0.5
        ? `Too similar to "${worst.slug}" (${Math.round(worst.score * 100)}% of 5-word phrases shared).`
        : 'No near-duplicate of an existing post.',
  })

  const kw = post.primaryKeyword.toLowerCase()
  const clash = kw ? ctx.existing.find((e) => e.title.toLowerCase().includes(kw)) : undefined
  gates.push({
    id: 'keyword-unique',
    ok: !clash,
    blocking: false,
    detail: clash ? `"${post.primaryKeyword}" already appears in the title of "${clash.slug}" — check for cannibalization.` : 'Primary keyword not used by an existing post title.',
  })

  const selfRanking = /\b(best|top|#\s?1|number one|no\.\s?1)\b[^.\n]{0,40}\b(in|near)\b/i.test(post.title + ' ' + post.metaTitle)
  const hype = /(guaranteed lowest|cheapest in|lowest prices? in|#1 rated)/i.test(text)
  gates.push({
    id: 'no-self-ranking',
    ok: !selfRanking && !hype,
    blocking: true,
    detail: selfRanking || hype ? 'Reads as a self-ranking "best in town" claim — Google demotes these.' : 'No self-ranking claims.',
  })

  const mentionsPrice = /\$\s?\d/.test(text)
  const pricedFacts = !!ctx.facts?.pricingNotes && /\$\s?\d/.test(ctx.facts.pricingNotes)
  gates.push({
    id: 'prices-backed',
    ok: !mentionsPrice || pricedFacts || post.sources.length > 0,
    blocking: true,
    detail: !mentionsPrice
      ? 'No dollar figures.'
      : pricedFacts || post.sources.length
        ? 'Dollar figures are backed by the client’s price notes or a cited source — spot-check them.'
        : 'Mentions prices but the business has no price notes and the post cites no source.',
  })

  const avoidHits = (ctx.facts?.avoid ?? []).filter((a) => a.trim() && text.toLowerCase().includes(a.trim().toLowerCase()))
  gates.push({
    id: 'avoid-list',
    ok: avoidHits.length === 0,
    blocking: true,
    detail: avoidHits.length ? `Uses phrases the business asked to avoid: ${avoidHits.join(', ')}.` : 'Nothing from the avoid list.',
  })

  gates.push({
    id: 'length',
    ok: wordCount >= 500 && wordCount <= 2600,
    blocking: wordCount < 300,
    detail: `${wordCount} words.`,
  })
  gates.push({
    id: 'meta',
    ok: post.metaTitle.length <= 65 && post.description.length >= 70 && post.description.length <= 170,
    blocking: false,
    detail: `Meta title ${post.metaTitle.length} chars, description ${post.description.length} chars.`,
  })
  gates.push({
    id: 'answer-box',
    ok: words(post.answer).length >= 25 && words(post.answer).length <= 90,
    blocking: false,
    detail: `Answer box is ${words(post.answer).length} words (aim for 40–60).`,
  })
  if (repairs.length) gates.push({ id: 'repairs', ok: true, blocking: false, detail: `Auto-repaired: ${repairs.join('; ')}.` })

  return { post, gates, plainText: renderPlainText(post), html: renderHtml(post, ctx.brand), costUsd }
}

export function draftBlocked(d: Draft): boolean {
  return d.gates.some((g) => g.blocking && !g.ok)
}

export function postChangeFile(post: SeoPostFile, existed: boolean): ChangeFile {
  return {
    path: `${CONTENT_DIR}/${post.slug}.json`,
    content: JSON.stringify(post, null, 2) + '\n',
    reason: `New post: ${post.title}`,
    existed,
  }
}

// ---------------------------------------------------------------------------
// Renderings for copy-paste (GHL blog editor, email)
// ---------------------------------------------------------------------------

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function inlineHtml(s: string): string {
  let out = ''
  let last = 0
  for (const m of s.matchAll(LINK_RE)) {
    out += esc(s.slice(last, m.index))
    out += safeHref(m[2]) ? `<a href="${esc(m[2])}">${esc(m[1])}</a>` : esc(m[1])
    last = (m.index ?? 0) + m[0].length
  }
  return out + esc(s.slice(last))
}

export function renderHtml(p: SeoPostFile, brand: string): string {
  const parts = [
    `<h1>${esc(p.title)}</h1>`,
    `<p><strong>${inlineHtml(p.answer)}</strong></p>`,
    ...p.sections.flatMap((s) => [`<h2>${esc(s.heading)}</h2>`, ...s.paragraphs.map((x) => `<p>${inlineHtml(x)}</p>`)]),
  ]
  if (p.faqs.length) {
    parts.push('<h2>Frequently asked questions</h2>')
    for (const f of p.faqs) parts.push(`<h3>${esc(f.q)}</h3>`, `<p>${inlineHtml(f.a)}</p>`)
  }
  if (p.sources.length) {
    parts.push(
      '<h2>Sources</h2>',
      `<ul>${p.sources.map((s) => `<li>${safeHref(s.url) ? `<a href="${esc(s.url)}">${esc(s.title)}</a>` : esc(s.title)}</li>`).join('')}</ul>`,
    )
  }
  parts.push(`<p><em>${esc(p.author)}, ${esc(brand)} — updated ${esc(p.updated)}</em></p>`)
  return parts.join('\n')
}

export function renderPlainText(p: SeoPostFile): string {
  const t = (s: string) => s.replace(LINK_RE, (_m, a: string, h: string) => (safeHref(h) ? `${a} (${h})` : a))
  const lines = [p.title, '', t(p.answer), '']
  for (const s of p.sections) lines.push(s.heading, '', ...s.paragraphs.map((x) => t(x) + '\n'))
  if (p.faqs.length) {
    lines.push('Frequently asked questions', '')
    for (const f of p.faqs) lines.push(f.q, t(f.a), '')
  }
  if (p.sources.length) lines.push('Sources', ...p.sources.map((s) => `- ${s.title}: ${s.url}`))
  return lines.join('\n').trim()
}
