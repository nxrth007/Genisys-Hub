'use client'

import { use } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Loader2 } from 'lucide-react'
import {
  EodReportForm,
  type EodFormValues,
} from '@/components/agent/eod-report-form'

/**
 * Team #1 EOD report edit page. Mirror of /agent/eod/[id] but
 * routed through the team API endpoint so middleware lets
 * team_member through.
 */

type EodReport = {
  id: string
  reportDate: string
  dialsMade: number
  contactsReached: number
  appointmentsGenerated: number
  callbacksScheduled: number
  technicalIssueTags: string[]
  technicalIssueNotes: string | null
  organizationalIssues: string | null
  wins: string | null
  tomorrowFocus: string | null
}

export default function EditTeamEodReportPage(props: {
  params: Promise<{ id: string }>
}) {
  const { id } = use(props.params)
  const query = useQuery<{ report: EodReport }>({
    queryKey: ['team-eod-report', id],
    queryFn: async () => {
      const res = await fetch(`/api/team/eod-reports/${id}`)
      if (!res.ok) throw new Error('Failed to load report')
      return res.json()
    },
  })

  if (query.isLoading) {
    return (
      <div className="flex items-center justify-center py-16">
        <Loader2 className="h-6 w-6 animate-spin text-blue-600" />
      </div>
    )
  }

  if (query.isError || !query.data) {
    return (
      <div className="mx-auto max-w-3xl rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-200">
        Couldn&apos;t load this report. It may have been deleted.
      </div>
    )
  }

  const r = query.data.report
  const initial: Partial<EodFormValues> = {
    reportDate: r.reportDate.slice(0, 10),
    dialsMade: String(r.dialsMade),
    contactsReached: String(r.contactsReached),
    appointmentsGenerated: String(r.appointmentsGenerated),
    callbacksScheduled: String(r.callbacksScheduled),
    technicalIssueTags: r.technicalIssueTags,
    technicalIssueNotes: r.technicalIssueNotes || '',
    organizationalIssues: r.organizationalIssues || '',
    wins: r.wins || '',
    tomorrowFocus: r.tomorrowFocus || '',
  }

  return (
    <div className="p-6">
      <EodReportForm
        mode="edit"
        reportId={id}
        initial={initial}
        apiBase="/api/team/eod-reports"
        pageBase="/team/eod"
      />
    </div>
  )
}
