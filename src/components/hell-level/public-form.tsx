'use client'

import { Fragment, useState } from 'react'
import { formStyle } from '@/lib/hl/form-style'
import type { HlConsentBox, HlField, HlFormSettings } from '@/lib/hl/types'

/** "Privacy Policy" and "Terms" in the consent wording become links. */
function Linked({ text, legal }: { text: string; legal: { privacy: string; terms: string } }) {
  const parts = text.split(/(Privacy Policy|Terms(?: of Service| and Conditions| & Conditions)?)/g)
  return (
    <>
      {parts.map((p, i) =>
        /^Privacy Policy$/.test(p) ? (
          <a key={i} href={legal.privacy} target="_blank" rel="noreferrer" className="underline">
            {p}
          </a>
        ) : /^Terms/.test(p) ? (
          <a key={i} href={legal.terms} target="_blank" rel="noreferrer" className="underline">
            {p}
          </a>
        ) : (
          <Fragment key={i}>{p}</Fragment>
        ),
      )}
    </>
  )
}

/**
 * The form a lead fills on the client's website (inside an iframe, or the
 * chat widget's panel). Light and plain unless the form sets its colours,
 * with the consent boxes carriers look for when they review the number:
 * unchecked, separate for promotions, linked to the policies.
 */
export function PublicForm({
  formId,
  fields,
  settings,
  legal,
  variant,
  pageUrl,
}: {
  formId: string
  fields: HlField[]
  settings: HlFormSettings & { consents: HlConsentBox[] }
  legal: { privacy: string; terms: string }
  variant: 'form' | 'chat'
  pageUrl: string | null
}) {
  const [values, setValues] = useState<Record<string, string>>({})
  const [ticked, setTicked] = useState<Record<string, boolean>>({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<{ text: string; field?: string } | null>(null)
  const [done, setDone] = useState<string | null>(null)
  const boxes = settings.consents
  const key = (c: HlConsentBox) => (c.kind === 'marketing' ? 'marketing_consent' : 'sms_consent')

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    const missing = boxes.find((c) => c.required && !ticked[key(c)])
    if (missing) {
      setError({ text: 'Please check the box to agree before sending.', field: key(missing) })
      return
    }
    setBusy(true)
    setError(null)
    try {
      const res = await fetch(`/api/hl/public/forms/${formId}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...values, ...Object.fromEntries(boxes.map((c) => [key(c), !!ticked[key(c)]])), _page: pageUrl ?? document.referrer, _hp: (document.getElementById('hl-hp') as HTMLInputElement | null)?.value ?? '' }),
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
    'w-full rounded-lg border border-[var(--hl-input-border)] bg-[var(--hl-input-bg)] px-3.5 py-2.5 text-[15px] text-[var(--hl-input-text)] outline-none transition placeholder:text-[color-mix(in_srgb,var(--hl-input-text)_45%,transparent)] focus:border-[var(--hl-c)] focus:ring-4 focus:ring-[color-mix(in_srgb,var(--hl-c)_15%,transparent)]'

  if (done) {
    return (
      <div className="flex min-h-[260px] flex-col items-center justify-center gap-3 px-6 py-10 text-center" style={formStyle(settings)}>
        <div className="grid h-12 w-12 place-items-center rounded-full bg-[var(--hl-c)] text-[var(--hl-btn-text)]">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M20 6 9 17l-5-5" />
          </svg>
        </div>
        <p className="max-w-sm text-[16px] font-medium text-[var(--hl-text)]">{done}</p>
      </div>
    )
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-3.5" style={formStyle(settings)} noValidate>
      {settings.heading && (
        <h2 className={variant === 'chat' ? 'text-[15px] font-medium text-[color-mix(in_srgb,var(--hl-text)_85%,transparent)]' : 'text-[20px] font-semibold text-[var(--hl-text)]'}>{settings.heading}</h2>
      )}
      {fields.map((f) => (
        <label key={f.key} className="flex flex-col gap-1.5">
          <span className="text-[13px] font-medium text-[color-mix(in_srgb,var(--hl-text)_85%,transparent)]">
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
      {boxes.map((c) => (
        <label key={c.kind} className="flex items-start gap-2.5 text-[12px] leading-snug text-[color-mix(in_srgb,var(--hl-text)_72%,transparent)]">
          <input
            type="checkbox"
            checked={!!ticked[key(c)]}
            onChange={(e) => setTicked((t) => ({ ...t, [key(c)]: e.target.checked }))}
            aria-invalid={error?.field === key(c)}
            className="mt-0.5 h-4 w-4 shrink-0 accent-[var(--hl-c)]"
          />
          <span>
            <Linked text={c.text} legal={legal} />
            {c.required && <span className="text-[#D92D20]"> *</span>}
          </span>
        </label>
      ))}
      {error && <p className="rounded-lg bg-[#FEF3F2] px-3 py-2 text-[13px] text-[#B42318]">{error.text}</p>}
      <button
        type="submit"
        disabled={busy}
        className="mt-1 rounded-lg bg-[var(--hl-c)] px-4 py-3 text-[15px] font-semibold text-[var(--hl-btn-text)] shadow-sm transition hover:brightness-110 disabled:opacity-60"
      >
        {busy ? 'Sending…' : settings.submitLabel || 'Submit'}
      </button>
    </form>
  )
}

/** The Privacy policy · Texting terms line under a form (off when the form hides it). */
export function LegalFooter({ settings, legal, short }: { settings: HlFormSettings; legal: { privacy: string; terms: string }; short?: boolean }) {
  if (settings.showLegalLinks === false) return null
  return (
    <p className="mt-5 text-center text-[11px] text-[color-mix(in_srgb,var(--hl-text)_55%,transparent)]" style={formStyle(settings)}>
      <a href={legal.privacy} target="_blank" rel="noreferrer" className="underline">
        {short ? 'Privacy' : 'Privacy policy'}
      </a>
      {' · '}
      <a href={legal.terms} target="_blank" rel="noreferrer" className="underline">
        Texting terms
      </a>
    </p>
  )
}
