import Link from 'next/link'
import { notFound } from 'next/navigation'
import { BarChart3, CalendarDays, CreditCard, Megaphone, Star } from 'lucide-react'

const SOON: Record<string, { title: string; icon: React.ComponentType<{ className?: string }>; text: string; meanwhile: string }> = {
  calendars: {
    title: 'Calendars',
    icon: CalendarDays,
    text: 'Booking links and appointment reminders.',
    meanwhile: 'Leads come in through the website form and calls, and the owner books them by phone.',
  },
  payments: { title: 'Payments', icon: CreditCard, text: 'Invoices and payment links for the client’s customers.', meanwhile: 'Genisys bills clients through Whop (Hub → Payments).' },
  marketing: { title: 'Marketing', icon: Megaphone, text: 'Bulk texts and email campaigns.', meanwhile: 'Automations already reply to every lead one by one.' },
  reputation: {
    title: 'Reputation',
    icon: Star,
    text: 'Review tracking and replies.',
    meanwhile: 'Review requests already work: switch on “Google Review Request” under Automation; it texts the review link when a job moves to “Job Complete”.',
  },
  reporting: { title: 'Reporting', icon: BarChart3, text: 'Call and lead-source reports.', meanwhile: 'The Dashboard has leads, calls and texts per day.' },
}

/** GHL sections Hell-level doesn't have yet: kept in the sidebar so it reads like GHL, with what to use meanwhile. */
export default async function ComingSoon({ params }: { params: Promise<{ accountId: string; section: string }> }) {
  const { accountId, section } = await params
  const s = SOON[section]
  if (!s) notFound()
  const Icon = s.icon
  return (
    <div className="mx-auto flex max-w-xl flex-col items-center gap-4 px-6 py-24 text-center">
      <span className="grid h-14 w-14 place-items-center rounded-2xl bg-[#EFF4FF] text-[#155EEF]">
        <Icon className="h-7 w-7" />
      </span>
      <h1 className="text-[22px] font-semibold text-[#101828]">{s.title} is coming</h1>
      <p className="text-[15px] text-[#475467]">{s.text}</p>
      <p className="rounded-xl border border-[#EAECF0] bg-white px-5 py-4 text-[14px] text-[#344054]">{s.meanwhile}</p>
      <Link href={`/hell-level/${accountId}/launchpad`} className="text-[14px] font-semibold text-[#155EEF] hover:underline">
        Back to Launchpad
      </Link>
    </div>
  )
}
