import type { ClaudeSession } from './claude'
import { PAGES_OVERLAY } from './content'
import { FOUNDATION_SYSTEM, FoundationSchema } from './prompts'
import type { ChangeFile, RepoSnapshot } from './types'

/**
 * The one-time "SEO foundation" for a client repo.
 *
 * Weekly runs only ever add JSON files under src/content/blog — no route,
 * config or dependency changes — so they can't break a Lovable build or
 * collide with Lovable's own edits. That only works if the site knows how
 * to load and render those files, publish a sitemap, and describe itself
 * to AI crawlers. This commit teaches it, once, through a reviewed PR:
 * Claude adapts the spec to the repo's actual code, the Hub adds the
 * deterministic files (CI check, marker, IndexNow key) itself, and nothing
 * merges until a person approves and the build passes.
 */

export const FOUNDATION_MARKER = 'src/content/seo.config.json'
export const CI_WORKFLOW_PATH = '.github/workflows/seo-verify.yml'

/** Files Claude may write for the foundation. Everything else is refused. */
const PROTECTED = [
  /^package\.json$/,
  /^bun\.lockb?$/,
  /^package-lock\.json$/,
  /^pnpm-lock\.yaml$/,
  /^yarn\.lock$/,
  /^vite\.config\.[cm]?[jt]s$/,
  /^src\/router\.tsx?$/,
  /^src\/server\.tsx?$/,
  /^src\/start\.tsx?$/,
  /^src\/routeTree\.gen\.ts$/,
  /^\.lovable\//,
  /^\.github\//,
  /^\.env/,
]
const ALLOWED = [/^src\/.+\.(tsx?|json|css)$/, /^public\/robots\.txt$/, /^AGENTS\.md$/]

export function foundationPathAllowed(path: string): boolean {
  if (path.includes('..') || path.startsWith('/')) return false
  if (PROTECTED.some((re) => re.test(path))) return false
  return ALLOWED.some((re) => re.test(path))
}

