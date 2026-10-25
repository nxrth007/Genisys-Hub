import Link from 'next/link'
import { Fragment, type ReactNode } from 'react'

/**
 * The little Markdown Ask AI answers in: paragraphs, headings, bullet and
 * numbered lists, small tables, bold, code and links. Links into Hell-level
 * open in place; other web links open in a new tab; anything else stays text.
 * Built as React elements (never raw HTML), and fine with half-streamed text.
 */

type Block =
  | { kind: 'p' | 'h' | 'quote'; text: string }
  | { kind: 'ul' | 'ol'; items: { text: string; depth: number }[] }
  | { kind: 'table'; rows: string[][] }
  | { kind: 'code'; text: string }

function blocks(src: string): Block[] {
  const out: Block[] = []
  const lines = src.replace(/\r/g, '').split('\n')
  let para: string[] = []
  const flush = () => {
    if (para.length) out.push({ kind: 'p', text: para.join(' ') })
    para = []
  }
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (/^\s*```/.test(line)) {
      flush()
      const code: string[] = []
      while (++i < lines.length && !/^\s*```/.test(lines[i])) code.push(lines[i])
      out.push({ kind: 'code', text: code.join('\n') })
      continue
    }
    if (!line.trim()) {
      flush()
      continue
    }
    const heading = /^#{1,6}\s+(.*)$/.exec(line)
    if (heading) {
      flush()
      out.push({ kind: 'h', text: heading[1] })
      continue
    }
    const bullet = /^(\s*)[-*•]\s+(.*)$/.exec(line)
    const numbered = /^(\s*)\d+[.)]\s+(.*)$/.exec(line)
    if (bullet || numbered) {
      flush()
      const kind = bullet ? 'ul' : 'ol'
      const m = (bullet ?? numbered)!
      const last = out[out.length - 1]
      const item = { text: m[2], depth: m[1].length >= 2 ? 1 : 0 }
      if (last && last.kind === kind) last.items.push(item)
      else out.push({ kind, items: [item] })
      continue
    }
    if (/^\s*\|.*\|\s*$/.test(line)) {
      flush()
      const cells = line.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim())
      if (cells.every((c) => /^:?-{2,}:?$/.test(c))) continue
      const last = out[out.length - 1]
      if (last && last.kind === 'table') last.rows.push(cells)
      else out.push({ kind: 'table', rows: [cells] })
      continue
    }
    const quote = /^>\s?(.*)$/.exec(line)
    if (quote) {
      flush()
      out.push({ kind: 'quote', text: quote[1] })
      continue
    }
    // A continuation line under a list item belongs to it.
    const last = out[out.length - 1]
    if (!para.length && last && (last.kind === 'ul' || last.kind === 'ol') && /^\s{2,}\S/.test(line)) {
      last.items[last.items.length - 1].text += ` ${line.trim()}`
      continue
    }
    para.push(line.trim())
  }
  flush()
  return out
}

const INLINE = /(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\([^)\s]+\)|(?<![\w])_[^_\n]+_(?![\w]))/g

function inline(text: string): ReactNode[] {
  return text.split(INLINE).map((part, i) => {
    if (!part) return null
    if (part.startsWith('**') && part.endsWith('**') && part.length > 4) return <strong key={i} className="font-semibold text-foreground">{part.slice(2, -2)}</strong>
    if (part.startsWith('`') && part.endsWith('`') && part.length > 2) return <code key={i} className="rounded bg-muted px-1 py-px font-mono text-[12.5px]">{part.slice(1, -1)}</code>
    const link = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(part)
    if (link) {
      const [, label, href] = link
      if (href.startsWith('/hell-level/'))
        return (
          <Link key={i} href={href} className="font-medium text-primary hover:underline">
            {label}
          </Link>
        )
      if (/^https?:\/\//.test(href))
        return (
          <a key={i} href={href} target="_blank" rel="noreferrer noopener" className="font-medium text-primary hover:underline">
            {label}
          </a>
        )
      return <Fragment key={i}>{label}</Fragment>
    }
    if (part.startsWith('_') && part.endsWith('_') && part.length > 2) return <em key={i} className="text-muted-foreground">{part.slice(1, -1)}</em>
    return <Fragment key={i}>{part}</Fragment>
  })
}

export function Markdown({ text }: { text: string }) {
  return (
    <div className="flex flex-col gap-2.5 text-[14px] leading-relaxed text-foreground/90">
      {blocks(text).map((b, i) => {
        switch (b.kind) {
          case 'h':
            return (
              <p key={i} className="pt-1 text-[14px] font-semibold text-foreground">
                {inline(b.text)}
              </p>
            )
          case 'quote':
            return (
              <p key={i} className="border-l-2 border-border pl-3 text-muted-foreground">
                {inline(b.text)}
              </p>
            )
          case 'code':
            return (
              <pre key={i} className="overflow-x-auto rounded-md bg-muted px-3 py-2 font-mono text-[12.5px]">
                {b.text}
              </pre>
            )
          case 'ul':
          case 'ol': {
            const List = b.kind
            return (
              <List key={i} className={b.kind === 'ul' ? 'flex list-disc flex-col gap-1 pl-5 marker:text-muted-foreground' : 'flex list-decimal flex-col gap-1 pl-5 marker:text-muted-foreground'}>
                {b.items.map((it, j) => (
                  <li key={j} className={it.depth ? 'ml-5' : undefined}>
                    {inline(it.text)}
                  </li>
                ))}
              </List>
            )
          }
          case 'table':
            return (
              <div key={i} className="overflow-x-auto rounded-md border border-border">
                <table className="w-full text-left text-[13px]">
                  <thead>
                    <tr className="border-b border-border bg-muted/40">
                      {b.rows[0].map((c, j) => (
                        <th key={j} className="px-3 py-1.5 font-mono text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                          {inline(c)}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {b.rows.slice(1).map((r, j) => (
                      <tr key={j} className="border-b border-border-soft last:border-0">
                        {r.map((c, k) => (
                          <td key={k} className="px-3 py-1.5">
                            {inline(c)}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )
          default:
            return <p key={i}>{inline(b.text)}</p>
        }
      })}
    </div>
  )
}
