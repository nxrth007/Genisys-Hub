import {
  Award,
  BarChart3,
  Bot,
  CalendarDays,
  Contact,
  Globe,
  Image,
  LayoutDashboard,
  MessageCircle,
  Network,
  Receipt,
  Rocket,
  Send,
  Settings,
  Sparkles,
  Star,
  Workflow,
  type LucideIcon,
} from 'lucide-react'

/**
 * Genisys OS's structure, GoHighLevel's: the sub-account's left menu in GHL's
 * order, and each section's tabs across the top bar. Tabs are ?tab= on the
 * section's page; the first built tab is the default.
 *
 * What isn't built is folded away, not deleted (Alex, 2026-11-23, like Hub
 * Settings' "Hidden" group): off the menu and the tab bars, one click away
 * under "Not built yet" for Genisys staff. Every link to it still opens.
 */

/**
 * Why a tab is off the tab bar (its page still opens from a link):
 * - later: a "Not in Genisys OS yet" page, listed under "Not built yet".
 * - imported: a list only a GoHighLevel import fills, so shown only on a
 *   sub-account imported from GHL (Lead Genisys).
 * - elsewhere: the same page lives in another section, and shows only there.
 */
export type TabFold = 'later' | 'imported' | 'elsewhere'
export type SectionTab = { key: string; label: string; fold?: TabFold }
export type Section = {
  key: string
  label: string
  icon: LucideIcon
  /** "top": Launchpad … Payments. "grow": AI Agents … Reporting (below the divider). */
  group: 'top' | 'grow'
  tabs?: SectionTab[]
  badge?: string
  /** Nothing in it is built: off the menu, under "Not built yet" (opened, it shows all its tabs). */
  later?: boolean
}