function spec(o: { siteUrl: string; repo: RepoSnapshot }): string {
  const template = o.repo.template === 'genisys-lovable'
  return `Add the SEO foundation to this repository. The site's public origin is ${o.siteUrl} (use exactly this, no trailing slash).

Weekly, the Genisys SEO engine will commit blog posts as JSON files at src/content/blog/<slug>.json with exactly this TypeScript shape:

type SeoPostFile = {
  slug: string; title: string; metaTitle: string; description: string; eyebrow: string; readTime: string;
  date: string /* YYYY-MM-DD */; updated: string; author: string;
  serviceSlug: string | null; imageKey: string | null; imageAlt: string; primaryKeyword: string;
  answer: string; // 40–60 word direct answer, may contain inline links
  sections: { heading: string; paragraphs: string[] }[]; // paragraphs may contain inline links written as [anchor](href)
  faqs: { q: string; a: string }[]; // answers may contain inline links
  sources: { title: string; url: string }[];
}

Required changes (adapt to this repo's actual files and style — read them carefully first):
1. Blog data (${template ? 'src/data/blog.ts' : 'the module that holds blog posts, or a new src/data/seo-posts.ts wired into the existing blog pages'}): keep every existing post and export working unchanged. Extend the post type with OPTIONAL fields date, updated, author, answer, faqs, sources, metaTitle. Load the engine's posts with import.meta.glob("/src/content/blog/*.json", { eager: true, import: "default" }), map each file onto the existing post type (image = the projectPhotos entry named by imageKey when it exists, otherwise a sensible existing default project photo; imageAlt from the file; serviceSlug as-is; readTime as-is), and put them in the exported list newest first, ahead of the existing hand-written posts. Skip files whose slug duplicates an existing post. It must type-check under strict TypeScript with no any.
2. SEO helpers (${template ? 'src/lib/seo.ts' : 'the existing head/meta helper, or a new src/lib/seo.ts'}): export SITE_URL = "${o.siteUrl}" and absoluteUrl(path). Make og:url absolute inside meta(). Make the canonical link absolute in EVERY route file that sets one — every file under src/routes with a rel "canonical" link must change to absoluteUrl(...) and be returned, not only the routes named below (all of them are in the key files). Add a default og:image (absolute URL of the logo or a hero project photo) and use twitter:card "summary_large_image". Make the article JSON-LD a BlogPosting with headline, description, absolute url, mainEntityOfPage, image (absolute), datePublished and dateModified when known, author { "@type": "Person", name }, publisher (the business, with logo). Keep existing function signatures backward compatible (only add optional parameters).
3. Blog post route (src/routes/blog.$slug.tsx or equivalent): absolute canonical; pass dates, image and author into the article JSON-LD; when present render the answer as a prominent lead paragraph under the header, a visible "Frequently asked questions" section, a "Sources" list, and "Updated <date>" beside the read time. Render inline [anchor](href) links in answer, paragraphs and FAQ answers with a small safe component (no dangerouslySetInnerHTML): internal paths as normal links, https URLs as external links with rel="noopener". Match the existing classes and layout.
4. Sitemap: a server route at src/routes/sitemap[.]xml.ts:
   import { createFileRoute } from "@tanstack/react-router";
   export const Route = createFileRoute("/sitemap.xml")({ server: { handlers: { GET: async () => new Response(xml, { headers: { "Content-Type": "application/xml; charset=utf-8", "Cache-Control": "public, max-age=3600" } }) } } });
   It lists absolute URLs for every static page route that exists in src/routes (not dynamic templates, not error/utility routes), every service page, any per-area pages, and every blog post with <lastmod> from updated/date.
5. llms.txt: a server route at src/routes/llms[.]txt.ts returning text/plain; charset=utf-8 in llms.txt format: "# <business name>", "> <one-line description>", a short paragraph with the trade, city, service area and phone, then "## Services" (markdown links to service pages), "## Guides" (links to every blog post), "## Contact".
6. public/robots.txt: exactly
User-agent: *
Allow: /

Sitemap: ${o.siteUrl}/sitemap.xml
7. AGENTS.md: keep the <!-- LOVABLE:BEGIN --> … <!-- LOVABLE:END --> block untouched and append a short "## Genisys SEO engine" section saying src/content/** is written weekly by the Genisys SEO engine through GitHub; don't delete, rename or reformat those files or change the post JSON shape/loader without telling Genisys.
8. Page title/description overrides: the engine fixes titles and meta descriptions weekly through src/content/seo/pages.json (created by Genisys alongside this change; treat it as existing), shaped { "<site path>": { "title"?: string, "description"?: string } } with keys like "/", "/services/concrete-patios", "/blog". Load it with import.meta.glob("/src/content/seo/pages.json", { eager: true, import: "default" }) (same pattern as the posts — no resolveJsonModule needed) into a typed helper in ${template ? 'src/lib/seo.ts' : 'the SEO helper'}: export function pageOverride(path: string): { title?: string; description?: string } — normalise the path (strip a trailing slash, "" → "/") and return the entry or {}. Apply it INSIDE meta(title, description, url): use pageOverride(url).title ?? title and pageOverride(url).description ?? description for the <title>, the description meta, og:title and og:description — so every existing route picks overrides up with no route edits. If the homepage's title/description are written directly in __root.tsx or index.tsx rather than through meta(), route those through pageOverride("/") too.
9. Service pages (src/routes/services.$slug.tsx or equivalent): add a "Guides" section listing up to 3 posts whose serviceSlug matches this service — title linking to /blog/<slug> and the description — placed above the closing call-to-action, using the existing card/link classes. Render nothing when no post matches. (Posts link to their service page already; this closes the loop.)

Rules:
- The code must pass \`tsc --noEmit\` under this repo's tsconfig.json (included in the key files). It is strict: with exactOptionalPropertyTypes, an optional property that callers may pass undefined to must be typed \`prop?: T | undefined\`; with noUncheckedIndexedAccess, an indexed lookup may be undefined. The new server routes will not appear in src/routeTree.gen.ts until the next build regenerates it — that is expected; do not edit that file.
- Do not touch package.json, lockfiles, vite config, src/router.tsx, src/server.ts, src/start.ts, src/routeTree.gen.ts, .lovable/ or .github/. No new dependencies.
- Return complete file contents for every file you create or change (not diffs). Only include files you actually change.
- Keep the diff minimal and conventional; don't restyle, rename or reorganize unrelated code.
- If something in the spec doesn't fit this repo, adapt sensibly and explain in reviewerNotes.
- summary: 2–4 sentences for the reviewer. reviewerNotes: anything they should check by eye.`
}

