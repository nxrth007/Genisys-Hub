import Link from 'next/link'
import {
  CheckCircle2,
  Inbox,
  MessageSquare,
  Calendar,
  Key,
  Hash,
  BookOpen,
  ArrowRight,
  LayoutDashboard,
} from 'lucide-react'
import { PageHeader } from '@/components/ui/page-header'

export default function DashboardPage() {
  return (
    <div className="max-w-6xl space-y-6">
      <PageHeader
        icon={LayoutDashboard}
        title="Welcome to Genisys Hub"
        subtitle="Your ops command center. Everything in one place, for the whole team."
      />

      {/* Quick access grid */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <QuickTile
          icon={CheckCircle2}
          label="Today"
          description="Tasks + meetings"
          href="/today"
        />
        <QuickTile icon={Inbox} label="Inbox" description="Gmail" href="/inbox" />
        <QuickTile
          icon={MessageSquare}
          label="CRM"
          description="GHL conversations"
          href="/crm"
        />
        <QuickTile icon={Calendar} label="Calendar" description="All calendars" href="/calendar" />
        <QuickTile
          icon={BookOpen}
          label="Notion"
          description="Tasks + docs"
          href="/notion"
        />
        <QuickTile icon={Hash} label="Slack" description="Client channels" href="/slack" />
        <QuickTile icon={Key} label="Vault" description="API keys" href="/vault" />
      </div>

      {/* Setup checklist */}
      <div className="rounded-xl border border-blue-200 bg-blue-50 p-6 dark:border-blue-900 dark:bg-blue-950/40">
        <h3 className="font-semibold text-blue-900 dark:text-blue-100">Initial setup</h3>
        <ol className="mt-3 space-y-2 text-sm text-blue-800 dark:text-blue-200">
          <li>1. Go to <Link href="/settings" className="underline font-medium">Settings</Link> and connect your Google account (alex@leadgenisys.com)</li>
          <li>2. Invite Ethan and Garrett (they sign in with their @leadgenisys.com Google accounts)</li>
          <li>3. Add the 4 GoHighLevel Private Integration tokens to the <Link href="/vault" className="underline font-medium">Vault</Link></li>
          <li>4. Add your Anthropic and Notion API keys to the Vault</li>
          <li>5. Set Ethan&apos;s morning brief time in <Link href="/today" className="underline font-medium">Today → Settings</Link></li>
        </ol>
      </div>
    </div>
  )
}

function QuickTile({
  icon: Icon,
  label,
  description,
  href,
}: {
  icon: React.ComponentType<{ className?: string }>
  label: string
  description: string
  href: string
}) {
  return (
    <Link
      href={href}
      className="group rounded-xl border border-zinc-200 bg-white p-5 transition-all hover:-translate-y-0.5 hover:border-blue-300 hover:shadow-md dark:border-zinc-800 dark:bg-zinc-900 dark:hover:border-blue-700"
    >
      <div className="flex items-start justify-between">
        <div className="rounded-lg bg-blue-50 p-2.5 dark:bg-blue-950/50">
          <Icon className="h-5 w-5 text-blue-600" />
        </div>
        <ArrowRight className="h-4 w-4 text-zinc-300 transition-colors group-hover:text-blue-600" />
      </div>
      <p className="mt-3 font-semibold">{label}</p>
      <p className="text-sm text-zinc-500">{description}</p>
    </Link>
  )
}
