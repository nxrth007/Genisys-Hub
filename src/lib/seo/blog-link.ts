import { readFile } from './github'
import type { ChangeFile, RepoSnapshot } from './types'

/**
 * Puts the blog in the site's main menu when nothing links to it.
 *
 * Some builds ship the blog routes with no Blog link in the header or
 * footer, so the engine's posts are reachable only through the sitemap:
 * crawlers treat them as orphan pages and visitors never find them. In the
 * Genisys template both the desktop and the mobile menu render the `links`
 * array in Nav.tsx, so one entry, { to: "/blog", label: "Blog" } before
 * Contact like the other template sites, links the blog from every page.
 */

export const NAV_FILE = 'src/components/site/Nav.tsx'
const FOOTER_FILE = 'src/components/site/Footer.tsx'

const LINKS_RE = /(const\s+links\s*=\s*\[)([\s\S]*?)(\n[ \t]*\]\s*as\s+const\s*;)/
const ENTRY_RE = /\n([ \t]*)\{\s*to:\s*["']\/[^"']*["']\s*,\s*label:\s*["'][^"']*["']\s*\}\s*,?/g
const CONTACT_RE = /\n[ \t]*\{\s*to:\s*["']\/contact["']/
const LINKS_BLOG_RE = /["'`]\/blog\/?["'`]/

/** Nav.tsx with a Blog entry in its `links` array (unchanged if it has one), or null when the menu isn't the template's. */
export function withBlogLink(nav: string): string | null {
  const m = LINKS_RE.exec(nav)
  const entries = m ? [...m[2].matchAll(ENTRY_RE)] : []
  if (!m || !entries.length) return null
  if (LINKS_BLOG_RE.test(m[2])) return nav
  const entry = `{ to: "/blog", label: "Blog" },`
  const body = m[2]
  const contact = CONTACT_RE.exec(body)
  const nextBody = contact
    ? `${body.slice(0, contact.index)}\n${entries[0][1]}${entry}${body.slice(contact.index)}`
    : `${body.replace(/\s*,?\s*$/, ',')}\n${entries[0][1]}${entry}`
  return nav.slice(0, m.index) + m[1] + nextBody + m[3] + nav.slice(m.index + m[0].length)
}

export type BlogLinkSync = { change: ChangeFile | null; note: string | null; warning: string | null }

export async function blogLinkSync(repo: RepoSnapshot): Promise<BlogLinkSync> {
  const none: BlogLinkSync = { change: null, note: null, warning: null }
  if (!repo.paths.some((p) => /^src\/routes\/blog(\.index)?\.tsx$/.test(p))) return none
  // Read at the branch head, not the snapshot, so the commit keeps whatever Lovable pushed since.
  const read = (path: string) => readFile(repo.fullName, path, repo.defaultBranch).catch(() => null)
  const [nav, footer] = await Promise.all([read(NAV_FILE), read(FOOTER_FILE)])
  if ((nav && LINKS_BLOG_RE.test(nav)) || (footer && LINKS_BLOG_RE.test(footer))) return none

  const content = nav ? withBlogLink(nav) : null
  if (!content) {
    return {
      ...none,
      warning: 'Nothing in the header or footer links to /blog, so the posts are reachable only through the sitemap. This site’s menu isn’t the template’s, so the engine left it alone — add a Blog link to the menu in Lovable.',
    }
  }
  return {
    change: {
      path: NAV_FILE,
      content,
      reason: 'Adds Blog to the main menu (desktop and mobile). Nothing in the header or footer linked to /blog, so the posts were reachable only through the sitemap.',
      existed: true,
    },
    note: 'Nothing on the site linked to the blog — this pull request adds Blog to the main menu',
    warning: null,
  }
}
