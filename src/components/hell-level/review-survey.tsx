'use client'

import { useState } from 'react'

/**
 * GHL's "Review Survey", as the customer sees it: rate us, then either off to
 * Google to leave a review (a high rating) or a short feedback form (a low one).
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
  const [step, setStep] = useState<'rate' | 'feedback' | 'done'>('rate')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [form, setForm] = useState({ full_name: '', email: '', your_feedback: '' })

  const send = async (body: Record<string, unknown>) => {
    setBusy(true)
    setError(null)
    try {
      const r = await fetch(`/api/hl/public/surveys/${formId}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...body, c: token }) })
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
      setBusy(false)
    }
  }

  const pick = (n: number) => {
    setRating(n)
    if (n >= threshold) void send({ rating: n })
    else setStep('feedback')
  }

  const input = 'w-full rounded-md border border-slate-300 bg-slate-50 px-4 py-3 text-[15px] text-slate-900 outline-none focus:border-slate-500'
  return (
    <div className="flex flex-col gap-5 text-slate-900">
      <div className="text-center">
        <p className="text-[13px] font-medium uppercase tracking-wide text-slate-500">{business}</p>
        <h1 className="mt-1 text-[24px] font-semibold">{step === 'feedback' ? 'We’re sorry to hear that' : step === 'done' ? 'Thank you!' : heading}</h1>
      </div>

      {step === 'rate' && (
        <div className="flex flex-col gap-2.5">
          <p className="text-center text-[15px] text-slate-600">Rate Us</p>
          {OPTIONS.map((o) => (
            <button
              key={o.n}
              type="button"
              disabled={busy}
              onClick={() => pick(o.n)}
              className="flex items-center justify-between rounded-lg border px-4 py-3 text-left text-[16px] transition hover:bg-slate-50 disabled:opacity-60"
              style={{ borderColor: rating === o.n ? color : '#cbd5e1' }}
            >
              <span>{o.stars}</span>
              <span className="text-[14px] text-slate-500">{o.label}</span>
            </button>
          ))}
        </div>
      )}

      {step === 'feedback' && (
        <form
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault()
            void send({ rating, ...form })
          }}
        >
          <p className="text-[15px] text-slate-600">Sorry to hear that you&apos;re not satisfied. Please provide us with your feedback and we&apos;ll do our best to improve.</p>
          <input className={input} placeholder="Name (optional)" value={form.full_name} onChange={(e) => setForm({ ...form, full_name: e.target.value })} />
          <input className={input} type="email" placeholder="Email (optional)" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
          <textarea
            className={`${input} min-h-[120px]`}
            required
            placeholder="Your Feedback (Please let us know what can we do to improve?)"
            value={form.your_feedback}
            onChange={(e) => setForm({ ...form, your_feedback: e.target.value })}
          />
          <button type="submit" disabled={busy} className="rounded-md px-4 py-3 text-[16px] font-semibold text-white disabled:opacity-60" style={{ background: color }}>
            {busy ? 'Sending…' : 'Send feedback'}
          </button>
        </form>
      )}

      {step === 'done' && <p className="text-center text-[15px] text-slate-600">{thankYou}</p>}
      {error && <p className="text-center text-[14px] text-red-600">{error}</p>}
    </div>
  )
}
