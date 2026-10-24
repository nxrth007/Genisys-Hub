import {
  Award,
  BarChart3,
  Bot,
  CalendarDays,
  Contact,
  Globe,
  Image,
  LayoutDashboard,
  LayoutGrid,
  MessageCircle,
  Network,
  Receipt,
  Rocket,
  Send,
  Settings,
  Sparkles,
  Star,
  WandSparkles,
  Workflow,
  type LucideIcon,
} from 'lucide-react'

/**
 * Hell-level's structure, GoHighLevel's: the sub-account's left menu in GHL's
 * order, and each section's tabs across the top bar. Tabs are ?tab= on the
 * section's page; the first tab is the default.
 */

export type SectionTab = { key: string; label: string }
export type Section = {
  key: string
  label: string
  icon: LucideIcon
  /** "top": Launchpad … Payments. "grow": AI Studio … App Marketplace (below the divider). */
  group: 'top' | 'grow'
  tabs?: SectionTab[]
  badge?: string
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
      { key: 'manual-actions', label: 'Manual Actions' },
      { key: 'snippets', label: 'Snippets' },
      { key: 'trigger-links', label: 'Trigger Links' },
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
      { key: 'bulk-actions', label: 'Bulk Actions' },
      { key: 'restore', label: 'Restore' },
      { key: 'tasks', label: 'Tasks' },
      { key: 'companies', label: 'Companies' },
      { key: 'manage-smart-lists', label: 'Manage Smart Lists' },
    ],
  },
  {
    key: 'opportunities',
    label: 'Opportunities',
    icon: Network,
    group: 'top',
    tabs: [
      { key: 'opportunities', label: 'Opportunities' },
      { key: 'pipelines', label: 'Pipelines' },
      { key: 'bulk-actions', label: 'Bulk Actions' },
    ],
  },
  {
    key: 'payments',
    label: 'Payments',
    icon: Receipt,
    group: 'top',
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
  { key: 'ai-studio', label: 'AI Studio', icon: WandSparkles, group: 'grow', badge: 'Beta' },
  {
    key: 'ai-agents',
    label: 'AI Agents',
    icon: Bot,
    group: 'grow',
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
      { key: 'funnels', label: 'Funnels' },
      { key: 'websites', label: 'Websites' },
      { key: 'stores', label: 'Stores' },
      { key: 'webinars', label: 'Webinars' },
      { key: 'analytics', label: 'Analytics' },
      { key: 'blogs', label: 'Blogs' },
      { key: 'wordpress', label: 'WordPress' },
      { key: 'client-portal', label: 'Client Portal' },
      { key: 'forms', label: 'Forms' },
      { key: 'surveys', label: 'Surveys' },
      { key: 'quizzes', label: 'Quizzes' },
      { key: 'chat-widget', label: 'Chat Widget' },
      { key: 'qr-codes', label: 'QR Codes' },
    ],
  },
  {
    key: 'memberships',
    label: 'Memberships',
    icon: Award,
    group: 'grow',
    tabs: [
      { key: 'dashboard', label: 'Dashboard' },
      { key: 'courses', label: 'Courses' },
      { key: 'communities', label: 'Communities' },
      { key: 'certificates', label: 'Certificates' },
      { key: 'client-portal', label: 'Client Portal' },
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
      { key: 'reviews', label: 'Reviews' },
      { key: 'widgets', label: 'Widgets' },
      { key: 'listings', label: 'Listings' },
      { key: 'settings', label: 'Settings' },
    ],
  },
  {
    key: 'reporting',
    label: 'Reporting',
    icon: BarChart3,
    group: 'grow',
    tabs: [
      { key: 'custom-reports', label: 'Custom Reports' },
      { key: 'google-ads', label: 'Google Ads' },
      { key: 'facebook-ads', label: 'Facebook Ads' },
      { key: 'attribution', label: 'Attribution Report' },
      { key: 'call-reporting', label: 'Call Reporting' },
      { key: 'appointment-report', label: 'Appointment Report' },
    ],
  },
  { key: 'app-marketplace', label: 'App Marketplace', icon: LayoutGrid, group: 'grow' },
]

export const SETTINGS_SECTION: Section = { key: 'settings', label: 'Settings', icon: Settings, group: 'grow' }

/** GHL's Settings menu (a list down the left of the Settings page). */
export const SETTINGS_PAGES: SectionTab[] = [
  { key: 'business-profile', label: 'Business Profile' },
  { key: 'my-staff', label: 'My Staff' },
  { key: 'pipelines', label: 'Opportunities & Pipelines' },
  { key: 'automation', label: 'Automation' },
  { key: 'calendars', label: 'Calendars' },
  { key: 'email-services', label: 'Email Services' },
  { key: 'phone-numbers', label: 'Phone Numbers' },
  { key: 'whatsapp', label: 'WhatsApp' },
  { key: 'reputation', label: 'Reputation Management' },
  { key: 'custom-fields', label: 'Custom Fields' },
  { key: 'custom-values', label: 'Custom Values' },
  { key: 'scoring', label: 'Manage Scoring' },
  { key: 'domains', label: 'Domains & URL Redirects' },
  { key: 'integrations', label: 'Integrations' },
  { key: 'conversation-providers', label: 'Conversation Providers' },
  { key: 'tags', label: 'Tags' },
  { key: 'labs', label: 'Labs' },
  { key: 'audit-logs', label: 'Audit Logs' },
  { key: 'companies', label: 'Companies' },
  { key: 'brand-boards', label: 'Brand Boards' },
  { key: 'private-integrations', label: 'Private Integrations' },
  { key: 'import', label: 'GoHighLevel Import' },
]

export function sectionOf(key: string | undefined): Section | null {
  if (!key) return null
  if (key === 'settings') return SETTINGS_SECTION
  return SECTIONS.find((s) => s.key === key) ?? null
}

/** The tab a section opens on, from ?tab= (first tab when missing or unknown). */
export function activeTab(section: Section | null, tab: string | null): string | null {
  if (!section?.tabs?.length) return null
  return section.tabs.some((t) => t.key === tab) ? tab : section.tabs[0].key
}
