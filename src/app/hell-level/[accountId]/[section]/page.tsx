'use client'

import { Suspense } from 'react'
import { notFound, useParams } from 'next/navigation'
import { NotYet, useSectionTab } from '@/components/hell-level/section'
import { sectionOf } from '@/components/hell-level/nav'
import { Spinner } from '@/components/hell-level/ui'

/**
 * GoHighLevel sections Hell-level has the place for but not the feature yet:
 * the menu item and tabs match GHL, and the page says what it is.
 */
const PAGES: Record<string, Record<string, { title: string; what: string }>> = {
  'ask-ai': { '': { title: 'Ask AI', what: 'Ask questions about the sub-account in plain English (“who hasn’t been called back?”) and get answers from its contacts, conversations and pipeline.' } },
  'ai-studio': { '': { title: 'AI Studio', what: 'GHL’s beta space for building AI tools on the sub-account’s data.' } },
  'ai-agents': {
    'getting-started': { title: 'AI Agents', what: 'AI that answers calls, texts and chats for the business.' },
    'voice-ai': { title: 'Voice AI', what: 'An AI receptionist that answers the phone, books appointments and takes messages.' },
    'conversation-ai': { title: 'Conversation AI', what: 'An AI that replies to texts and chats in the business’s voice.' },
    'knowledge-base': { title: 'Knowledge Base', what: 'What the AI agents know about the business: services, prices, FAQs.' },
    'agent-templates': { title: 'Agent Templates', what: 'Ready-made AI agents for common jobs.' },
    'content-ai': { title: 'Content AI', what: 'AI writing for emails, posts and pages.' },
  },
  memberships: {
    dashboard: { title: 'Memberships', what: 'Online courses and communities. GHL’s API doesn’t export courses, so nothing comes over from GHL here.' },
    courses: { title: 'Courses', what: 'Video courses with lessons and drip schedules.' },
    communities: { title: 'Communities', what: 'Member groups with posts and chat.' },
    certificates: { title: 'Certificates', what: 'Certificates for finishing a course.' },
    'client-portal': { title: 'Client Portal', what: 'One login for the business’s customers to reach courses and communities.' },
  },
  'app-marketplace': { '': { title: 'App Marketplace', what: 'Third-party apps for GHL sub-accounts. Hell-level’s integrations live under Settings → Integrations.' } },
}

export default function SectionPage() {
  return (
    <Suspense fallback={<div className="flex justify-center py-24"><Spinner /></div>}>
      <Section />
    </Suspense>
  )
}

function Section() {
  const { section } = useParams<{ section: string }>()
  const tab = useSectionTab(section)
  const pages = PAGES[section]
  if (!pages || !sectionOf(section)) notFound()
  const page = pages[tab] ?? pages[''] ?? Object.values(pages)[0]
  return <NotYet title={page.title} what={page.what} />
}
