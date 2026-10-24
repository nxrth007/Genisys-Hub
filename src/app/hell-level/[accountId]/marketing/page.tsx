'use client'

import { Suspense } from 'react'
import { useParams } from 'next/navigation'
import { NotYet, RecordsTable, rv, useSectionTab } from '@/components/hell-level/section'
import { Spinner } from '@/components/hell-level/ui'

const NOT_YET: Record<string, { title: string; what: string }> = {
  'social-planner': { title: 'Social Planner', what: 'Scheduling posts to Facebook, Instagram, Google Business Profile and LinkedIn.' },
  emails: { title: 'Emails', what: 'Email campaigns and templates to contact lists.' },
  'countdown-timers': { title: 'Countdown Timers', what: 'Countdown images for emails and pages.' },
  'affiliate-manager': { title: 'Affiliate Manager', what: 'Affiliate programs and payouts.' },
  'brand-boards': { title: 'Brand Boards', what: 'Logos, colours and fonts for the business.' },
  'ad-manager': { title: 'Ad Manager', what: 'Running Facebook and Google ads from the sub-account.' },
}

export default function MarketingPage() {
  return (
    <Suspense fallback={<div className="flex justify-center py-24"><Spinner /></div>}>
      <Marketing />
    </Suspense>
  )
}

function Marketing() {
  const { accountId } = useParams<{ accountId: string }>()
  const tab = useSectionTab('marketing')
  if (tab === 'snippets')
    return (
      <RecordsTable
        accountId={accountId}
        kind="snippet"
        title="Snippets"
        emptyText="Text and email snippets from GoHighLevel show up here after the import."
        columns={[
          { label: 'Name', render: (r) => <span className="font-medium text-foreground">{r.name}</span> },
          { label: 'Type', render: (r) => <span className="eyebrow text-muted-foreground">{rv(r, 'type') || 'sms'}</span> },
          { label: 'Message', render: (r) => <span className="line-clamp-2 max-w-xl text-muted-foreground">{rv(r, 'template.body', 'template.text', 'body')}</span> },
        ]}
      />
    )
  if (tab === 'trigger-links')
    return (
      <RecordsTable
        accountId={accountId}
        kind="trigger_link"
        title="Trigger Links"
        emptyText="Trigger links from GoHighLevel show up here after the import."
        columns={[
          { label: 'Name', render: (r) => <span className="font-medium text-foreground">{r.name}</span> },
          { label: 'Redirects to', render: (r) => <span className="break-all text-muted-foreground">{rv(r, 'redirectTo')}</span> },
        ]}
      />
    )
  const n = NOT_YET[tab]
  return <NotYet title={n?.title ?? 'Marketing'} what={n?.what ?? 'Not in Hell-level yet.'} />
}
