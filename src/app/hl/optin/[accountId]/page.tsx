import { Fragment } from 'react'
import { notFound } from 'next/navigation'
import { prisma } from '@/lib/prisma'
import { readProfile } from '@/lib/hl/accounts'
import { cleanDetails, optInPageUrl } from '@/lib/hl/a2p'
import { resolveLegalLinks } from '@/lib/hl/legal-links'

export const dynamic = 'force-dynamic'

type Props = { params: Promise<{ accountId: string }> }

export const metadata = { title: 'How to sign up for our texts', robots: { index: false } }

/** Links in the registered wording, clickable (a trailing period or bracket isn't part of the link). */
function Linked({ text }: { text: string }) {
  return text.split(/(https?:\/\/[^\s"]+)/).map((part, i) => {
    if (i % 2 === 0) return <Fragment key={i}>{part}</Fragment>
    const url = part.replace(/[.,;:)\]]+$/, '')
    return (
      <Fragment key={i}>
        <a className="break-all underline" href={url}>
          {url}
        </a>
        {part.slice(url.length)}
      </Fragment>
    )
  })
}

/**
 * How people sign up for a sub-account's texts, a screenshot per step: the
 * page an A2P campaign's "How people opt in" links when reviewers can't see
 * the sign-up at a glance (a booking page, a form on another site). Built
 * from what was filed, so it always says what the campaign says.
 */
export default async function OptInPage({ params }: Props) {
  const { accountId } = await params
  const [account, row] = await Promise.all([
    prisma.hlAccount.findUnique({ where: { id: accountId }, select: { name: true, profile: true, archivedAt: true } }),
    prisma.hlA2p.findUnique({ where: { accountId }, select: { details: true } }),
  ])
  if (!account || account.archivedAt || !row) notFound()
  const d = cleanDetails(row.details)
  if (!d.screenshots.length) notFound()
  const p = readProfile(account.profile)
  const business = (d.path === 'sole_prop' ? d.brandName : d.legalName) || p.businessName || account.name
  const legal = resolveLegalLinks(accountId, p)
  // The registered wording, without the sentence that points back to this page.
  const self = optInPageUrl(accountId)
  const flow = d.messageFlow
    .split('\n')
    .map((line) => line.split(/(?<=[.!?])\s+/).filter((sentence) => !sentence.includes(self)).join(' '))
    .join('\n')
    .trim()

  return (
    <div className="min-h-screen bg-white text-[#344054]" style={{ colorScheme: 'light' }}>
      <style>{'html,body{background:#fff!important;color-scheme:light}'}</style>
      <main className="mx-auto max-w-3xl px-6 py-12 text-[15px] leading-relaxed">
        <p className="text-[13px] uppercase tracking-wide text-[#98A2B3]">{business}</p>
        <h1 className="mt-1 text-[28px] font-semibold text-[#101828]">How people sign up for our texts</h1>
        <p className="mt-3">
          Each step below is a screenshot of the live sign-up for text messages from {business}.
          {d.website && (
            <>
              {' '}
              Our website: <Linked text={d.website} />
            </>
          )}
        </p>

        <ol className="mt-8 flex flex-col gap-10">
          {d.screenshots.map((s, i) => (
            <li key={i}>
              <p className="text-[13px] font-semibold uppercase tracking-wide text-[#98A2B3]">Step {i + 1}</p>
              <p className="mt-1 text-[16px] text-[#101828]">
                <Linked text={s.caption} />
              </p>
              <a href={s.url} className="mt-3 block">
                {/* eslint-disable-next-line @next/next/no-img-element -- screenshots can live on any host */}
                <img src={s.url} alt={s.caption} loading={i ? 'lazy' : 'eager'} className="w-full rounded-lg border border-[#EAECF0] shadow-sm" />
              </a>
            </li>
          ))}
        </ol>

        {flow && (
          <>
            <h2 className="mt-12 text-[17px] font-semibold text-[#101828]">The sign-up, as registered with the carriers</h2>
            <p className="mt-3 whitespace-pre-line rounded-lg border border-[#EAECF0] bg-[#F9FAFB] p-4 text-[14px]">
              <Linked text={flow} />
            </p>
          </>
        )}

        <p className="mt-10 text-[14px]">
          <a className="underline" href={d.privacyUrl || legal.privacy}>
            Privacy Policy
          </a>
          {' · '}
          <a className="underline" href={d.termsUrl || legal.terms}>
            Terms
          </a>
        </p>
      </main>
    </div>
  )
}
