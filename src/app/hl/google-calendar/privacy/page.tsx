import { APP_NAME, CONTACT_EMAIL, CONTACT_PHONE, DocFrame } from '../frame'

export const metadata = { title: `${APP_NAME}: Privacy Policy` }

/**
 * The privacy policy Google's OAuth review reads for Hell Level Calendar. It
 * must say how the app accesses, uses, stores and shares Google user data,
 * and carry Google's Limited Use statement. Keep it true to
 * src/lib/hl/google-calendar.ts and google-sync.ts.
 */
export default function GoogleCalendarPrivacyPage() {
  return (
    <DocFrame>
      <h1 className="text-[30px] font-semibold tracking-[-0.01em] text-[#101828]">{APP_NAME} Privacy Policy</h1>
      <p className="mt-2 text-[14px] text-[#667085]">Effective October 25, 2026</p>
      <p>
        Lead Genisys LLC (“Lead Genisys”, “we”, “us”) runs {APP_NAME}, which connects a team member’s Google Calendar to the booking calendars Lead Genisys provides to their business. This
        policy explains what Google user data the app accesses, how it’s used, stored and shared, and how to remove it. For our website and other services, see our{' '}
        <a href="https://www.leadgenisys.com/privacy-policy" className="font-medium text-[#155EEF] underline">
          main privacy policy
        </a>
        .
      </p>

      <h2>Google user data we access</h2>
      <p>When you connect your Google Calendar, you allow {APP_NAME} to:</p>
      <ul>
        <li>See your Google account’s email address.</li>
        <li>See the list of your calendars: their names and whether you can add events to them.</li>
        <li>
          See events on the calendars you choose to check for busy times: their start and end times, and whether they’re marked busy or free, cancelled, or declined by you. For a
          calendar you can only see availability for, just the times it’s busy.
        </li>
        <li>
          Create, update and delete the appointment events it adds to the calendar you choose for bookings, including a Google Meet link when the booking calendar uses Meet, and see changes
          made to those events.
        </li>
      </ul>
      <p className="text-[14px] text-[#667085]">
        Google permissions requested: view and edit events on your calendars; see the list of your calendars; see the availability on calendars you have access to; and see your email
        address.
      </p>

      <h2>How we use it</h2>
      <ul>
        <li>To show which Google account is connected.</li>
        <li>To keep the times you’re busy from being offered on your booking pages.</li>
        <li>To add each appointment booked with you to your Google Calendar, keep it up to date, and remove it when it’s cancelled.</li>
        <li>To move or cancel a booking when you move or delete its event in Google Calendar, unless your business has switched that off.</li>
      </ul>
      <p>
        We use Google user data only for these features. We don’t use it for advertising, we don’t sell it, and we don’t use it to train AI or machine-learning models.
      </p>

      <h2>How we store and protect it</h2>
      <ul>
        <li>Your Google sign-in token is encrypted and stored on our servers. It’s used only to reach your Google Calendar for the features above.</li>
        <li>Event times read from your calendars are kept for a few minutes to show availability, then discarded. We don’t store the titles, descriptions or guests of your own events.</li>
        <li>
          For each appointment event the app adds, we keep the event’s ID so we can update or remove it later. The appointment itself (its time, the customer’s name and contact details, and
          where it is) is part of your business’s booking records with Lead Genisys.
        </li>
        <li>Everything sent to and from Google travels over encrypted connections.</li>
      </ul>

      <h2>Sharing</h2>
      <p>We don’t share Google user data with anyone, except:</p>
      <ul>
        <li>
          Your business, and the Lead Genisys staff who support it, can see the appointments in its booking records, including times kept in step with your Google Calendar. Our staff may use
          our AI assistant to answer questions about those bookings; it isn’t trained on your data.
        </li>
        <li>Our hosting provider processes data on our behalf to run the service.</li>
        <li>When the law requires it, or to protect the security of the service.</li>
      </ul>

      <h2>Limited Use</h2>
      <p>
        {APP_NAME}’s use and transfer to any other app of information received from Google APIs will adhere to the{' '}
        <a href="https://developers.google.com/terms/api-services-user-data-policy" className="font-medium text-[#155EEF] underline">
          Google API Services User Data Policy
        </a>
        , including the Limited Use requirements.
      </p>

      <h2>Keeping and deleting your data</h2>
      <p>
        When your calendar is disconnected, we delete the stored sign-in token and stop reading your calendar. Appointment events already added to your Google Calendar stay there, and you can
        delete them in Google Calendar. You can remove the app’s access at any time at{' '}
        <a href="https://myaccount.google.com/permissions" className="font-medium text-[#155EEF] underline">
          myaccount.google.com/permissions
        </a>
        . To ask us to delete your data, email{' '}
        <a href={`mailto:${CONTACT_EMAIL}`} className="font-medium text-[#155EEF] underline">
          {CONTACT_EMAIL}
        </a>
        .
      </p>

      <h2>Changes</h2>
      <p>If this policy changes, we’ll update this page and its effective date.</p>

      <h2>Contact</h2>
      <p>
        Lead Genisys LLC ·{' '}
        <a href={`mailto:${CONTACT_EMAIL}`} className="font-medium text-[#155EEF] underline">
          {CONTACT_EMAIL}
        </a>{' '}
        · {CONTACT_PHONE}
      </p>
    </DocFrame>
  )
}
