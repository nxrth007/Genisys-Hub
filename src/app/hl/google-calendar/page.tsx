import Link from 'next/link'
import { APP_NAME, DocFrame, PRIVACY_PATH } from './frame'

export const metadata = { title: `${APP_NAME}: Google Calendar for Lead Genisys booking calendars` }

/** The home page of the Google app calendar connections sign in through (see ./frame.tsx). */
export default function GoogleCalendarAppPage() {
  return (
    <DocFrame>
      <h1 className="text-[30px] font-semibold tracking-[-0.01em] text-[#101828]">{APP_NAME}</h1>
      <p className="mt-2 text-[17px] text-[#475467]">Google Calendar sync for the booking calendars Lead Genisys runs for contractors.</p>
      <p>
        Lead Genisys builds websites and booking systems for contractors and their teams. {APP_NAME} connects a team member’s own Google Calendar to the calendars their customers book on, so the
        bookings and their own schedule stay in step.
      </p>

      <h2>What it does</h2>
      <p>Once a team member connects their Google Calendar:</p>
      <ul>
        <li>
          <strong>No double bookings.</strong> Times they’re busy in the Google calendars they choose aren’t offered on their booking pages.
        </li>
        <li>
          <strong>Bookings go into Google Calendar.</strong> Each appointment booked with them is added to the calendar of their own they choose, with the customer’s name, contact details and a reschedule
          link, and a Google Meet link when the booking calendar uses Meet. It’s updated when the appointment is rescheduled and removed when it’s cancelled.
        </li>
        <li>
          <strong>Changes come back.</strong> If they move or delete one of those appointments in Google Calendar, the booking is moved or cancelled to match. This can be switched off.
        </li>
      </ul>

      <h2>What it uses from your Google account</h2>
      <ul>
        <li>Your email address, to show which account is connected.</li>
        <li>The list of your calendars, so you can choose where bookings go and which calendars count as busy.</li>
        <li>
          On the calendar bookings go into: the start and end times of your events, and whether they’re marked busy, cancelled or declined, to work out when you’re free. It doesn’t keep
          their titles, descriptions or guests.
        </li>
        <li>On the other calendars you choose: only the times they’re busy.</li>
        <li>The appointment events it adds itself, to keep them up to date.</li>
      </ul>
      <p>
        It doesn’t read your email, contacts or files. It never sells your data or uses it for advertising, and your Google data isn’t used to train AI models. The full details are in the{' '}
        <Link href={PRIVACY_PATH} className="font-medium text-[#155EEF] underline">
          privacy policy
        </Link>
        .
      </p>

      <h2>Connecting and disconnecting</h2>
      <p>
        Your business sends you a link to connect your Google Calendar: you sign in with Google and choose Allow. To disconnect, ask your business to disconnect it, or remove {APP_NAME} at{' '}
        <a href="https://myaccount.google.com/permissions" className="font-medium text-[#155EEF] underline">
          myaccount.google.com/permissions
        </a>
        . Appointments already added to your Google Calendar stay there.
      </p>
    </DocFrame>
  )
}
