import { connectTarget, readShareToken } from '@/lib/hl/google-calendar'

export const dynamic = 'force-dynamic'

type Props = { params: Promise<{ token: string }> }

export const metadata = { title: 'Connect your Google Calendar', robots: { index: false } }

/**
 * A team member's link to connect their own Google Calendar to their
 * business's booking calendars (sent from Settings → Calendars →
 * Connections). No Hub account: the signed link is the access.
 */
export default async function ConnectPage({ params }: Props) {
  const { token } = await params
  const t = readShareToken(token)
  const target = t ? await connectTarget(t.accountId, t.staffKey) : null

  return (
    <div className="min-h-screen bg-white text-[#344054]" style={{ colorScheme: 'light' }}>
      <style>{'html,body{background:#fff!important;color-scheme:light}'}</style>
      <main className="mx-auto max-w-xl px-6 py-16 text-[15px] leading-relaxed">
        {target ? (
          <>
            <p className="text-[13px] uppercase tracking-wide text-[#98A2B3]">{target.business}</p>
            <h1 className="mt-2 text-[26px] font-semibold text-[#101828]">Connect your Google Calendar</h1>
            <p className="mt-4">
              Hi {target.member}. Connecting your Google Calendar keeps your bookings with {target.business} in step with it:
            </p>
            <ul className="mt-3 list-disc space-y-1.5 pl-5">
              <li>When you’re busy in Google Calendar, people can’t book you then.</li>
              <li>Appointments booked with you show up in your Google Calendar, and move or disappear when they’re rescheduled or cancelled.</li>
              <li>Video calls get a Google Meet link when the calendar uses Meet.</li>
            </ul>
            <p className="mt-4 text-[13.5px] text-[#667085]">Google asks you to sign in and to allow access to your calendar. Only the times of your other events are used, to know when you’re busy.</p>
            <a href={`/api/hl/public/calendar-connect/${token}`} className="mt-8 inline-flex items-center gap-2 rounded-lg bg-[#1a73e8] px-5 py-3 text-[15px] font-medium text-white hover:bg-[#1765cc]">
              Connect Google Calendar
            </a>
          </>
        ) : (
          <>
            <h1 className="text-[26px] font-semibold text-[#101828]">This link has expired</h1>
            <p className="mt-4">Connect links work for a week. Ask whoever sent it for a new one.</p>
          </>
        )}
      </main>
    </div>
  )
}
