'use client'

import { useEffect, useRef, useState } from 'react'
import { inkOn, shade } from '@/lib/hl/color'
import type { HlConsentBox, HlField, HlFormSettings } from '@/lib/hl/types'
import { Linked } from './public-form'

/**
 * The chat widget's panel, inside the bubble on a client's website: a
 * conversation more than a form, as GHL's widget is. The business greets the
 * visitor, the form sits in a card under the greeting, and once it's sent
 * their message shows as sent, followed by the business's reply after a
 * short "typing" pause. All in the business's colour, with its logo. Send
 * stays at the bottom, in view however long the form is, as in a chat app.
 *
 * What carriers check stays as on every Hell-level form: the consent boxes
 * start unchecked, promotions have their own box, and both link to the
 * business's privacy policy and terms.
 */

type Props = {
  formId: string
  business: string
  logo: string | null
  fields: HlField[]
  settings: HlFormSettings & { consents: HlConsentBox[] }
  legal: { privacy: string; terms: string }
  pageUrl: string | null
}

const STYLE = `
@keyframes hlIn { from { opacity: 0; transform: translateY(8px) } to { opacity: 1; transform: none } }
@keyframes hlDot { 0%, 80%, 100% { opacity: .3; transform: translateY(0) } 40% { opacity: 1; transform: translateY(-3px) } }
@keyframes hlPulse { 0% { box-shadow: 0 0 0 0 rgba(18,183,106,.55) } 70% { box-shadow: 0 0 0 6px rgba(18,183,106,0) } 100% { box-shadow: 0 0 0 0 rgba(18,183,106,0) } }
.hl-in { animation: hlIn .36s cubic-bezier(.2,.8,.2,1) both }
.hl-dot { animation: hlDot 1.2s infinite ease-in-out }
.hl-pulse { animation: hlPulse 2.4s infinite }
@media (pointer: coarse) { .hl-field { font-size: 16px !important } }
@media (prefers-reduced-motion: reduce) { .hl-in, .hl-dot, .hl-pulse { animation: none !important } }
`

const pretty = (raw: string) => {
  const d = raw.replace(/\D/g, '').replace(/^1(?=\d{10}$)/, '')
  return d.length === 10 ? `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}` : raw
}

/** A US number as it's typed: 631, (631) 555, (631) 555-0142. Pasted +1s are dropped. */
const typing = (raw: string) => {
  const d = raw.replace(/\D/g, '').replace(/^1(?=\d{10})/, '').slice(0, 10)
  if (d.length <= 3) return d
  if (d.length <= 6) return `(${d.slice(0, 3)}) ${d.slice(3)}`
  return `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`
}

function Avatar({ logo, business, size, color }: { logo: string | null; business: string; size: number; color: string }) {
  const initial = business.trim().charAt(0).toUpperCase() || '•'
  return logo ? (
    // eslint-disable-next-line @next/next/no-img-element -- the client's own logo, from their website
    <img src={logo} alt="" width={size} height={size} className="shrink-0 rounded-full bg-white object-contain" style={{ width: size, height: size, padding: size > 36 ? 3 : 2 }} />
  ) : (
    <span className="grid shrink-0 place-items-center rounded-full font-semibold" style={{ width: size, height: size, background: color, color: inkOn(color), fontSize: size * 0.42 }}>
      {initial}
    </span>
  )
}

/** The US flag, drawn (Windows shows the flag emoji as the letters "US"). */
function UsFlag() {
  return (
    <span className="block shrink-0 overflow-hidden rounded-[3px] shadow-[0_0_0_1px_rgba(16,24,40,.1)]">
      <svg width="20" height="14" viewBox="0 0 20 14" className="block">
        <rect width="20" height="14" fill="#fff" />
        {[0, 1, 2, 3, 4, 5, 6].map((i) => (
          <rect key={i} y={(i * 28) / 13} width="20" height={14 / 13} fill="#B22234" />
        ))}
        <rect width="8" height={98 / 13} fill="#3C3B6E" />
        {[0, 1, 2].map((r) => [0, 1, 2].map((c) => <circle key={`${r}${c}`} cx={1.5 + c * 2.5} cy={1.4 + r * 2.4} r=".5" fill="#fff" />))}
      </svg>
    </span>
  )
}

