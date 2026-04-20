/**
 * Documents module — upload/download/list helpers. Files are stored as
 * bytea in Postgres, so there's no external object store to manage. Fine
 * for a small internal vault of contracts; not the right pattern if the
 * volume ever grows into the thousands of files.
 */

/** Max per-file upload size. Picked to fit typical contracts with some
 *  headroom for scanned PDFs. Rejected with 413 if exceeded. */
export const MAX_FILE_BYTES = 25 * 1024 * 1024 // 25 MB

/**
 * Allowed MIME types. Keeps random executables / archives out. Matches
 * the extensions real contracts typically arrive in — PDF, Word, Excel,
 * PowerPoint, plus plain text. Extend here if a user has something we
 * don't cover yet.
 */
export const ALLOWED_MIME_TYPES: Record<string, { ext: string; label: string }> = {
  'application/pdf': { ext: 'pdf', label: 'PDF' },
  'application/msword': { ext: 'doc', label: 'Word (legacy)' },
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': {
    ext: 'docx',
    label: 'Word',
  },
  'application/vnd.ms-excel': { ext: 'xls', label: 'Excel (legacy)' },
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': {
    ext: 'xlsx',
    label: 'Excel',
  },
  'application/vnd.ms-powerpoint': { ext: 'ppt', label: 'PowerPoint (legacy)' },
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': {
    ext: 'pptx',
    label: 'PowerPoint',
  },
  'text/plain': { ext: 'txt', label: 'Text' },
  'image/png': { ext: 'png', label: 'PNG' },
  'image/jpeg': { ext: 'jpg', label: 'JPEG' },
}

/**
 * Browsers occasionally submit the wrong MIME type for older Office files
 * (they default to application/octet-stream for anything unknown). If the
 * filename extension matches a known type, use that as the canonical MIME
 * regardless of what the browser claimed.
 */
export function resolveMimeType(filename: string, browserMime: string): string {
  const ext = filename.split('.').pop()?.toLowerCase() || ''
  const match = Object.entries(ALLOWED_MIME_TYPES).find(([, v]) => v.ext === ext)
  if (match) return match[0]
  return browserMime
}

export function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}
