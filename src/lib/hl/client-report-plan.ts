/**
 * The client report (Alex, 2026-11-15): from a client's folder in Sites, once they're fully set up,
 * Genisys emails the client what their system did for them in the last 30 days, and can include the
 * link to their own login. Pure (tests load it): when a client is ready for one, and the email itself.
 * ./client-report.ts gathers the numbers and sends it.
 *
 * The email never says "Hell-level" (Genisys's own name for it): to the client it's their Genisys
 * system and their dashboard.
 */

export type ReadyFacts = {
  /** Clients has their site link. */
  siteLive: boolean
  /** Their domain (Hell-level Domains, or the site link's own). */
  domain: boolean
  /** Their Hell-level toll-free number. */
  tollFree: { verificationStatus: string; forwardTo: string | null } | null
  /** The site embeds their Hell-level form and chat: built by Forge, swapped, or seen on the live site. */
  siteOnHellLevel: boolean
  workflows: { template: string | null; status: string }[]
  reviewLink: boolean
  /** What their business profile lacks (the Launchpad's list). */
  profileMissing: string[]
}

export type ReadyItem = { key: string; label: string; done: boolean; note: string | null }

/** Fully set up: everything the $297 package does, working on its own. The report waits for all of it. */
export function reportReadiness(f: ReadyFacts): { ready: boolean; items: ReadyItem[] } {
  const live = (t: string) => f.workflows.some((w) => w.template === t && w.status === 'published')
  const v = f.tollFree?.verificationStatus ?? 'none'
  const items: ReadyItem[] = [
    { key: 'site', label: 'Website live', done: f.siteLive, note: f.siteLive ? null : 'Add the site link on Clients once it’s live.' },
    { key: 'domain', label: 'Domain', done: f.domain, note: f.domain ? null : 'Buy their domain (Domain for the site).' },
    { key: 'number', label: 'Toll-free number', done: !!f.tollFree, note: f.tollFree ? null : 'Buy their number (Toll-free number for the site).' },
    {
      key: 'texting',
      label: 'Texting approved',
      done: v === 'approved',
      note:
        v === 'approved'
          ? null
          : !f.tollFree
            ? 'Comes after the number.'
            : v === 'pending' || v === 'in_review'
              ? 'Twilio is reviewing the verification.'
              : v === 'rejected'
                ? 'Twilio rejected the verification: fix it and file again in Hell-level.'
                : 'The verification isn’t filed yet.',
    },
    { key: 'calls', label: 'Calls ring the owner', done: !!f.tollFree?.forwardTo, note: f.tollFree?.forwardTo ? null : 'Set where calls ring (Hell-level → Settings → Phone Numbers).' },
    {
      key: 'form',
      label: 'Site uses Hell-level’s form and chat',
      done: f.siteOnHellLevel,
      note: f.siteOnHellLevel ? null : 'Their site still has GoHighLevel’s form and chat (or none): swap them first.',
    },
    {
      key: 'automations',
      label: 'Lead automations on',
      done: live('missed_call') && live('quote_form') && live('chat_widget'),
      note: live('missed_call') && live('quote_form') && live('chat_widget') ? null : 'Missed-call text-back, quote form and chat replies (Hell-level → Automation).',
    },
    {
      key: 'reviews',
      label: 'Google review requests on',
      done: f.reviewLink && live('review_request'),
      note: f.reviewLink ? (live('review_request') ? null : 'Switch the review workflow on (Hell-level → Automation).') : 'Add their Google review link to the business profile.',
    },
    {
      key: 'profile',
      label: 'Business profile complete',
      done: !f.profileMissing.length,
      note: f.profileMissing.length ? `Missing: ${f.profileMissing.join(', ')}.` : null,
    },
  ]
  return { ready: items.every((i) => i.done), items }
}

