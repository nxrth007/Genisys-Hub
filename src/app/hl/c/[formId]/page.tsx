import { headers } from 'next/headers'
import { notFound } from 'next/navigation'
import { publicForm } from '@/lib/hl/forms'
import { ChatPanel } from '@/components/hell-level/chat-panel'

export const dynamic = 'force-dynamic'

type Props = { params: Promise<{ formId: string }>; searchParams: Promise<{ page?: string }> }

export const metadata = { title: 'Chat with us', robots: { index: false } }

/**
 * The panel inside the chat bubble (/hl/widget.js) on a client's website. Its
 * privacy and terms links follow the site the browser says it's on (the
 * frame's Referer, not ?page=, which anyone can type).
 */
export default async function ChatPanelPage({ params, searchParams }: Props) {
  const { formId } = await params
  const form = await publicForm(formId, (await headers()).get('referer'))
  if (!form) notFound()
  const { page } = await searchParams
  return (
    <>
      <style>{'html,body{margin:0;background:#F4F5F7!important;color-scheme:light}'}</style>
      <ChatPanel formId={form.id} business={form.business} logo={form.logo} fields={form.fields} settings={form.settings} legal={form.legal} pageUrl={page ?? null} />
    </>
  )
}
