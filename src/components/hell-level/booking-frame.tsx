import { inkOn, shade } from '@/lib/hl/color'
import { BrandAvatar } from './brand-bits'

/**
 * The frame every client-facing calendar page shares (a calendar's booking
 * page, a group's, a service menu's, the reschedule/cancel link): a card with
 * the business's logo and name on a band of its brand colour, as the chat
 * widget has, the page's own content below, and the legal links and
 * "Powered by Genisys" under it. Hosted, the card sits on a soft grey page;
 * embedded on the client's site (in an iframe), the page around it turns
 * transparent so the card sits on their section.
 */

export const BOOKING_CSS = `
html,html.dark,body{background:#F2F4F7!important;color-scheme:light!important}
html.hl-embed,html.hl-embed body{background:transparent!important}
html.hl-embed .hl-page{background:transparent;padding:4px 4px 0;min-height:0}
html.hl-embed .hl-card{border-radius:20px;border:1px solid #E4E7EC;box-shadow:0 1px 3px rgba(16,24,40,.08)}
html.hl-embed .hl-legal{padding-bottom:6px}
@keyframes hlIn{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}
@keyframes hlPop{0%{opacity:0;transform:scale(.6)}60%{opacity:1;transform:scale(1.08)}100%{transform:scale(1)}}
@keyframes hlRing{0%{box-shadow:0 0 0 0 var(--hl-ring)}100%{box-shadow:0 0 0 18px transparent}}
@keyframes hlShimmer{0%{background-position:-240px 0}100%{background-position:240px 0}}
.hl-in{animation:hlIn .34s cubic-bezier(.2,.8,.2,1) both}
.hl-pop{animation:hlPop .5s cubic-bezier(.2,.8,.2,1) both,hlRing 1.4s .35s ease-out both}
.hl-sk{background:linear-gradient(90deg,#F2F4F7 0,#E9ECF1 40px,#F2F4F7 80px) #F2F4F7;background-size:480px 100%;animation:hlShimmer 1.3s infinite linear}
@media (pointer:coarse){.hl-field{font-size:16px!important}}
@media (prefers-reduced-motion:reduce){.hl-in,.hl-pop,.hl-sk{animation:none!important}}
`

/** Runs before the page paints: inside an iframe, the page around the card goes transparent. */
const EMBEDDED = "try{if(window.self!==window.top)document.documentElement.classList.add('hl-embed')}catch(e){document.documentElement.classList.add('hl-embed')}"

export type FrameFact = { icon: 'clock' | 'pin' | 'repeat' | 'calendar'; text: string }

function FactIcon({ icon }: { icon: FrameFact['icon'] }) {
  const p = { width: 14, height: 14, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2.2, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, 'aria-hidden': true }
  if (icon === 'clock')
    return (
      <svg {...p}>
        <circle cx="12" cy="12" r="9" />
        <path d="M12 7v5l3 2" />
      </svg>
    )
  if (icon === 'pin')
    return (
      <svg {...p}>
        <path d="M12 21s-7-5.6-7-11a7 7 0 0 1 14 0c0 5.4-7 11-7 11z" />
        <circle cx="12" cy="10" r="2.5" />
      </svg>
    )
  if (icon === 'repeat')
    return (
      <svg {...p}>
        <path d="m17 2 4 4-4 4" />
        <path d="M3 11v-1a4 4 0 0 1 4-4h14" />
        <path d="m7 22-4-4 4-4" />
        <path d="M21 13v1a4 4 0 0 1-4 4H3" />
      </svg>
    )
  return (
    <svg {...p}>
      <rect x="3" y="4" width="18" height="17" rx="3" />
      <path d="M16 2v4M8 2v4M3 10h18" />
    </svg>
  )
}

export function BookingFrame({
  color,
  business,
  logo,
  title,
  facts = [],
  description,
  legal,
  children,
}: {
  color: string
  business: string
  logo: string | null
  title: string
  facts?: FrameFact[]
  description?: string | null
  legal: { privacy: string; terms: string } | null
  children: React.ReactNode
}) {
  const ink = inkOn(color)
  const light = ink === '#FFFFFF'
  return (
    <div data-hl-frame className="hl-page min-h-screen bg-[#F2F4F7] font-sans text-[#101828] antialiased sm:px-5 sm:py-8" style={{ colorScheme: 'light', ['--hl-c' as string]: color, ['--hl-ink' as string]: ink, ['--hl-ring' as string]: `${color}55` }}>
      <script dangerouslySetInnerHTML={{ __html: EMBEDDED }} />
      <style>{BOOKING_CSS}</style>
      <div className="hl-card mx-auto w-full max-w-[920px] overflow-hidden bg-white sm:rounded-[24px] sm:border sm:border-[#E4E7EC] sm:shadow-[0_24px_56px_-28px_rgba(16,24,40,.32)]">
        <header
          className="relative overflow-hidden px-5 pb-6 pt-5 sm:px-8 sm:pb-7 sm:pt-6"
          style={{ background: `linear-gradient(135deg, ${shade(color, 0.14)} 0%, ${color} 46%, ${shade(color, -0.16)} 100%)`, color: ink, textShadow: light ? '0 1px 2px rgba(16,24,40,.18)' : 'none' }}
        >
          <span aria-hidden className="pointer-events-none absolute -right-12 -top-20 h-56 w-56 rounded-full bg-white/[.12]" />
          <span aria-hidden className="pointer-events-none absolute -bottom-24 right-32 h-40 w-40 rounded-full bg-white/[.07]" />
          <div className="relative flex items-start gap-4">
            <span className="shrink-0 rounded-full bg-white/60 p-[2px] shadow-[0_2px_12px_rgba(16,24,40,.22)]">
              <BrandAvatar logo={logo} business={business} size={52} color={shade(color, -0.25)} />
            </span>
            <div className="min-w-0 flex-1 pt-0.5">
              <p className="truncate text-[13px] font-medium opacity-90">{business}</p>
              <h1 className="mt-0.5 text-[22px] font-semibold leading-tight tracking-[-0.015em] sm:text-[26px]">{title}</h1>
              {facts.length > 0 && (
                <div className="mt-3 flex flex-wrap gap-2">
                  {facts.map((f, i) => (
                    <span key={i} className="inline-flex max-w-full items-center gap-1.5 rounded-full bg-white/[.16] px-2.5 py-1 text-[12.5px] font-medium ring-1 ring-inset ring-white/25" style={{ textShadow: 'none' }}>
                      <FactIcon icon={f.icon} />
                      <span className="truncate">{f.text}</span>
                    </span>
                  ))}
                </div>
              )}
            </div>
          </div>
        </header>
        {description && <p className="whitespace-pre-line border-b border-[#F2F4F7] px-5 py-4 text-[14px] leading-relaxed text-[#475467] sm:px-8">{description}</p>}
        <div className="px-5 py-5 sm:px-8 sm:py-7">{children}</div>
      </div>
      <p className="hl-legal flex flex-wrap items-center justify-center gap-1.5 px-4 pb-6 pt-4 text-[11.5px] text-[#98A2B3]">
        {legal && (
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
    </div>
  )
}

/** A length in minutes, as people say it: 30 min, 1 hr, 1 hr 30 min. */
export const lengthText = (m: number) => (m % 60 === 0 ? `${m / 60} hr` : m > 60 ? `${Math.floor(m / 60)} hr ${m % 60} min` : `${m} min`)