/** What their system did over the report's days. */
export type ReportNumbers = {
  days: number
  leads: number
  /** Quote form and chat messages. */
  forms: number
  callsAnswered: number
  /** Missed calls: each got the automatic text back. */
  callsMissed: number
  textsSent: number
  textsReceived: number
  appointments: number
  reviewRequests: number
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
const n = (x: number) => x.toLocaleString('en-US')

export type ReportEmail = { subject: string; html: string }

/**
 * The email: their numbers, their setup, and (when asked) the link to choose their dashboard
 * password. Inline styles only: mail apps ignore style sheets.
 */
export function reportEmail(o: {
  business: string
  firstName: string | null
  numbers: ReportNumbers
  site: { url: string; host: string }
  /** Their number as people see it, "(855) 609-0482". */
  phone: string
  login: { link: string; email: string } | null
  /** Where they sign in afterwards. */
  signInUrl: string
}): ReportEmail {
  const r = o.numbers
  const stat = (label: string, value: number, note = '') =>
    `<tr><td style="padding:10px 0;border-bottom:1px solid #eceef1;color:#3b4250;font-size:14px">${esc(label)}${note ? `<div style="color:#8a92a0;font-size:12px;margin-top:2px">${esc(note)}</div>` : ''}</td><td style="padding:10px 0;border-bottom:1px solid #eceef1;text-align:right;font-size:20px;font-weight:600;color:#111827">${n(value)}</td></tr>`
  const quiet = r.leads === 0 && r.forms === 0 && r.callsAnswered + r.callsMissed === 0
  const intro = quiet
    ? `Your Genisys system is set up and working for ${esc(o.business)}. Every new lead from your website gets a text right away, and missed calls get a text back. Here’s the last ${r.days} days:`
    : `Here’s what your Genisys system did for ${esc(o.business)} in the last ${r.days} days:`
  const login = o.login
    ? `<tr><td style="padding:24px 32px 0">
        <div style="border:1px solid #e3e6eb;border-radius:10px;padding:18px 20px;background:#f8f9fb">
          <div style="font-size:15px;font-weight:600;color:#111827">Your dashboard</div>
          <div style="font-size:14px;color:#3b4250;margin-top:6px;line-height:1.5">See every lead, conversation and appointment in one place. Choose your password to get in (this link works for 7 days):</div>
          <div style="margin-top:14px"><a href="${esc(o.login.link)}" style="display:inline-block;background:#111827;color:#ffffff;text-decoration:none;font-size:14px;font-weight:600;padding:10px 18px;border-radius:8px">Choose my password</a></div>
          <div style="font-size:12.5px;color:#6b7280;margin-top:12px">After that, sign in any time at <a href="${esc(o.signInUrl)}" style="color:#111827">${esc(o.signInUrl.replace(/^https?:\/\//, ''))}</a> with ${esc(o.login.email)}.</div>
        </div>
      </td></tr>`
    : ''
  const html = `<!DOCTYPE html>
<html><body style="margin:0;padding:0;background:#f3f4f6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f3f4f6;padding:24px 12px"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;background:#ffffff;border-radius:12px;overflow:hidden">
  <tr><td style="padding:28px 32px 0;font-size:13px;font-weight:700;letter-spacing:.08em;color:#6b7280">GENISYS</td></tr>
  <tr><td style="padding:14px 32px 0;font-size:15px;line-height:1.55;color:#111827">Hi ${esc(o.firstName || 'there')},</td></tr>
  <tr><td style="padding:10px 32px 0;font-size:15px;line-height:1.55;color:#111827">${intro}</td></tr>
  <tr><td style="padding:12px 32px 0"><table role="presentation" width="100%" cellpadding="0" cellspacing="0">
    ${stat('New leads', r.leads)}
    ${stat('Quote form and chat messages', r.forms)}
    ${stat('Calls answered', r.callsAnswered)}
    ${stat('Missed calls texted back', r.callsMissed, 'Each one got an automatic text so the lead wasn’t lost')}
    ${stat('Texts sent to your leads', r.textsSent)}
    ${stat('Replies from leads', r.textsReceived)}
    ${stat('Appointments booked', r.appointments)}
    ${stat('Google review requests sent', r.reviewRequests)}
  </table></td></tr>
  <tr><td style="padding:24px 32px 0;font-size:15px;font-weight:600;color:#111827">Your setup</td></tr>
  <tr><td style="padding:8px 32px 0;font-size:14px;line-height:1.7;color:#3b4250">
    Website: <a href="${esc(o.site.url)}" style="color:#111827">${esc(o.site.host)}</a><br>
    Your number: ${esc(o.phone)}. Calls ring you, and missed calls get a text back.<br>
    Texting: approved, so every lead gets an instant text.<br>
    Google reviews: happy customers get a text asking for a review.
  </td></tr>
  ${login}
  <tr><td style="padding:24px 32px 28px;font-size:14px;line-height:1.55;color:#3b4250">Questions? Just reply to this email.<br><br>The Genisys team</td></tr>
</table>
</td></tr></table>
</body></html>`
  return { subject: `${o.business}: your last ${r.days} days with Genisys`, html }
}
