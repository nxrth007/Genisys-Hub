import { notFound } from 'next/navigation'
import { publicForm } from '@/lib/hl/forms'
import { formBackground, formStyle } from '@/lib/hl/form-style'
import { ChatClose, LegalFooter, PublicForm } from '@/components/hell-level/public-form'

export const dynamic = 'force-dynamic'

type Props = { params: Promise<{ formId: string }>; searchParams: Promise<{ page?: string }> }

export const metadata = { title: 'Chat with us', robots: { index: false } }

/** The panel inside the chat bubble (/hl/widget.js) on a client's website. */
export default async function ChatPanelPage({ params, searchParams }: Props) {
  const { formId } = await params
  const form = await publicForm(formId)
  if (!form) notFound()
  const { page } = await searchParams
  const initial = form.business.trim().charAt(0).toUpperCase() || 'G'
  // A panel can't see through to the page, so "transparent" stays white here.
  const background = form.settings.background === 'transparent' ? '#FFFFFF' : formBackground(form.settings)
  return (
    <div className="flex h-screen flex-col" style={{ colorScheme: 'light', background, ...formStyle(form.settings) }}>
      <style>{`html,body{background:${background}!important;color-scheme:light}`}</style>
      <header className="flex items-center gap-3 bg-[var(--hl-c)] px-5 py-4 text-[var(--hl-btn-text)]">
        {form.logo ? (
          // eslint-disable-next-line @next/next/no-img-element -- the client's own logo, from their website
          <img src={form.logo} alt={`${form.business} logo`} className="h-10 w-10 shrink-0 rounded-full bg-white object-contain p-0.5" />
        ) : (
          <span className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-white/20 text-[16px] font-semibold">{initial}</span>
        )}
        <div className="min-w-0">
          <p className="truncate text-[15px] font-semibold">{form.business}</p>
          <p className="text-[12px] opacity-80">We usually reply in a few minutes</p>
        </div>
        <ChatClose />
      </header>
      <main className="flex-1 overflow-y-auto px-5 py-5">
        <PublicForm formId={form.id} fields={form.fields} settings={form.settings} legal={form.legal} variant="chat" pageUrl={page ?? null} />
        <LegalFooter settings={form.settings} legal={form.legal} short />
      </main>
    </div>
  )
}
