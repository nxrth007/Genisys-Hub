import { notFound } from 'next/navigation'
import { publicSurvey } from '@/lib/hl/review-survey'
import { ReviewSurvey } from '@/components/hell-level/review-survey'

export const dynamic = 'force-dynamic'

type Props = { params: Promise<{ formId: string }>; searchParams: Promise<{ c?: string }> }

export async function generateMetadata({ params }: Props) {
  const survey = await publicSurvey((await params).formId)
  return { title: survey ? `Rate ${survey.business}` : 'Survey', robots: { index: false } }
}

/** The review survey a review-request text links to (through the tracked link, so the contact is known). */
export default async function ReviewSurveyPage({ params, searchParams }: Props) {
  const survey = await publicSurvey((await params).formId)
  if (!survey) notFound()
  const { c } = await searchParams
  return (
    <div className="min-h-screen bg-white" style={{ colorScheme: 'light' }}>
      <style>{'html,body{background:#ffffff!important;color-scheme:light}'}</style>
      <main className="mx-auto w-full max-w-md px-5 py-10">
        <ReviewSurvey formId={survey.id} business={survey.business} heading={survey.heading} thankYou={survey.thankYou} threshold={survey.threshold} color={survey.color} token={c ?? null} />
      </main>
    </div>
  )
}
