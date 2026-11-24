/**
 * Bytes-level image helpers with no library: what kind of image a file is, and a JPEG with its
 * metadata taken out. Pure (tests load it).
 *
 * A phone photo carries EXIF, often with the GPS position of where it was taken: a customer's home.
 * Nothing the owner texts in goes on a public page with that still inside. sharp strips it when it
 * resizes (./work-photos.ts); when sharp can't, this does for JPEGs, which is what phones send, and a
 * JPEG it can't walk is refused rather than published as it came.
 */

export type ImageKind = 'jpeg' | 'png' | 'webp' | 'gif' | null

export function imageKind(b: Uint8Array): ImageKind {
  if (b.length < 12) return null
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpeg'
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'png'
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return 'gif'
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'webp'
  return null
}

/**
 * The JPEG without its APP1–APP15 and COM segments (EXIF, XMP, ICC, comments): the picture is untouched.
 * Null when it isn't a JPEG whose segments can be walked up to the image data: never the bytes as they
 * came, which could still carry the metadata.
 */
export function stripJpegMetadata(b: Uint8Array): Uint8Array | null {
  if (imageKind(b) !== 'jpeg') return null
  const out: Uint8Array[] = [b.subarray(0, 2)]
  let i = 2
  while (i + 4 <= b.length) {
    if (b[i] !== 0xff) return null
    // Fill bytes before a marker.
    if (b[i + 1] === 0xff) {
      i++
      continue
    }
    const marker = b[i + 1]
    // Start of scan: the rest is image data (and the end marker).
    if (marker === 0xda) {
      out.push(b.subarray(i))
      return join(out)
    }
    // Stand-alone markers (no length).
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      out.push(b.subarray(i, i + 2))
      i += 2
      continue
    }
    const len = (b[i + 2] << 8) | b[i + 3]
    if (len < 2 || i + 2 + len > b.length) return null
    const keep = !((marker >= 0xe1 && marker <= 0xef) || marker === 0xfe)
    if (keep) out.push(b.subarray(i, i + 2 + len))
    i += 2 + len
  }
  return null
}

function join(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let at = 0
  for (const p of parts) {
    out.set(p, at)
    at += p.length
  }
  return out
}
