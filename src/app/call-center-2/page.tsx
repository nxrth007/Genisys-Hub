import { PhoneCall } from 'lucide-react'
import { PageHeader } from '@/components/ui/page-header'

/**
 * Call Center 2 — deliberately empty scaffold.
 *
 * The original /call-center was built around the solar model: cold
 * callers booking homeowner appointments, measured by dials, sets, and
 * a master tracker of bookings. Genisys no longer sells that. The
 * business now sells contractors a $297/mo package, which means the
 * unit of work, the funnel stages, and the numbers worth watching are
 * all different — and none of them are decided yet.
 *
 * So this stays blank on purpose. Guessing at KPI cards now would just
 * produce a second screen of numbers nobody trusts, which is exactly
 * the problem the old one has. The old section is untouched and still
 * reachable at /call-center until its data is confirmed dead.
 */
export default function CallCenterTwoPage() {
  return (
    <div className="mx-auto flex max-w-[1280px] flex-col gap-6 p-6">
      <PageHeader
        title="Call Center 2"
        subtitle="Rebuild for the contractor model — not yet configured."
        breadcrumbs={[{ label: 'Genisys' }, { label: 'Call Center 2' }]}
      />

      <div className="flex flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-border bg-card px-6 py-20 text-center">
        <div className="flex size-12 items-center justify-center rounded-full bg-primary-soft">
          <PhoneCall className="size-5 text-primary" strokeWidth={1.75} />
        </div>
        <h2 className="text-lg font-semibold text-foreground">
          Nothing here yet
        </h2>
        <p className="max-w-md text-sm text-muted-foreground">
          This is the replacement for the old solar call center. It stays
          empty until the contractor funnel is defined — what a stage is,
          what counts as progress, and which numbers actually matter.
        </p>
        <p className="max-w-md text-xs text-muted-foreground">
          The original Call Center is still available and unchanged.
        </p>
      </div>
    </div>
  )
}
