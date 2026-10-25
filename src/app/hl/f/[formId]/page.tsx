import { notFound } from 'next/navigation'
import { publicForm } from '@/lib/hl/forms'
import { formBackground } from '@/lib/hl/form-style'
import { LegalFooter, PublicForm } from '@/components/hell-level/public-form'
import { FrameHeight } from '@/components/hell-level/frame-height'

export const dynamic = 'force-dynamic'

type Props = { params: Promise<{ formId: string }>; searchParams: Promise<{ page?: string }> }

export async function generateMetadata({ params }: Props) {
  const form = await publicForm((await params).formId)
  return { title: form ? `${form.settings.heading || form.name} | ${form.business}` : 'Form', robots: { index: false } }
}

/** A Hell-level form as embedded on a client's website (iframe), or opened on its own. */
export default async function HostedFormPage({ params, searchParams }: Props) {
  const { formId } = await params
  const form = await publicForm(formId)
  if (!form) notFound()
  const { page } = await searchParams
  const background = formBackground(form.settings)
  return (
    <div data-hl-frame className="min-h-screen" style={{ colorScheme: 'light', background }}>
      <style>{`html,body{background:${background}!important;color-scheme:light}`}</style>
      <main className="mx-auto w-full max-w-xl px-5 py-6">
        <PublicForm formId={form.id} fields={form.fields} settings={form.settings} legal={form.legal} variant="form" pageUrl={page ?? null} logo={form.logo} business={form.business} />
        <LegalFooter settings={form.settings} legal={form.legal} />
      </main>
      <FrameHeight formId={form.id} />
    </div>
  )
}
