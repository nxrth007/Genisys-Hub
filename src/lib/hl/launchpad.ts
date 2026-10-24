import { prisma } from '@/lib/prisma'
import { readProfile } from './accounts'

/**
 * The Launchpad checklist (GHL's setup guide): what a sub-account still needs
 * before it does the $297 package's job on its own.
 */

export type LaunchItem = {
  key: string
  title: string
  detail: string
  done: boolean
  /** Page inside the sub-account that finishes it. */
  href: string
  cta: string
}

export async function launchpad(accountId: string): Promise<{ items: LaunchItem[]; done: number; total: number }> {
  const [account, numbers, submissions, calls, workflows] = await Promise.all([
    prisma.hlAccount.findUnique({ where: { id: accountId }, select: { profile: true } }),
    prisma.hlPhoneNumber.findMany({ where: { accountId, status: 'active' }, orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }] }),
    prisma.hlFormSubmission.count({ where: { accountId } }),
    prisma.hlMessage.count({ where: { accountId, channel: 'call' } }),
    prisma.hlWorkflow.findMany({ where: { accountId }, select: { template: true, status: true } }),
  ])
  const p = readProfile(account?.profile)
  const number = numbers[0] ?? null
  const live = (key: string) => workflows.some((w) => w.template === key && w.status === 'published')
  const profileMissing = [
    !p.businessName && 'business name',
    !p.ownerFirstName && 'owner first name',
    !p.website && 'website',
    !p.notifyPhone && 'notification phone',
    !p.notifyEmail && 'notification email',
  ].filter(Boolean) as string[]

  const items: LaunchItem[] = [
    {
      key: 'profile',
      title: 'Complete the business profile',
      detail: profileMissing.length
        ? `Automations sign texts and send owner alerts with these. Missing: ${profileMissing.join(', ')}.`
        : 'Business name, owner, website and where owner alerts go are all set.',
      done: !profileMissing.length,
      href: 'settings',
      cta: 'Open business profile',
    },
    {
      key: 'number',
      title: 'Get a phone number',
      detail: number ? `${number.number} is this sub-account’s number.` : 'Buy a toll-free number: leads text and call it, and every automation texts from it.',
      done: !!number,
      href: 'settings?tab=numbers',
      cta: 'Buy a number',
    },
    {
      key: 'texting',
      title: 'Get texting approved',
      detail: !number
        ? 'Comes after the number: Hell-level files the toll-free verification with Twilio for you (no code from the client).'
        : number.kind !== 'toll_free'
          ? 'Local numbers need A2P 10DLC registration, which Hell-level doesn’t file. Use a toll-free number to text.'
          : number.verificationStatus === 'approved'
            ? 'Twilio approved this number for texting.'
            : number.verificationStatus === 'rejected'
              ? `Twilio rejected the verification${number.verificationNote ? `: ${number.verificationNote}` : ''}. Fix and file again.`
              : number.verificationSid
                ? 'Filed with Twilio; usually approved within a few business days.'
                : 'File the toll-free verification: one click, filled from the business profile.',
      done: number?.kind === 'toll_free' && number.verificationStatus === 'approved',
      href: 'settings?tab=numbers',
      cta: number?.verificationSid ? 'Check status' : 'File verification',
    },
    {
      key: 'calls',
      title: 'Connect calls',
      detail: number?.forwardTo
        ? `Calls ring ${number.forwardTo}; unanswered ones get the text-back.`
        : 'Set the phone calls ring, or forward the owner’s own line here when they don’t answer.',
      done: !!number?.forwardTo || calls > 0,
      href: 'settings?tab=numbers',
      cta: 'Set call forwarding',
    },
    {
      key: 'form',
      title: 'Put the form and chat widget on the website',
      detail: submissions ? `${submissions} submission${submissions === 1 ? '' : 's'} received.` : 'Copy the embed code into the Lovable site. Done once the first lead comes through.',
      done: submissions > 0,
      href: 'sites',
      cta: 'Get embed code',
    },
    {
      key: 'automations',
      title: 'Turn on the lead automations',
      detail: 'Missed-call text-back, quote form and chat widget replies.',
      done: live('missed_call') && live('quote_form') && live('chat_widget'),
      href: 'automation',
      cta: 'Open automations',
    },
    {
      key: 'reviews',
      title: 'Turn on Google review requests',
      detail: p.reviewLink ? 'Texts a review link when a job moves to “Job Complete”.' : 'Add the Google review link to the profile, then switch the review workflow on.',
      done: !!p.reviewLink && live('review_request'),
      href: p.reviewLink ? 'automation' : 'settings',
      cta: p.reviewLink ? 'Switch it on' : 'Add review link',
    },
  ]
  const done = items.filter((i) => i.done).length
  return { items, done, total: items.length }
}
