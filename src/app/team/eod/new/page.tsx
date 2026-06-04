import { EodReportForm } from '@/components/agent/eod-report-form'

/**
 * Team #1 EOD submission form. Same component Mary uses, just
 * routed at the team URLs so middleware lets team_member through.
 * The form props point the POST + redirects at /api/team/eod-reports
 * and /team/eod respectively.
 */
export default function NewTeamEodReportPage() {
  return (
    <div className="p-6">
      <EodReportForm
        mode="create"
        apiBase="/api/team/eod-reports"
        pageBase="/team/eod"
      />
    </div>
  )
}