export const SECTIONS: Section[] = [
  { key: 'ask-ai', label: 'Ask AI', icon: Sparkles, group: 'top' },
  { key: 'launchpad', label: 'Launchpad', icon: Rocket, group: 'top' },
  { key: 'dashboard', label: 'Dashboard', icon: LayoutDashboard, group: 'top' },
  {
    key: 'conversations',
    label: 'Conversations',
    icon: MessageCircle,
    group: 'top',
    tabs: [
      { key: 'conversations', label: 'Conversations' },
      { key: 'manual-actions', label: 'Manual Actions', fold: 'later' },
      { key: 'snippets', label: 'Snippets', fold: 'imported' },
      { key: 'trigger-links', label: 'Trigger Links', fold: 'imported' },
    ],
  },
  {
    key: 'calendars',
    label: 'Calendars',
    icon: CalendarDays,
    group: 'top',
    tabs: [
      { key: 'calendar', label: 'Calendar View' },
      { key: 'appointments', label: 'Appointment List View' },
      { key: 'settings', label: 'Calendar Settings' },
    ],
  },
  {
    key: 'contacts',
    label: 'Contacts',
    icon: Contact,
    group: 'top',
    tabs: [
      { key: 'smart-lists', label: 'Smart Lists' },
      { key: 'bulk-actions', label: 'Bulk Actions', fold: 'later' },
      { key: 'restore', label: 'Restore', fold: 'later' },
      { key: 'tasks', label: 'Tasks' },
      { key: 'companies', label: 'Companies', fold: 'imported' },
      { key: 'manage-smart-lists', label: 'Manage Smart Lists', fold: 'later' },
    ],
  },
  {
    key: 'opportunities',
    label: 'Opportunities',
    icon: Network,
    group: 'top',
    tabs: [
      { key: 'opportunities', label: 'Opportunities' },
      // Settings → Opportunities & Pipelines is the same page.
      { key: 'pipelines', label: 'Pipelines', fold: 'elsewhere' },
      { key: 'bulk-actions', label: 'Bulk Actions', fold: 'later' },
    ],
  },
  {
    key: 'payments',
    label: 'Payments',
    icon: Receipt,
    group: 'top',
    later: true,
    tabs: [
      { key: 'invoices', label: 'Invoices & Estimates' },
      { key: 'documents', label: 'Documents & Contracts' },
      { key: 'orders', label: 'Orders' },
      { key: 'subscriptions', label: 'Subscriptions' },
      { key: 'payment-links', label: 'Payment Links' },
      { key: 'transactions', label: 'Transactions' },
      { key: 'products', label: 'Products' },
      { key: 'coupons', label: 'Coupons' },
      { key: 'settings', label: 'Settings' },
      { key: 'integrations', label: 'Integrations' },
    ],
  },
  {
    key: 'ai-agents',
    label: 'AI Agents',
    icon: Bot,
    group: 'grow',
    later: true,
    tabs: [
      { key: 'getting-started', label: 'Getting Started' },
      { key: 'voice-ai', label: 'Voice AI' },
      { key: 'conversation-ai', label: 'Conversation AI' },
      { key: 'knowledge-base', label: 'Knowledge Base' },
      { key: 'agent-templates', label: 'Agent Templates' },
      { key: 'content-ai', label: 'Content AI' },
    ],
  },
  {
    key: 'marketing',
    label: 'Marketing',
    icon: Send,
    group: 'grow',
    later: true,
    tabs: [
      { key: 'social-planner', label: 'Social Planner' },
      { key: 'emails', label: 'Emails' },
      { key: 'snippets', label: 'Snippets' },
      { key: 'countdown-timers', label: 'Countdown Timers' },
      { key: 'trigger-links', label: 'Trigger Links' },
      { key: 'affiliate-manager', label: 'Affiliate Manager' },
      { key: 'brand-boards', label: 'Brand Boards' },
      { key: 'ad-manager', label: 'Ad Manager' },
    ],
  },
  {
    key: 'automation',
    label: 'Automation',
    icon: Workflow,
    group: 'grow',
    tabs: [
      { key: 'workflows', label: 'Workflows' },
      { key: 'overview', label: 'Overview' },
      { key: 'settings', label: 'Global Workflow Settings' },
    ],
  },
  {
    key: 'sites',
    label: 'Sites',
    icon: Globe,
    group: 'grow',
    tabs: [
      // Websites first: Sites opens on it, now that Funnels shows only on imported sub-accounts.
      { key: 'websites', label: 'Websites' },
      { key: 'funnels', label: 'Funnels', fold: 'imported' },
      { key: 'stores', label: 'Stores', fold: 'later' },
      { key: 'webinars', label: 'Webinars', fold: 'later' },
      { key: 'analytics', label: 'Analytics', fold: 'later' },
      { key: 'blogs', label: 'Blogs', fold: 'later' },
      { key: 'wordpress', label: 'WordPress', fold: 'later' },
      { key: 'client-portal', label: 'Client Portal', fold: 'later' },
      { key: 'forms', label: 'Forms' },
      { key: 'surveys', label: 'Surveys', fold: 'imported' },
      { key: 'quizzes', label: 'Quizzes', fold: 'later' },
      { key: 'chat-widget', label: 'Chat Widget' },
      { key: 'qr-codes', label: 'QR Codes', fold: 'later' },
    ],
  },
  {
    key: 'memberships',
    label: 'Memberships',
    icon: Award,
    group: 'grow',
    tabs: [
      { key: 'dashboard', label: 'Dashboard' },
      { key: 'courses', label: 'Courses', fold: 'later' },
      { key: 'communities', label: 'Communities', fold: 'later' },
      { key: 'certificates', label: 'Certificates', fold: 'later' },
      { key: 'client-portal', label: 'Client Portal', fold: 'later' },
    ],
  },
  { key: 'media-storage', label: 'Media Storage', icon: Image, group: 'grow' },
  {
    key: 'reputation',
    label: 'Reputation',
    icon: Star,
    group: 'grow',
    tabs: [
      { key: 'overview', label: 'Overview' },
      { key: 'requests', label: 'Requests' },
      { key: 'reviews', label: 'Reviews', fold: 'later' },
      { key: 'widgets', label: 'Widgets', fold: 'later' },
      { key: 'listings', label: 'Listings', fold: 'later' },
      { key: 'settings', label: 'Settings', fold: 'later' },
    ],
  },
  {
    key: 'reporting',
    label: 'Reporting',
    icon: BarChart3,
    group: 'grow',
    tabs: [
      { key: 'custom-reports', label: 'Custom Reports', fold: 'later' },
      { key: 'google-ads', label: 'Google Ads', fold: 'later' },
      { key: 'facebook-ads', label: 'Facebook Ads', fold: 'later' },
      { key: 'attribution', label: 'Attribution Report', fold: 'later' },
      { key: 'call-reporting', label: 'Call Reporting' },
      { key: 'appointment-report', label: 'Appointment Report' },
    ],
  },
]

