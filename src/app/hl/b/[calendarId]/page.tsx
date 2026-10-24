import Script from 'next/script'
import { notFound } from 'next/navigation'
import { publicCalendar } from '@/lib/hl/booking'
import { BookingWidget } from '@/components/hell-level/booking-widget'
import { FrameHeight } from '@/components/hell-level/frame-height'

export const dynamic = 'force-dynamic'

type Props = { params: Promise<{ calendarId: string }>; searchParams: Promise<{ page?: string }> }

export async function generateMetadata({ params }: Props) {
  const calendar = await publicCalendar((await params).calendarId)
  return { title: calendar ? `${calendar.name} | ${calendar.business}` : 'Book a time', robots: { index: false } }
}

/** A booking calendar's page (GHL's booking widget): hosted here, and embedded on the client's site in an iframe. */
export default async function BookingPage({ params, searchParams }: Props) {
  const { calendarId } = await params
  const calendar = await publicCalendar(calendarId)
  if (!calendar) notFound()
  const { page } = await searchParams
  return (
    <div className="min-h-screen bg-white text-[#101828]" style={{ colorScheme: 'light', ['--hl-c' as string]: calendar.color }}>
      <style>{'html,body{background:#fff!important;color-scheme:light}'}</style>
      <main className="mx-auto grid w-full max-w-4xl gap-6 px-5 py-6 md:grid-cols-[260px_minmax(0,1fr)]">
        <aside className="flex flex-col gap-2 border-b border-[#EAECF0] pb-4 md:border-b-0 md:border-r md:pb-0 md:pr-6">
          <p className="text-[13px] font-medium text-[#667085]">{calendar.business}</p>
          <h1 className="text-[22px] font-semibold leading-tight text-[#101828]">{calendar.name}</h1>
          <p className="flex items-center gap-2 text-[14px] text-[#475467]">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <circle cx="12" cy="12" r="10" />
              <path d="M12 6v6l4 2" />
            </svg>
            {calendar.durations.map((m) => (m >= 60 && m % 60 === 0 ? `${m / 60} hr` : `${m} min`)).join(' / ')}
          </p>
          {calendar.location && (
            <p className="flex items-start gap-2 text-[14px] text-[#475467]">
              <svg className="mt-0.5 shrink-0" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="M12 21s-7-5.6-7-11a7 7 0 0 1 14 0c0 5.4-7 11-7 11z" />
                <circle cx="12" cy="10" r="2.5" />
              </svg>
              {calendar.location}
            </p>
          )}
          {calendar.description && <p className="whitespace-pre-line text-[13.5px] leading-relaxed text-[#667085]">{calendar.description}</p>}
        </aside>
        <section>
          <BookingWidget calendar={calendar} pageUrl={page ?? null} />
          <p className="mt-5 text-center text-[11px] text-[#98A2B3]">
            <a href={calendar.legal.privacy} target="_blank" rel="noreferrer" className="underline">
              Privacy policy
            </a>
            {' · '}
            <a href={calendar.legal.terms} target="_blank" rel="noreferrer" className="underline">
              Texting terms
            </a>
          </p>
        </section>
      </main>
      <FrameHeight formId={calendar.id} />
      {calendar.pixelId && (
        <Script id="hl-fb-pixel" strategy="afterInteractive">
          {`!function(f,b,e,v,n,t,s){if(f.fbq)return;n=f.fbq=function(){n.callMethod?n.callMethod.apply(n,arguments):n.queue.push(arguments)};if(!f._fbq)f._fbq=n;n.push=n;n.loaded=!0;n.version='2.0';n.queue=[];t=b.createElement(e);t.async=!0;t.src=v;s=b.getElementsByTagName(e)[0];s.parentNode.insertBefore(t,s)}(window,document,'script','https://connect.facebook.net/en_US/fbevents.js');fbq('init','${calendar.pixelId}');fbq('track','PageView');`}
        </Script>
      )}
    </div>
  )
}
