/**
 * The texts the sub-account worker sends Alex and Ethan when something
 * needs a person, and the timings behind them. Pure (no imports) so it is
 * unit-testable; alerts.ts sends them.
 */

export type WorkerAlertKind = 'needs_human' | 'failed' | 'code' | 'stuck' | 'waiting' | 'name'

/** Longer than any real job: the browser part is capped at 20 minutes and the snapshot wait at 20. */
export const STUCK_AFTER_MS = 70 * 60_000
/** A queued job nobody has picked up for this long means the worker isn't taking jobs. */
export const WAITING_AFTER_MS = 45 * 60_000
/** The same problem with the same job or client is texted at most this often. */
export const TEXT_AGAIN_AFTER_MS = 12 * 60 * 60_000

/** Test runs ("Test: …") are watched by whoever started them, so they don't text. */
export function textsTeamFor(subAccountName: string): boolean {
  return !/^test:/i.test(subAccountName.trim())
}

/** The first sentence or two of a long detail, short enough for a text. */
export function shortReason(detail: string, max = 170): string {
  const flat = detail.replace(/\s+/g, ' ').trim()
  if (flat.length <= max) return flat
  const cut = flat.slice(0, max)
  const stop = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '))
  return stop > 60 ? cut.slice(0, stop + 1) : `${cut.slice(0, max - 1)}…`
}

export function workerAlertText(kind: WorkerAlertKind, client: string, reason: string, link: string): string {
  const why = reason.trim() ? ` ${shortReason(reason)}` : ''
  switch (kind) {
    case 'code':
      return `Genisys Hub: GHL wants a sign-in code to create ${client}'s sub-account. Paste the code from the email here: ${link}`
    case 'failed':
      return `Genisys Hub: creating the GHL sub-account for ${client} failed.${why} Open: ${link}`
    case 'stuck':
      return `Genisys Hub: the GHL sub-account worker has been on ${client} for over an hour and looks stuck.${why} Open: ${link}`
    case 'waiting':
      return `Genisys Hub: ${client} has waited${why} for its GHL sub-account. The worker may be stuck or paused. Open: ${link}`
    case 'name':
      return `Genisys Hub: new client "${client}" gave a business name that looks like a non-answer, so no GHL sub-account was made. Fix the name in the Hub, then press Create: ${link}`
    default:
      return `Genisys Hub: the GHL sub-account for ${client} needs a person.${why} Open: ${link}`
  }
}

/** A client's Hell-level toll-free number (src/lib/hl/number-request.ts). */
export type NumberAlertKind = 'approve' | 'failed' | 'verify' | 'rejected'

export function numberAlertText(kind: NumberAlertKind, client: string, reason: string, link: string): string {
  const why = reason.trim() ? ` ${shortReason(reason)}` : ''
  switch (kind) {
    case 'approve':
      return `Genisys Hub: ${client} just onboarded. Approve their Hell-level toll-free number (about $2.15/mo, no ID check) in the Office: ${link}`
    case 'failed':
      return `Genisys Hub: buying ${client}'s toll-free number failed.${why} Open: ${link}`
    case 'rejected':
      return `Genisys Hub: Twilio rejected ${client}'s toll-free texting verification.${why} Open: ${link}`
    default:
      return `Genisys Hub: ${client}'s toll-free texting verification can't be filed yet.${why} Open: ${link}`
  }
}

/** The workflow customize job (src/lib/ghl-customize): putting a client's copy into their lead workflows. */
export type CustomizeAlertKind = 'needs_human' | 'failed' | 'code' | 'held' | 'stuck' | 'waiting'

export function customizeAlertText(kind: CustomizeAlertKind, client: string, reason: string, link: string): string {
  const why = reason.trim() ? ` ${shortReason(reason)}` : ''
  switch (kind) {
    case 'held':
      return `Genisys Hub: ${client}'s site link is in, but their GHL lead workflow copy is missing the ${reason.trim() || 'details it needs'}. Fill it in and the Hub does the rest: ${link}`
    case 'code':
      return `Genisys Hub: GHL wants a sign-in code to update ${client}'s lead workflows. Paste the code from the email here: ${link}`
    case 'failed':
      return `Genisys Hub: putting ${client}'s copy into their GHL lead workflows failed.${why} Open: ${link}`
    case 'stuck':
      return `Genisys Hub: the worker has been on ${client}'s GHL lead workflows for over an hour and looks stuck.${why} Open: ${link}`
    case 'waiting':
      return `Genisys Hub: ${client}'s GHL lead workflows have waited${why} for the worker. It may be stuck or paused. Open: ${link}`
    default:
      return `Genisys Hub: ${client}'s GHL lead workflows need a person.${why} Open: ${link}`
  }
}
