import { notFound } from 'next/navigation'
import { prisma } from '@/lib/prisma'
import { readProfile } from '@/lib/hl/accounts'

export const dynamic = 'force-dynamic'

type Props = { params: Promise<{ accountId: string; doc: string }> }

export const metadata = { robots: { index: false } }

/**
 * A client's texting privacy policy and terms, linked from their forms and
 * filed with the toll-free verification (Twilio requires both URLs). Plain
 * wording covering what carriers check: what's sent, how often, cost,
 * STOP/HELP, and that phone numbers aren't shared for marketing.
 */
export default async function LegalPage({ params }: Props) {
  const { accountId, doc } = await params
  if (doc !== 'privacy' && doc !== 'terms') notFound()
  const account = await prisma.hlAccount.findUnique({ where: { id: accountId }, select: { name: true, profile: true, archivedAt: true } })
  if (!account || account.archivedAt) notFound()
  const p = readProfile(account.profile)
  const business = p.businessName || account.name
  const contact = [p.businessPhone && `call ${p.businessPhone}`, p.notifyEmail?.split(',')[0] && `email ${p.notifyEmail.split(',')[0].trim()}`].filter(Boolean).join(' or ')
  const updated = 'October 2026'
  return (
    <div className="min-h-screen bg-white text-[#344054]" style={{ colorScheme: 'light' }}>
      <style>{'html,body{background:#fff!important;color-scheme:light}'}</style>
      <main className="mx-auto max-w-2xl px-6 py-12 text-[15px] leading-relaxed [&_h2]:mt-8 [&_h2]:text-[17px] [&_h2]:font-semibold [&_h2]:text-[#101828] [&_p]:mt-3">
        <p className="text-[13px] uppercase tracking-wide text-[#98A2B3]">{business}</p>
        <h1 className="mt-1 text-[28px] font-semibold text-[#101828]">{doc === 'privacy' ? 'Privacy Policy' : 'Text Messaging Terms'}</h1>
        <p className="text-[13px] text-[#98A2B3]">Last updated {updated}</p>
        {doc === 'privacy' ? (
          <>
            <h2>What we collect</h2>
            <p>When you fill in a form or chat on our website, call us or text us, we collect what you give us: your name, phone number, email address and details about the work you need.</p>
            <h2>How we use it</h2>
            <p>Only to respond to your request: to call or text you back, send you a quote, schedule and carry out the job, and, if you agree, ask how we did.</p>
            <h2>Text messages</h2>
            <p>We text you only if you checked the consent box on our form, or called or texted us first. You can reply STOP at any time to stop texts, and HELP for help.</p>
            <p>
              <strong>No mobile information will be shared with third parties or affiliates for marketing or promotional purposes.</strong> Text messaging originator opt-in data and consent are not shared with any third parties. We share information only with the service providers that deliver our messages and run our systems, and only so they can do that.
            </p>
            <h2>Your choices</h2>
            <p>To see, correct or delete the information we hold about you{contact ? `, ${contact}` : ', contact us'}.</p>
          </>
        ) : (
          <>
            <h2>The program</h2>
            <p>{business} sends text messages to customers who ask for a quote or service: confirming your request, following up on calls we missed, scheduling, updates about your job and, once it’s done, a request for a review.</p>
            <h2>How you join</h2>
            <p>By checking the texting consent box on our website form, or by calling or texting us first. Consent isn’t a condition of any purchase.</p>
            <h2>Frequency and cost</h2>
            <p>Message frequency varies with your request. Message and data rates may apply. Carriers are not liable for delayed or undelivered messages.</p>
            <h2>Stopping and help</h2>
            <p>Reply <strong>STOP</strong> to any message to stop receiving texts; you’ll get one message confirming it. Reply <strong>START</strong> to rejoin. Reply <strong>HELP</strong> for help{contact ? `, or ${contact}` : ''}.</p>
            <h2>Privacy</h2>
            <p>
              See our <a className="underline" href={`/hl/legal/${accountId}/privacy`}>Privacy Policy</a>. No mobile information will be shared with third parties or affiliates for marketing or promotional purposes.
            </p>
          </>
        )}
      </main>
    </div>
  )
}
