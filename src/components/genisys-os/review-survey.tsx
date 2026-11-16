'use client'

import { useState } from 'react'

/**
 * The review survey, as the customer sees it: rate us, then choose. Whatever
 * they rated, they can leave a review on Google or tell the business
 * privately (Google's review policy: every customer is offered the review,
 * not only the happy ones). A low rating sees the feedback box first; a high
 * one sees the Google button first.
 */

const OPTIONS = [5, 4, 3, 2, 1].map((n) => ({ n, stars: '⭐'.repeat(n), label: `${n} Star${n === 1 ? '' : 's'}` }))

export function ReviewSurvey({
  formId,
  business,
  heading,
  thankYou,
  threshold,
  color,
  token,
}: {
  formId: string
  business: string
  heading: string
  thankYou: string
  threshold: number
  color: string
  token: string | null
}) {
  const [rating, setRating] = useState<number | null>(null)
  const [step, setStep] = useState<'rate' | 'choose' | 'done'>('rate')
  /** A happy customer opens the private note themselves; an unhappy one sees it straight away. */
  const [noteOpen, setNoteOpen] = useState(false)
  const [busy, setBusy] = useState<'google' | 'feedback' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [form, setForm] = useState({ full_name: '', email: '', your_feedback: '' })

  const send = async (action: 'google' | 'feedback') => {
    setBusy(action)
    setError(null)
    try {
      const r = await fetch(`/api/hl/public/surveys/${formId}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ rating, action, ...(action === 'feedback' ? form : {}), c: token }),
      })
      const j = (await r.json()) as { ok?: boolean; redirect?: string; error?: string }
      if (!r.ok || !j.ok) throw new Error(j.error || 'Something went wrong. Please try again.')
      if (j.redirect) {
        window.location.href = j.redirect
        return
      }
      setStep('done')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(null)
    }
  }

  const pick = (n: number) => {
    setRating(n)
    setNoteOpen(n < threshold)
    setError(null)
    setStep('choose')
  }

  const low = rating !== null && rating < threshold
  const input = 'w-full rounded-md border border-slate-300 bg-slate-50 px-4 py-3 text-[15px] text-slate-900 outline-none focus:border-slate-500'
  const title = step === 'done' ? 'Thank you!' : step === 'choose' ? (low ? 'We’re sorry to hear that' : 'Thank you!') : heading

  const google = (
    <div className="flex flex-col gap-2">
      {low && <p className="text-center text-[14px] text-slate-600">You can also share your experience publicly:</p>}
      <button
        type="button"
        disabled={busy !== null}
        onClick={() => void send('google')}
        className="rounded-md border px-4 py-3 text-[16px] font-semibold disabled:opacity-60"
        style={low ? { borderColor: '#94a3b8', color: '#0f172a', background: '#ffffff' } : { borderColor: color, background: color, color: '#ffffff' }}
      >
        {busy === 'google' ? 'Opening Google…' : 'Leave a review on Google'}
      </button>
    </div>
  )

  const note = noteOpen ? (
    <form
      className="flex flex-col gap-3"
      onSubmit={(e) => {
        e.preventDefault()
        void send('feedback')
      }}
    >
      <p className="text-[15px] text-slate-600">
        {low
          ? `Sorry to hear that you’re not satisfied. Tell ${business} what happened and we’ll do our best to make it right.`
          : `Anything you’d like ${business} to know? This goes to them only.`}
      </p>
      <input className={input} placeholder="Name (optional)" value={form.full_name} onChange={(e) => setForm({ ...form, full_name: e.target.value })} />
      <input className={input} type="email" placeholder="Email (optional)" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
      <textarea
        className={`${input} min-h-[120px]`}
        required
        placeholder={low ? 'Your feedback (what could we do better?)' : 'Your note'}
        value={form.your_feedback}
        onChange={(e) => setForm({ ...form, your_feedback: e.target.value })}
      />
      <button
        type="submit"
        disabled={busy !== null}
        className="rounded-md border px-4 py-3 text-[16px] font-semibold disabled:opacity-60"
        style={low ? { borderColor: color, background: color, color: '#ffffff' } : { borderColor: '#94a3b8', color: '#0f172a', background: '#ffffff' }}
      >
        {busy === 'feedback' ? 'Sending…' : `Send to ${business} privately`}
      </button>
    </form>
  ) : (
    <button type="button" onClick={() => setNoteOpen(true)} className="text-center text-[14px] text-slate-600 underline underline-offset-2">
      Or send {business} a private note instead
    </button>
  )

  return (
    <div className="flex flex-col gap-5 text-slate-900">
      <div className="text-center">
        <p className="text-[13px] font-medium uppercase tracking-wide text-slate-500">{business}</p>
        <h1 className="mt-1 text-[24px] font-semibold">{title}</h1>
      </div>

      {step === 'rate' && (
        <div className="flex flex-col gap-2.5">
          <p className="text-center text-[15px] text-slate-600">Rate Us</p>
          {OPTIONS.map((o) => (
            <button
              key={o.n}
              type="button"
              onClick={() => pick(o.n)}
              className="flex items-center justify-between rounded-lg border px-4 py-3 text-left text-[16px] transition hover:bg-slate-50"
              style={{ borderColor: rating === o.n ? color : '#cbd5e1' }}
            >
              <span>{o.stars}</span>
              <span className="text-[14px] text-slate-500">{o.label}</span>
            </button>
          ))}
        </div>
      )}

      {step === 'choose' && rating !== null && (
        <div className="flex flex-col gap-5">
          <p className="text-center text-[15px] text-slate-600">
            You rated us {'⭐'.repeat(rating)}.{' '}
            <button type="button" onClick={() => setStep('rate')} className="underline underline-offset-2">
              Change
            </button>
          </p>
          {!low && <p className="text-center text-[15px] text-slate-600">Would you share that on Google? It takes less than a minute and means a lot to a local business.</p>}
          {/* Both choices for every rating; only the order differs. */}
          {low ? (
            <>
              {note}
              {google}
            </>
          ) : (
            <>
              {google}
              {note}
            </>
          )}
        </div>
      )}

      {step === 'done' && <p className="text-center text-[15px] text-slate-600">{thankYou}</p>}
      {error && <p className="text-center text-[14px] text-red-600">{error}</p>}
    </div>
  )
}
