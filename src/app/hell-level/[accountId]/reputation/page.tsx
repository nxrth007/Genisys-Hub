'use client'

import Link from 'next/link'
import { Suspense } from 'react'
import { useParams } from 'next/navigation'
import { useQuery } from '@tanstack/react-query'
import { Star } from 'lucide-react'
import { contactLabel, useAccount } from '@/components/hell-level/bits'
import { NotYet, useSectionTab } from '@/components/hell-level/section'
import { Badge, Card, Empty, ErrorNote, PageHeader, Spinner, Table, fmtDateTime, hlFetch } from '@/components/hell-level/ui'

type Reviews = {
  workflows: { id: string; name: string; status: string }[]
  runs: { id: string; status: string; createdAt: string; nextRunAt: string | null; workflowId: string; contact: { id: string; firstName: string | null; lastName: string | null; phone: string | null; email: string | null } }[]
}

const NOT_YET: Record<string, { title: string; what: string }> = {
  reviews: { title: 'Reviews', what: 'Reading and replying to Google and Facebook reviews from one place. GHL’s API doesn’t export reviews; they stay on Google.' },
  widgets: { title: 'Widgets', what: 'Review badges and carousels for the website.' },
  listings: { title: 'Listings', what: 'Keeping the business’s name, address and phone the same across directories.' },
  settings: { title: 'Reputation Settings', what: 'Review request wording, timing and channels. Edit the “Google Review Request” workflow under Automation for now.' },
}

export default function ReputationPage() {
  return (
    <Suspense fallback={<div className="flex justify-center py-24"><Spinner /></div>}>
      <Reputation />
    </Suspense>
  )
}

function Reputation() {
  const { accountId } = useParams<{ accountId: string }>()
  const tab = useSectionTab('reputation')
  const account = useAccount(accountId)
  const q = useQuery<Reviews>({ queryKey: ['hl', 'reports', accountId, 'reviews'], queryFn: () => hlFetch(`/api/hl/accounts/${accountId}/reports?kind=reviews&days=365`), enabled: tab === 'overview' || tab === 'requests' })
  if (NOT_YET[tab]) return <NotYet title={NOT_YET[tab].title} what={NOT_YET[tab].what} />
  const link = account.data?.account.profile.reviewLink
  const runs = q.data?.runs ?? []
  const live = q.data?.workflows.some((w) => w.status === 'published')
  if (tab === 'requests')
    return (
      <div className="mx-auto flex max-w-6xl flex-col gap-4 px-6 py-6">
        <PageHeader title="Review Requests" description="Everyone the review workflow has texted (last 12 months)." />
        <Card>
          {q.isLoading ? (
            <div className="flex justify-center py-14">
              <Spinner />
            </div>
          ) : !runs.length ? (
            <Empty icon={<Star className="h-5 w-5" />} title="No review requests yet">
              Moving a job to “Job Complete” on the pipeline sends one when the review workflow is on.
            </Empty>
          ) : (
            <Table head={['Contact', 'Requested', 'Status']}>
              {runs.map((r) => (
                <tr key={r.id} className="border-b border-border-soft last:border-0">
                  <td className="px-4 py-2.5">
                    <Link href={`/hell-level/${accountId}/conversations?contact=${r.contact.id}`} className="text-primary hover:underline">
                      {contactLabel(r.contact)}
                    </Link>
                  </td>
                  <td className="px-4 py-2.5 text-muted-foreground">{fmtDateTime(r.createdAt)}</td>
                  <td className="px-4 py-2.5">
                    <Badge color={r.status === 'done' ? 'green' : r.status === 'waiting' ? 'blue' : 'gray'}>{r.status === 'waiting' ? 'Scheduled' : r.status === 'done' ? 'Sent' : r.status}</Badge>
                  </td>
                </tr>
              ))}
            </Table>
          )}
        </Card>
        <ErrorNote error={q.error} />
      </div>
    )
  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-4 px-6 py-6">
      <PageHeader title="Reputation Overview" />
      <div className="grid gap-3 md:grid-cols-3">
        <Card className="p-4">
          <p className="eyebrow text-muted-foreground">Requests sent (12 months)</p>
          <p className="mt-2 text-[26px] font-semibold tabular-nums">{runs.filter((r) => r.status === 'done').length}</p>
        </Card>
        <Card className="p-4">
          <p className="eyebrow text-muted-foreground">Scheduled</p>
          <p className="mt-2 text-[26px] font-semibold tabular-nums">{runs.filter((r) => r.status === 'waiting').length}</p>
        </Card>
        <Card className="p-4">
          <p className="eyebrow text-muted-foreground">Review workflow</p>
          <p className="mt-3">{live ? <Badge color="green">On</Badge> : <Badge color="amber">Off</Badge>}</p>
        </Card>
      </div>
      <Card className="p-5 text-[13px] text-foreground/90">
        {link ? (
          <>
            Review link:{' '}
            <a href={link} target="_blank" rel="noreferrer" className="break-all text-primary hover:underline">
              {link}
            </a>
          </>
        ) : (
          <>
            No Google review link yet. Add it under{' '}
            <Link href={`/hell-level/${accountId}/settings?tab=business-profile`} className="text-primary hover:underline">
              Settings → Business Profile
            </Link>{' '}
            so requests can go out.
          </>
        )}
      </Card>
      <ErrorNote error={q.error} />
    </div>
  )
}