/** A message from the business; the second of two hugs the first, as chat apps group them. */
function Bubble({ children, delay = 0, follows = false }: { children: React.ReactNode; delay?: number; follows?: boolean }) {
  return (
    <div
      className={`hl-in max-w-[86%] rounded-[18px] rounded-bl-[6px] border border-[#EEF0F3] bg-white px-3.5 py-2.5 text-[14.5px] leading-[1.45] text-[#1D2939] shadow-[0_1px_2px_rgba(16,24,40,.06)] ${follows ? 'rounded-tl-[6px]' : ''}`}
      style={{ animationDelay: `${delay}ms` }}
    >
      {children}
    </div>
  )
}

export function ChatPanel({ formId, business, logo, fields, settings, legal, pageUrl }: Props) {
  const color = settings.color && /^#[0-9a-f]{6}$/i.test(settings.color) ? settings.color : '#155EEF'
  const ink = inkOn(color)
  const light = ink === '#FFFFFF'
  const [values, setValues] = useState<Record<string, string>>({})
  const [ticked, setTicked] = useState<Record<string, boolean>>({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<{ text: string; field?: string } | null>(null)
  const [sent, setSent] = useState<{ text: string; phone: string | null } | null>(null)
  const [reply, setReply] = useState<string | null>(null)
  const end = useRef<HTMLDivElement>(null)
  const boxes = settings.consents
  const key = (c: HlConsentBox) => (c.kind === 'marketing' ? 'marketing_consent' : 'sms_consent')
  const phoneKey = fields.find((f) => f.type === 'phone')?.key

  // The newest message in view.
  useEffect(() => {
    if (sent) end.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })
  }, [sent, reply])

  // Fixing what was flagged clears the flag.
  const set = (k: string, v: string) => {
    setValues((x) => ({ ...x, [k]: v }))
    if (error?.field === k) setError(null)
  }
  const tick = (k: string, v: boolean) => {
    setTicked((x) => ({ ...x, [k]: v }))
    if (error?.field === k) setError(null)
  }

  // The message shows by the Send button; the field it's about scrolls into view, ready to type in.
  function flag(text: string, field?: string) {
    setError({ text, field })
    if (!field) return
    requestAnimationFrame(() => {
      const el = document.querySelector<HTMLElement>(`[data-field="${field}"]`)
      el?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
      el?.focus({ preventScroll: true })
    })
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    const blank = fields.find((f) => f.required && !values[f.key]?.trim())
    if (blank) return flag(`Please add your ${blank.label.replace(/\?$/, '').toLowerCase()}.`, blank.key)
    const missing = boxes.find((c) => c.required && !ticked[key(c)])
    if (missing) return flag('Please check the box to agree before sending.', key(missing))
    setBusy(true)
    setError(null)
    try {
      const res = await fetch(`/api/hl/public/forms/${formId}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...values, ...Object.fromEntries(boxes.map((c) => [key(c), !!ticked[key(c)]])), _page: pageUrl ?? document.referrer, _hp: (document.getElementById('hl-hp') as HTMLInputElement | null)?.value ?? '' }),
      })
      const data = (await res.json().catch(() => ({}))) as { error?: string; field?: string; thankYou?: string }
      if (!res.ok) return flag(data.error || 'Something went wrong. Please try again.', data.field)
      const message = fields.find((f) => f.type === 'textarea' && values[f.key]?.trim())
      const name = values.full_name || values.first_name || ''
      setSent({ text: message ? values[message.key].trim() : `Hi, I'm ${name || 'interested'}.`, phone: phoneKey && values[phoneKey] ? pretty(values[phoneKey]) : null })
      // A moment of "typing" before the reply, as a person would.
      setTimeout(() => setReply(data.thankYou || settings.thankYou || 'Thanks! We’ll text you back shortly.'), 1100)
    } catch {
      flag('Couldn’t send. Check your connection and try again.')
    } finally {
      setBusy(false)
    }
  }

  const field =
    'hl-field w-full rounded-xl border border-[#E4E7EC] bg-[#FCFCFD] px-3.5 text-[14.5px] text-[#101828] outline-none transition placeholder:text-[#98A2B3] focus:border-[var(--hl-c)] focus:bg-white focus:ring-4 focus:ring-[color-mix(in_srgb,var(--hl-c)_14%,transparent)] aria-[invalid=true]:border-[#FDA29B] aria-[invalid=true]:ring-4 aria-[invalid=true]:ring-[#FEE4E2]'
  const intro = settings.heading?.trim() || 'Hi there! Have a question?'
  const second = 'Leave your name and number below and we’ll text you right back.'

  return (
    <div className="flex h-[100dvh] flex-col bg-[#F4F5F7] font-sans antialiased" style={{ ['--hl-c' as string]: color, colorScheme: 'light' }}>
      <style>{STYLE}</style>
      <header
        className="relative shrink-0 overflow-hidden px-4 pb-7 pt-4"
        style={{ background: `linear-gradient(135deg, ${shade(color, 0.14)} 0%, ${color} 46%, ${shade(color, -0.16)} 100%)`, color: ink, textShadow: light ? '0 1px 2px rgba(16,24,40,.18)' : 'none' }}
      >
        <span aria-hidden className="pointer-events-none absolute -right-10 -top-16 h-44 w-44 rounded-full bg-white/[.13]" />
        <span aria-hidden className="pointer-events-none absolute -bottom-20 right-20 h-32 w-32 rounded-full bg-white/[.08]" />
        {/* The conversation's rounded top edge, over the colour. */}
        <span aria-hidden className="pointer-events-none absolute inset-x-0 -bottom-px h-[13px] rounded-t-[18px] bg-[#F4F5F7]" />
        <div className="relative flex items-center gap-3">
          <span className="rounded-full bg-white/60 p-[2px] shadow-[0_2px_10px_rgba(16,24,40,.2)]">
            <Avatar logo={logo} business={business} size={44} color={shade(color, -0.25)} />
          </span>
          <div className="min-w-0 flex-1">
            <p className="truncate text-[16px] font-semibold leading-tight tracking-[-0.01em]">{business}</p>
            <p className="mt-1 flex items-center gap-1.5 text-[12.5px] opacity-90">
              <span className="hl-pulse inline-block h-2 w-2 rounded-full bg-[#12B76A] ring-2 ring-white/70" />
              Typically replies in minutes
            </p>
          </div>
          <button
            type="button"
            aria-label="Minimize chat"
            onClick={() => window.parent.postMessage({ hlChat: 'close' }, '*')}
            className="grid h-9 w-9 shrink-0 place-items-center rounded-full transition hover:bg-black/10"
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <path d="m6 9 6 6 6-6" />
            </svg>
          </button>
        </div>
      </header>

      <main className="flex-1 overflow-y-auto px-3.5 pb-4 pt-1">
        <div className="flex items-end gap-2">
          <Avatar logo={logo} business={business} size={30} color={color} />
          <div className="flex min-w-0 flex-1 flex-col items-start gap-1">
            <Bubble>{intro}</Bubble>
            {!sent && (
              <Bubble delay={160} follows>
                {second}
              </Bubble>
            )}
          </div>
        </div>

        {!sent ? (
          <form id="hl-chat" onSubmit={submit} noValidate className="hl-in mt-3.5 flex flex-col gap-2.5 rounded-[18px] border border-[#EAECF0] bg-white p-3 shadow-[0_1px_3px_rgba(16,24,40,.06)]" style={{ animationDelay: '280ms' }}>
            {fields.map((f) =>
              f.type === 'phone' ? (
                <div
                  key={f.key}
                  aria-invalid={error?.field === f.key}
                  className="flex h-11 items-center rounded-xl border border-[#E4E7EC] bg-[#FCFCFD] transition focus-within:border-[var(--hl-c)] focus-within:bg-white focus-within:ring-4 focus-within:ring-[color-mix(in_srgb,var(--hl-c)_14%,transparent)] aria-[invalid=true]:border-[#FDA29B] aria-[invalid=true]:ring-4 aria-[invalid=true]:ring-[#FEE4E2]"
                >
                  <span className="flex items-center gap-1.5 border-r border-[#EAECF0] pl-3 pr-2.5 text-[14px] text-[#475467]" aria-hidden>
                    <UsFlag />
                    +1
                  </span>
                  <input
                    type="tel"
                    inputMode="tel"
                    autoComplete="tel-national"
                    data-field={f.key}
                    aria-label={f.label}
                    placeholder={`${f.label}${f.required ? ' *' : ''}`}
                    value={values[f.key] ?? ''}
                    onChange={(e) => set(f.key, typing(e.target.value))}
                    className="hl-field h-full min-w-0 flex-1 bg-transparent px-3 text-[14.5px] text-[#101828] outline-none placeholder:text-[#98A2B3]"
                  />
                </div>
              ) : f.type === 'textarea' ? (
                <textarea
                  key={f.key}
                  rows={3}
                  data-field={f.key}
                  aria-label={f.label}
                  placeholder={`${f.placeholder || f.label}${f.required ? ' *' : ''}`}
                  value={values[f.key] ?? ''}
                  onChange={(e) => set(f.key, e.target.value)}
                  aria-invalid={error?.field === f.key}
                  className={`${field} min-h-[80px] resize-none py-2.5`}
                />
              ) : f.type === 'select' ? (
                <select key={f.key} data-field={f.key} aria-label={f.label} value={values[f.key] ?? ''} onChange={(e) => set(f.key, e.target.value)} aria-invalid={error?.field === f.key} className={`${field} h-11`}>
                  <option value="">{f.label}…</option>
                  {(f.options ?? []).map((o) => (
                    <option key={o} value={o}>
                      {o}
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  key={f.key}
                  type={f.type === 'email' ? 'email' : 'text'}
                  autoComplete={f.type === 'email' ? 'email' : f.key === 'full_name' ? 'name' : undefined}
                  data-field={f.key}
                  aria-label={f.label}
                  placeholder={`${f.placeholder || f.label}${f.required ? ' *' : ''}`}
                  value={values[f.key] ?? ''}
                  onChange={(e) => set(f.key, e.target.value)}
                  aria-invalid={error?.field === f.key}
                  className={`${field} h-11`}
                />
              ),
            )}
            <input id="hl-hp" name="_hp" tabIndex={-1} autoComplete="off" className="absolute -left-[9999px] h-0 w-0 opacity-0" aria-hidden />
            {boxes.length > 0 && (
              <div className="mt-0.5 flex flex-col gap-2.5 border-t border-[#F2F4F7] px-0.5 pt-3">
                {boxes.map((c) => (
                  <label key={c.kind} className="flex cursor-pointer items-start gap-2.5 text-[11px] leading-[1.5] text-[#667085]">
                    <input
                      type="checkbox"
                      data-field={key(c)}
                      checked={!!ticked[key(c)]}
                      onChange={(e) => tick(key(c), e.target.checked)}
                      aria-invalid={error?.field === key(c)}
                      className="mt-[1px] h-4 w-4 shrink-0 cursor-pointer rounded accent-[var(--hl-c)] aria-[invalid=true]:outline-2 aria-[invalid=true]:outline-offset-1 aria-[invalid=true]:outline-[#F04438]"
                    />
                    <span className="[&_a]:text-[#475467]">
                      <Linked text={c.text} legal={legal} />
                      {c.required && <span className="text-[#D92D20]"> *</span>}
                    </span>
                  </label>
                ))}
              </div>
            )}
          </form>
        ) : (
          <div className="mt-4 flex flex-col gap-3">
            <div className="hl-in flex flex-col items-end gap-1">
              <div className="max-w-[82%] whitespace-pre-line rounded-[18px] rounded-br-[6px] px-3.5 py-2.5 text-[14.5px] leading-[1.45] shadow-[0_1px_2px_rgba(16,24,40,.08)]" style={{ background: `linear-gradient(135deg, ${shade(color, 0.08)}, ${color})`, color: ink }}>
                {sent.text}
              </div>
              <span className="mr-1 flex items-center gap-1 text-[11px] text-[#98A2B3]">
                Sent
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M20 6 9 17l-5-5" />
                </svg>
              </span>
            </div>
            <div className="flex items-end gap-2">
              <Avatar logo={logo} business={business} size={30} color={color} />
              {reply ? (
                <div className="flex min-w-0 flex-1 flex-col items-start gap-1">
                  <Bubble>{reply}</Bubble>
                  {sent.phone && (
                    <Bubble delay={220} follows>
                      We’ll text you at <span className="font-semibold">{sent.phone}</span>.
                    </Bubble>
                  )}
                </div>
              ) : (
                <div className="hl-in flex items-center gap-1 rounded-[18px] rounded-bl-[6px] border border-[#EEF0F3] bg-white px-4 py-3.5 shadow-[0_1px_2px_rgba(16,24,40,.06)]" aria-label="Typing">
                  {[0, 1, 2].map((i) => (
                    <span key={i} className="hl-dot h-2 w-2 rounded-full bg-[#98A2B3]" style={{ animationDelay: `${i * 0.16}s` }} />
                  ))}
                </div>
              )}
            </div>
          </div>
        )}
        <div ref={end} />
      </main>

      <footer className={`relative z-10 shrink-0 border-t border-[#EEF0F3] bg-white px-3.5 ${sent ? 'py-2.5' : 'pb-2.5 pt-3'}`}>
        {!sent && (
          <>
            {error && (
              <p role="alert" className="hl-in mb-2 flex items-center gap-2 rounded-lg bg-[#FEF3F2] px-3 py-2 text-[12.5px] text-[#B42318]">
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0">
                  <circle cx="12" cy="12" r="10" />
                  <path d="M12 8v4M12 16h.01" />
                </svg>
                {error.text}
              </p>
            )}
            <button
              type="submit"
              form="hl-chat"
              disabled={busy}
              className="flex h-11 w-full items-center justify-center gap-2 rounded-xl text-[15px] font-semibold transition hover:brightness-[1.06] active:scale-[.99] disabled:opacity-70"
              style={{ background: `linear-gradient(135deg, ${shade(color, 0.1)}, ${color} 60%, ${shade(color, -0.06)})`, color: ink, boxShadow: `0 8px 18px -8px ${color}, inset 0 1px 0 rgba(255,255,255,.22)` }}
            >
              {busy ? (
                <svg className="animate-spin" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round">
                  <path d="M21 12a9 9 0 1 1-6.2-8.6" />
                </svg>
              ) : (
                <>
                  {settings.submitLabel || 'Send'}
                  <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M22 2 11 13" />
                    <path d="M22 2 15 22l-4-9-9-4 20-7z" />
                  </svg>
                </>
              )}
            </button>
          </>
        )}
        <p className={`flex items-center justify-center gap-1.5 text-[11px] text-[#98A2B3] ${sent ? '' : 'mt-2'}`}>
          {settings.showLegalLinks !== false && (
            <>
              <a href={legal.privacy} target="_blank" rel="noreferrer" className="hover:text-[#667085] hover:underline">
                Privacy
              </a>
              <span aria-hidden>·</span>
              <a href={legal.terms} target="_blank" rel="noreferrer" className="hover:text-[#667085] hover:underline">
                Texting terms
              </a>
              <span aria-hidden>·</span>
            </>
          )}
          <span>
            Powered by{' '}
            <a href="https://leadgenisys.com" target="_blank" rel="noreferrer" className="font-medium text-[#667085] hover:underline">
              Genisys
            </a>
          </span>
        </p>
      </footer>
    </div>
  )
}
