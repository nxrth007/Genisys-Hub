'use client'

import { useState } from 'react'
import type { HlField, HlFormSettings } from '@/lib/hl/types'

/**
 * The form a lead fills on the client's website (inside an iframe, or the
 * chat widget's panel). Plain styles on purpose: it sits on someone else's
 * site, light, in the client's colour, with the texting consent box carriers
 * look for when they review the number.
 */
export function PublicForm({
  formId,
  fields,
  settings,
  business,
  variant,
  pageUrl,
}: {
  formId: string
  fields: HlField[]
  settings: HlFormSettings
  business: string
  variant: 'form' | 'chat'
  pageUrl: string | null
}) {
  const color = settings.color || '#155EEF'
  const [values, setValues] = useState<Record<string, string>>({})
  const [consent, setConsent] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<{ text: string; field?: string } | null>(null)
  const [done, setDone] = useState<string | null>(null)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      const res = await fetch(`/api/hl/public/forms/${formId}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...values, sms_consent: consent, _page: pageUrl ?? document.referrer, _hp: (document.getElementById('hl-hp') as HTMLInputElement | null)?.value ?? '' }),
      })
      const data = (await res.json().catch(() => ({}))) as { error?: string; field?: string; thankYou?: string }
      if (!res.ok) setError({ text: data.error || 'Something went wrong. Please try again.', field: data.field })
      else setDone(data.thankYou || 'Thanks! We’ll be in touch shortly.')
    } catch {
      setError({ text: 'Couldn’t send. Check your connection and try again.' })
    } finally {
      setBusy(false)
    }
  }

  const input =
    'w-full rounded-lg border border-[#D0D5DD] bg-white px-3.5 py-2.5 text-[15px] text-[#101828] outline-none transition placeholder:text-[#98A2B3] focus:border-[var(--hl-c)] focus:ring-4 focus:ring-[color-mix(in_srgb,var(--hl-c)_15%,transparent)]'

  if (done) {
    return (
      <div className="flex min-h-[260px] flex-col items-center justify-center gap-3 px-6 py-10 text-center" style={{ ['--hl-c' as string]: color }}>
        <div className="grid h-12 w-12 place-items-center rounded-full text-white" style={{ background: color }}>
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M20 6 9 17l-5-5" />
          </svg>
        </div>
        <p className="max-w-sm text-[16px] font-medium text-[#101828]">{done}</p>
      </div>
    )
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-3.5" style={{ ['--hl-c' as string]: color }} noValidate>
      {settings.heading && <h2 className={variant === 'chat' ? 'text-[15px] font-medium text-[#344054]' : 'text-[20px] font-semibold text-[#101828]'}>{settings.heading}</h2>}
      {fields.map((f) => (
        <label key={f.key} className="flex flex-col gap-1.5">
          <span className="text-[13px] font-medium text-[#344054]">
            {f.label}
            {f.required && <span className="text-[#D92D20]"> *</span>}
          </span>
          {f.type === 'textarea' ? (
            <textarea
              rows={variant === 'chat' ? 3 : 4}
              className={input}
              placeholder={f.placeholder}
              value={values[f.key] ?? ''}
              onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
              aria-invalid={error?.field === f.key}
            />
          ) : f.type === 'select' ? (
            <select className={input} value={values[f.key] ?? ''} onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}>
              <option value="">Choose…</option>
              {(f.options ?? []).map((o) => (
                <option key={o} value={o}>
                  {o}
                </option>
              ))}
            </select>
          ) : (
            <input
              className={input}
              type={f.type === 'email' ? 'email' : f.type === 'phone' ? 'tel' : 'text'}
              inputMode={f.type === 'phone' ? 'tel' : undefined}
              autoComplete={f.type === 'phone' ? 'tel' : f.type === 'email' ? 'email' : f.key === 'full_name' ? 'name' : undefined}
              placeholder={f.placeholder}
              value={values[f.key] ?? ''}
              onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
              aria-invalid={error?.field === f.key}
            />
          )}
        </label>
      ))}
      <input id="hl-hp" name="_hp" tabIndex={-1} autoComplete="off" className="absolute -left-[9999px] h-0 w-0 opacity-0" aria-hidden />
      <label className="flex items-start gap-2.5 text-[12px] leading-snug text-[#475467]">
        <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} className="mt-0.5 h-4 w-4 shrink-0 accent-[var(--hl-c)]" />
        <span>{settings.consentText || `I agree to receive text messages from ${business} about my request. Msg & data rates may apply. Reply STOP to opt out.`}</span>
      </label>
      {error && <p className="rounded-lg bg-[#FEF3F2] px-3 py-2 text-[13px] text-[#B42318]">{error.text}</p>}
      <button
        type="submit"
        disabled={busy}
        className="mt-1 rounded-lg px-4 py-3 text-[15px] font-semibold text-white shadow-sm transition hover:brightness-110 disabled:opacity-60"
        style={{ background: color }}
      >
        {busy ? 'Sending…' : settings.submitLabel || 'Submit'}
      </button>
    </form>
  )
}