export const SETTINGS_SECTION: Section = { key: 'settings', label: 'Settings', icon: Settings, group: 'grow' }

/** GHL's Settings menu (a list down the left of the Settings page). */
export const SETTINGS_PAGES: SectionTab[] = [
  { key: 'business-profile', label: 'Business Profile' },
  { key: 'my-staff', label: 'My Staff' },
  { key: 'pipelines', label: 'Opportunities & Pipelines' },
  { key: 'automation', label: 'Automation', fold: 'later' },
  // Calendars → Calendar Settings is the same page.
  { key: 'calendars', label: 'Calendars', fold: 'elsewhere' },
  { key: 'email-services', label: 'Email Services' },
  { key: 'phone-numbers', label: 'Phone Numbers' },
  { key: 'whatsapp', label: 'WhatsApp', fold: 'later' },
  { key: 'reputation', label: 'Reputation Management', fold: 'later' },
  { key: 'custom-fields', label: 'Custom Fields', fold: 'imported' },
  { key: 'custom-values', label: 'Custom Values' },
  { key: 'merge-fields', label: 'Merge Fields' },
  { key: 'scoring', label: 'Manage Scoring', fold: 'later' },
  { key: 'domains', label: 'Domains & URL Redirects' },
  { key: 'integrations', label: 'Integrations' },
  { key: 'conversation-providers', label: 'Conversation Providers', fold: 'later' },
  { key: 'tags', label: 'Tags', fold: 'imported' },
  { key: 'labs', label: 'Labs', fold: 'later' },
  { key: 'audit-logs', label: 'Audit Logs', fold: 'later' },
  // Contacts → Companies is the same list.
  { key: 'companies', label: 'Companies', fold: 'elsewhere' },
  { key: 'brand-boards', label: 'Brand Boards', fold: 'later' },
  { key: 'private-integrations', label: 'Private Integrations', fold: 'later' },
  { key: 'import', label: 'GoHighLevel Import' },
]

export function sectionOf(key: string | undefined): Section | null {
  if (!key) return null
  if (key === 'settings') return SETTINGS_SECTION
  return SECTIONS.find((s) => s.key === key) ?? null
}

/**
 * The tabs (or Settings pages) a bar shows: the built ones, plus the imported
 * lists on a sub-account imported from GHL. A folded section shows all of its
 * tabs once opened: that's its GHL structure, kept for reference.
 */
export function shownTabs(tabs: SectionTab[], o: { imported: boolean; folded?: boolean }): SectionTab[] {
  return o.folded ? tabs : tabs.filter((t) => !t.fold || (t.fold === 'imported' && o.imported))
}

/** The tabs (or Settings pages) folded under "Not built yet". */
export function laterTabs(tabs: SectionTab[], o: { folded?: boolean } = {}): SectionTab[] {
  return o.folded ? [] : tabs.filter((t) => t.fold === 'later')
}

/** The tab a section opens on: its first built one (a folded section's first). */
export function defaultTab(section: Section | null): string | null {
  if (!section?.tabs?.length) return null
  return (section.later ? section.tabs[0] : (section.tabs.find((t) => !t.fold) ?? section.tabs[0])).key
}

/** The tab a section is on, from ?tab= (the default tab when missing or unknown; a folded tab still opens). */
export function activeTab(section: Section | null, tab: string | null): string | null {
  if (!section?.tabs?.length) return null
  return section.tabs.some((t) => t.key === tab) ? tab : defaultTab(section)
}
