'use client'

import { useEffect, useState } from 'react'
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
 * Defaults to the last 30 days when the URL has no params, matching
 * the mockup's default scope.
 */
export default function CallCenterLayout({
  children,
}: {
  children: React.ReactNode
}) {
  const router = useRouter()
  const params = useSearchParams()

  // Hydrate from URL on mount; keep local state for the picker so it
  // can debounce / cleanly handle range edits before pushing to URL.
  const [range, setRange] = useState<DateRange>(() =>
    rangeFromParams(params) ?? defaultRange(30)
  )

  // Mirror URL → local state when params change externally (e.g.
  // user clicks a different tab and the URL might carry params, or
  // back/forward navigates to a different filter).
  useEffect(() => {
    const next = rangeFromParams(params)
    if (next) setRange(next)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params])

  function commit(next: DateRange) {
    setRange(next)
    // Push the new range as URL params using a shallow replace so
    // the page component re-renders + sees the new searchParams,
    // without a full navigation.
    const sp = new URLSearchParams(params.toString())
    sp.set('since', next.start.toISOString())
    sp.set('until', next.end.toISOString())
    router.replace(`?${sp.toString()}`, { scroll: false })
  }

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

      {/* Tab pills + date-range picker, side-by-side on the same row
          so the calendar stays in reach regardless of which tab is
          active. */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <CallCenterTabs />
        <DateRangePicker value={range} onChange={commit} align="end" />
      </div>

      {children}
    </div>
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
