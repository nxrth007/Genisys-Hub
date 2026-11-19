/**
 * A small PDF writer for the dispute packet. Text only, Helvetica,
 * letter size. No native dependencies. Stays well under Stripe's 4.5 MB
 * combined limit and 50-page guidance (this stops at 40 pages).
 */

export type PdfSection = { heading: string; body: string }

const PAGE_W = 612
const PAGE_H = 792
const MARGIN_X = 54
const TOP = 740
const BOTTOM = 54
const LEAD = 13
const MAX_CHARS = 92
const MAX_PAGES = 40

function wrap(text: string): string[] {
  const lines: string[] = []
  for (const para of text.split('\n')) {
    if (!para.trim()) {
      lines.push('')
      continue
    }
    let line = ''
    const pieces: string[] = []
    for (const word of para.split(/\s+/)) {
      if (word.length <= MAX_CHARS) pieces.push(word)
      else for (let i = 0; i < word.length; i += MAX_CHARS) pieces.push(word.slice(i, i + MAX_CHARS))
    }
    for (const piece of pieces) {
      const next = line ? `${line} ${piece}` : piece
      if (next.length > MAX_CHARS && line) {
        lines.push(line)
        line = piece
      } else {
        line = next
      }
    }
    if (line) lines.push(line)
  }
  return lines
}

/** Helvetica uses WinAnsi. These are the punctuation marks the policy pages use outside ASCII. */
const WIN_ANSI: Record<number, number> = {
  0x2013: 0x96,
  0x2014: 0x97,
  0x2018: 0x91,
  0x2019: 0x92,
  0x201c: 0x93,
  0x201d: 0x94,
  0x2026: 0x85,
}

function escapePdf(s: string): string {
  let out = ''
  for (const ch of s) {
    const c = ch.charCodeAt(0)
    const mapped = WIN_ANSI[c]
    if (c === 40 || c === 41 || c === 92) out += `\\${ch}`
    else if (mapped) out += `\\${mapped.toString(8).padStart(3, '0')}`
    else if (c >= 32 && c <= 126) out += ch
    else if (c >= 160 && c <= 255) out += `\\${c.toString(8).padStart(3, '0')}`
    else out += '?'
  }
  return out
}

type Page = { heading: boolean; text: string }[]

function paginate(sections: PdfSection[]): string[][] {
  const pages: string[][] = []
  let page: string[] = []
  const push = (line: string) => {
    if (page.length >= Math.floor((TOP - BOTTOM) / LEAD)) {
      pages.push(page)
      page = []
    }
    page.push(line)
  }
  for (const section of sections) {
    push(`# ${section.heading}`)
    push('')
    for (const line of wrap(section.body)) push(line)
    push('')
  }
  if (page.length) pages.push(page)
  if (pages.length > MAX_PAGES) {
    const kept = pages.slice(0, MAX_PAGES)
    kept[MAX_PAGES - 1] = [...kept[MAX_PAGES - 1].slice(0, 40), '', '[Further pages omitted to stay inside Stripe\'s page limit. The Hub dispute record holds the full text.]']
    return kept
  }
  return pages.length ? pages : [['Lead Genisys dispute packet', '', 'No evidence sections were produced.']]
}

function contentStream(lines: string[], pageNo: number, pageCount: number): string {
  const cmds = ['BT', '/F1 9 Tf']
  let y = TOP
  for (const line of lines) {
    const heading = line.startsWith('# ')
    const text = heading ? line.slice(2) : line
    cmds.push(`/F${heading ? 2 : 1} ${heading ? 13 : 9} Tf`)
    cmds.push(`1 0 0 1 ${MARGIN_X} ${y} Tm`)
    cmds.push(`(${escapePdf(text)}) Tj`)
    y -= heading ? 18 : LEAD
    if (y < BOTTOM) break
  }
  cmds.push('/F1 8 Tf')
  cmds.push(`1 0 0 1 ${MARGIN_X} 36 Tm`)
  cmds.push(`(${escapePdf(`Lead Genisys  ·  confidential dispute evidence  ·  page ${pageNo} of ${pageCount}`)}) Tj`)
  cmds.push('ET')
  return cmds.join('\n')
}

export function renderEvidencePdf(sections: PdfSection[]): Buffer {
  const pages = paginate(sections)
  const objects: string[] = []
  const pageIds: number[] = []
  // 1 catalog, 2 pages, 3 font, 4 font bold, then pairs of page + content
  const fontRegular = 3
  const fontBold = 4
  let next = 5
  const contentIds: number[] = []
  for (let i = 0; i < pages.length; i++) {
    pageIds.push(next)
    contentIds.push(next + 1)
    next += 2
  }
  const pageCount = pages.length
  objects[1] = `<< /Type /Catalog /Pages 2 0 R >>`
  objects[2] = `<< /Type /Pages /Count ${pageCount} /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] >>`
  objects[fontRegular] = `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>`
  objects[fontBold] = `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>`
  pages.forEach((lines, i) => {
    const stream = contentStream(lines, i + 1, pageCount)
    const pageId = pageIds[i]
    const contentId = contentIds[i]
    objects[pageId] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] /Contents ${contentId} 0 R /Resources << /Font << /F1 ${fontRegular} 0 R /F2 ${fontBold} 0 R >> >> >>`
    objects[contentId] = `<< /Length ${Buffer.byteLength(stream, 'utf8')} >>\nstream\n${stream}\nendstream`
  })

  let pdf = '%PDF-1.4\n'
  const offsets: number[] = [0]
  for (let i = 1; i < objects.length; i++) {
    offsets[i] = Buffer.byteLength(pdf, 'utf8')
    pdf += `${i} 0 obj\n${objects[i]}\nendobj\n`
  }
  const xref = Buffer.byteLength(pdf, 'utf8')
  pdf += `xref\n0 ${objects.length}\n`
  pdf += '0000000000 65535 f \n'
  for (let i = 1; i < objects.length; i++) {
    pdf += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`
  }
  pdf += `trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`
  return Buffer.from(pdf, 'utf8')
}

/** Prisma Bytes wants a Uint8Array backed by a plain ArrayBuffer, not a Node Buffer. */
export function pdfBytes(pdf: Buffer): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(pdf.byteLength)
  out.set(pdf)
  return out
}
