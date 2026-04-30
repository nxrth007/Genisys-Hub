'use client'

import { Suspense, useEffect, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { PageHeader } from '@/components/ui/page-header'
import { CallCenterTabs } from '@/components/call-center/call-center-tabs'
import {
  DateRangePicker,
  defaultRange,
  type DateRange,
} from '@/components/ui/date-range-picker'

/**
 * Shared chrome for every /call-center/* page — title + breadcrumbs,
 * tab pills, and the global date-range picker. Pages render only
 * their tab-specific content beneath; the layout hoists everything
 * common so the picker state survives tab navigation.
 *
 * Date range is synced into URL search params (?since=...&until=...)
 * so:
 *   1. Bookmarks / shared links capture the active filter window.
 *   2. Each tab page reads the same URL state via useSearchParams,
 *      so they're already filtering off the global range.
 *   3. Browser back / forward "just works" for filter changes.
 *
 * useSearchParams is a CSR-only hook in Next 16 — it forces a
 * prerender bailout on whatever component reads it. Wrapping the
 * date-picker in a <Suspense> boundary lets the rest of the layout
 * (and every page underneath it) stay statically prerenderable; the
 * picker just renders its fallback during SSR and hydrates with the
 * URL value on the client.
 */
export default function CallCenterLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <div className="mx-auto flex max-w-[1280px] flex-col gap-6">
      <PageHeader
        title="Call Center"
        breadcrumbs={[
          { label: 'Genisys' },
          { label: 'Operations' },
          { label: 'Call Center' },
        ]}
      />
      <div className="flex flex-wrap items-center justify-between gap-3">
        <CallCenterTabs />
        <Suspense fallback={<DateRangePickerSkeleton />}>
          <RangePickerSlot />
        </Suspense>
      </div>
      {children}
    </div>
  )
}

/**
 * The actual `useSearchParams` consumer. Sits behind a Suspense
 * boundary so its CSR-only hook doesn't bail prerender for the
 * whole route segment.
 */
function RangePickerSlot() {
  const router = useRouter()
  const params = useSearchParams()

  const [range, setRange] = useState<DateRange>(() =>
    rangeFromParams(params) ?? defaultRange(30)
  )

  useEffect(() => {
    const next = rangeFromParams(params)
    if (next) setRange(next)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params])

  function commit(next: DateRange) {
    setRange(next)
    const sp = new URLSearchParams(params.toString())
    sp.set('since', next.start.toISOString())
    sp.set('until', next.end.toISOString())
    router.replace(`?${sp.toString()}`, { scroll: false })
  }

  return <DateRangePicker value={range} onChange={commit} align="end" />
}

/** Skeleton shown during the brief prerender pass — same width as
 *  the real picker pill so the layout doesn't shift on hydration. */
function DateRangePickerSkeleton() {
  return (
    <div className="h-[38px] w-[268px] animate-pulse rounded-full border border-border bg-card shadow-soft" />
  )
}

/** Parse `?since=ISO&until=ISO` into a DateRange; returns null when
 *  either param is missing or unparseable so the caller can fall
 *  back to the default. Typed as a duck so it accepts both
 *  URLSearchParams and Next's ReadonlyURLSearchParams. */
function rangeFromParams(
  params: { get(key: string): string | null }
): DateRange | null {
  const since = params.get('since')
  const until = params.get('until')
  if (!since || !until) return null
  const start = new Date(since)
  const end = new Date(until)
  if (isNaN(start.getTime()) || isNaN(end.getTime())) return null
  return { start, end }
}
