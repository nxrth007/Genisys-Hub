import { notFound } from 'next/navigation'
import { publicForm } from '@/lib/hl/forms'
import { PublicForm } from '@/components/hell-level/public-form'
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
  return (
    <div className="min-h-screen bg-white text-[#101828]" style={{ colorScheme: 'light' }}>
      <style>{'html,body{background:#fff!important;color-scheme:light}'}</style>
      <main className="mx-auto w-full max-w-xl px-5 py-6">
        <PublicForm formId={form.id} fields={form.fields} settings={form.settings} business={form.business} variant="form" pageUrl={page ?? null} />
        <p className="mt-5 text-center text-[11px] text-[#98A2B3]">
          <a href={`/hl/legal/${form.accountId}/privacy`} target="_blank" rel="noreferrer" className="underline">Privacy policy</a>
          {' · '}
          <a href={`/hl/legal/${form.accountId}/terms`} target="_blank" rel="noreferrer" className="underline">Texting terms</a>
        </p>
      </main>
      <FrameHeight formId={form.id} />
    </div>
  )
}
