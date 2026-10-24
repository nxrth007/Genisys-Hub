import { notFound } from 'next/navigation'
import { publicForm } from '@/lib/hl/forms'
import { PublicForm } from '@/components/hell-level/public-form'

export const dynamic = 'force-dynamic'

type Props = { params: Promise<{ formId: string }>; searchParams: Promise<{ page?: string }> }

export const metadata = { title: 'Chat with us', robots: { index: false } }

/** The panel inside the chat bubble (/hl/widget.js) on a client's website. */
export default async function ChatPanelPage({ params, searchParams }: Props) {
  const { formId } = await params
  const form = await publicForm(formId)
  if (!form) notFound()
  const { page } = await searchParams
  const color = form.settings.color || '#155EEF'
  const initial = form.business.trim().charAt(0).toUpperCase() || 'G'
  return (
    <div className="flex h-screen flex-col bg-white text-[#101828]" style={{ colorScheme: 'light' }}>
      <style>{'html,body{background:#fff!important;color-scheme:light}'}</style>
      <header className="flex items-center gap-3 px-5 py-4 text-white" style={{ background: color }}>
        <span className="grid h-10 w-10 place-items-center rounded-full bg-white/20 text-[16px] font-semibold">{initial}</span>
        <div className="min-w-0">
          <p className="truncate text-[15px] font-semibold">{form.business}</p>
          <p className="text-[12px] text-white/80">We usually reply in a few minutes</p>
        </div>
      </header>
      <main className="flex-1 overflow-y-auto px-5 py-5">
        <PublicForm formId={form.id} fields={form.fields} settings={form.settings} business={form.business} variant="chat" pageUrl={page ?? null} />
        <p className="mt-4 text-center text-[11px] text-[#98A2B3]">
          <a href={`/hl/legal/${form.accountId}/privacy`} target="_blank" rel="noreferrer" className="underline">Privacy</a>
          {' · '}
          <a href={`/hl/legal/${form.accountId}/terms`} target="_blank" rel="noreferrer" className="underline">Texting terms</a>
        </p>
      </main>
    </div>
  )
}
