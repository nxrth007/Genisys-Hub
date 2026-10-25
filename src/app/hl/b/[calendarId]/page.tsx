import Script from 'next/script'
import { notFound } from 'next/navigation'
import { publicCalendar } from '@/lib/hl/booking'
import { BookingWidget } from '@/components/hell-level/booking-widget'
import { BookingFrame, lengthText, type FrameFact } from '@/components/hell-level/booking-frame'
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
  const facts: FrameFact[] = [
    { icon: 'clock', text: calendar.durations.map(lengthText).join(' / ') },
    ...(calendar.location ? [{ icon: 'pin' as const, text: calendar.location }] : []),
    ...(calendar.recurring ? [{ icon: 'repeat' as const, text: calendar.recurring }] : []),
  ]
  return (
    <>
      <BookingFrame color={calendar.color} business={calendar.business} logo={calendar.logo} title={calendar.name} facts={facts} description={calendar.description} legal={calendar.legal}>
        <BookingWidget calendar={calendar} pageUrl={page ?? null} />
      </BookingFrame>
      <FrameHeight formId={calendar.id} />
      {calendar.pixelId && (
        <Script id="hl-fb-pixel" strategy="afterInteractive">
          {`!function(f,b,e,v,n,t,s){if(f.fbq)return;n=f.fbq=function(){n.callMethod?n.callMethod.apply(n,arguments):n.queue.push(arguments)};if(!f._fbq)f._fbq=n;n.push=n;n.loaded=!0;n.version='2.0';n.queue=[];t=b.createElement(e);t.async=!0;t.src=v;s=b.getElementsByTagName(e)[0];s.parentNode.insertBefore(t,s)}(window,document,'script','https://connect.facebook.net/en_US/fbevents.js');fbq('init','${calendar.pixelId}');fbq('track','PageView');`}
        </Script>
      )}
    </>
  )
}