function repoContext(repo: RepoSnapshot): string {
  const lines = [
    `Repository ${repo.fullName} (default branch ${repo.defaultBranch}, platform ${repo.platform}, template ${repo.template ?? 'none'}).`,
    '',
    'All file paths:',
    repo.paths.join('\n'),
    '',
    'Key files:',
  ]
  for (const f of repo.files) {
    lines.push(`\n===== ${f.path}${f.truncated ? ' (truncated)' : ''} =====\n${f.content}`)
  }
  return lines.join('\n')
}

export type FoundationResult = { files: ChangeFile[]; summary: string; reviewerNotes: string[]; refused: string[] }

export async function generateFoundation(o: {
  session: ClaudeSession
  repo: RepoSnapshot
  siteUrl: string
  indexNowKey: string
}): Promise<FoundationResult> {
  const out = await o.session.structured({
    label: 'foundation',
    system: FOUNDATION_SYSTEM,
    context: repoContext(o.repo),
    task: spec({ siteUrl: o.siteUrl, repo: o.repo }),
    schema: FoundationSchema,
    effort: 'high',
    maxTokens: 64_000,
  })

  const existing = new Set(o.repo.paths)
  const refused: string[] = []
  const files: ChangeFile[] = []
  const seen = new Set<string>()
  for (const f of out.files) {
    const path = f.path.replace(/^\.\//, '').trim()
    if (!foundationPathAllowed(path) || seen.has(path)) {
      refused.push(path)
      continue
    }
    if (path.endsWith('.json')) {
      try {
        JSON.parse(f.content)
      } catch {
        refused.push(`${path} (invalid JSON)`)
        continue
      }
    }
    seen.add(path)
    files.push({ path, content: f.content.endsWith('\n') ? f.content : f.content + '\n', reason: f.reason, existed: existing.has(path) })
  }

  // Deterministic files the Hub owns outright.
  if (!seen.has(PAGES_OVERLAY)) {
    files.push({
      path: PAGES_OVERLAY,
      content: '{}\n',
      reason: 'Empty title/description overlay — the engine fills it in weekly',
      existed: existing.has(PAGES_OVERLAY),
    })
  }
  files.push({
    path: FOUNDATION_MARKER,
    content:
      JSON.stringify(
        {
          owner: 'Genisys SEO engine',
          siteUrl: o.siteUrl,
          contentDir: 'src/content/blog',
          indexNowKey: o.indexNowKey,
          note: 'Weekly posts land in src/content/blog as JSON. Managed from the Genisys Hub → SEO.',
        },
        null,
        2,
      ) + '\n',
    reason: 'Marks the repo as SEO-engine ready',
    existed: existing.has(FOUNDATION_MARKER),
  })
  files.push({
    path: `public/${o.indexNowKey}.txt`,
    content: `${o.indexNowKey}\n`,
    reason: 'IndexNow key file — lets the engine notify Bing/Copilot the moment a post goes live',
    existed: existing.has(`public/${o.indexNowKey}.txt`),
  })
  files.push({
    path: CI_WORKFLOW_PATH,
    content: ciWorkflow(o.repo),
    reason: 'Builds every SEO branch before it can be merged',
    existed: existing.has(CI_WORKFLOW_PATH),
  })

  return { files, summary: out.summary, reviewerNotes: out.reviewerNotes, refused }
}

/** Build check for engine branches only, so Lovable's own commits don't burn Actions minutes. */
export function ciWorkflow(repo: RepoSnapshot): string {
  const bun = repo.paths.some((p) => p === 'bun.lock' || p === 'bun.lockb')
  const install = bun
    ? ['      - uses: oven-sh/setup-bun@v2', '      - run: bun install --frozen-lockfile', '      - run: bun run build']
    : [
        '      - uses: actions/setup-node@v4',
        '        with:',
        '          node-version: 22',
        '      - run: npm ci',
        '      - run: npm run build',
      ]
  return [
    '# Added by the Genisys SEO engine. Builds engine branches (seo/*) before they',
    '# can be merged into the branch Lovable syncs from.',
    'name: seo-verify',
    'on:',
    '  push:',
    "    branches: ['seo/**']",
    '  workflow_dispatch:',
    'permissions:',
    '  contents: read',
    'jobs:',
    '  build:',
    '    runs-on: ubuntu-latest',
    '    timeout-minutes: 15',
    '    steps:',
    '      - uses: actions/checkout@v4',
    ...install,
    '',
  ].join('\n')
}
