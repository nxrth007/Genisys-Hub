/**
 * Which clients the customize job takes on by itself. Pure, so the rules
 * are unit-tested; queue.ts loads the rows and acts on the answer.
 *
 * The trigger is the site we built: once its link is on the client and the
 * Hub's own worker created their sub-account (snapshot confirmed loaded),
 * the copy goes in. Hand-made sub-accounts and clients someone marked done
 * on the Automation Copy board are left alone. A changed site link runs it
 * again, but only where this job did the work.
 */
import { sameSiteLink } from './copy'

export type CustomizeCandidate = {
  archived: boolean
  siteUrl: string | null
  locationId: string | null
  /** The client's sub-account worker job, if the Hub's worker made or linked one. */
  subaccountJob: { status: string; locationId: string | null; detail: string | null } | null
  /** Every automation on the client's Automation Copy board is ticked as set up. */
  copyDone: boolean
  /** This client's customize job, if there is one. */
  job: { status: string; siteUrl: string | null } | null
}

export type Decision = { queue: boolean; reason: string }

/** The worker linked a sub-account that was already in GHL (made by hand) rather than creating it. */
export function linkedExisting(detail: string | null | undefined): boolean {
  return /^(linked the existing sub-account|the client was already linked)/i.test((detail ?? '').trim())
}

export function autoCustomizeDecision(c: CustomizeCandidate): Decision {
  if (c.archived) return { queue: false, reason: 'the client is archived' }
  if (!c.siteUrl?.trim()) return { queue: false, reason: 'no site link yet' }
  if (!c.locationId) return { queue: false, reason: 'no GHL sub-account yet' }
  const sj = c.subaccountJob
  if (!sj || sj.status !== 'succeeded' || sj.locationId !== c.locationId) {
    return { queue: false, reason: "the sub-account wasn't created by the Hub's worker" }
  }
  if (linkedExisting(sj.detail)) return { queue: false, reason: 'the sub-account was made by hand' }
  const job = c.job
  if (!job) {
    return c.copyDone ? { queue: false, reason: 'marked done on the Automation Copy board' } : { queue: true, reason: 'the site link is in' }
  }
  if (job.status === 'queued' || job.status === 'running') return { queue: false, reason: 'already queued' }
  if (job.status === 'held') return { queue: false, reason: 'waiting on a missing detail' }
  if (sameSiteLink(job.siteUrl, c.siteUrl)) {
    return { queue: false, reason: job.status === 'succeeded' ? 'already done for this site link' : 'waiting for a person' }
  }
  return { queue: true, reason: 'the site link changed' }
}

const HOLD_STATUSES = new Set(['queued', 'running'])

/** A running or queued job is left alone by "Customize now" (it is already happening). */
export function inFlight(status: string | null | undefined): boolean {
  return HOLD_STATUSES.has(status ?? '')
}

/**
 * Workflow AI's answer when it changed nothing: it says a step is missing or
 * asks a question. Used to word the job's note; the check decides.
 */
export function aiDeclined(reply: string): boolean {
  return /(couldn.?t|could not|can.?t|cannot|unable to|didn.?t|did not) (find|locate|see|identify)|not (found|present|exist)|doesn.?t exist|no (action|step) (named|called)|named differently|which (action|step)|could you (clarify|confirm)/i.test(reply)
}
