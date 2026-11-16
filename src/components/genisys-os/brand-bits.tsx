import { inkOn } from '@/lib/hl/color'

/**
 * Small pieces the client-facing widgets share (the chat widget, the booking
 * pages): the business's logo or initial, the drawn US flag, and a phone
 * number formatted as it's typed. No hooks, so server pages use them too.
 */

export function BrandAvatar({ logo, business, size, color }: { logo: string | null; business: string; size: number; color: string }) {
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
export function UsFlag() {
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

/** A US number as it's typed: 631, (631) 555, (631) 555-0142. Pasted +1s are dropped. */
export const phoneTyping = (raw: string) => {
  const d = raw.replace(/\D/g, '').replace(/^1(?=\d{10})/, '').slice(0, 10)
  if (d.length <= 3) return d
  if (d.length <= 6) return `(${d.slice(0, 3)}) ${d.slice(3)}`
  return `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`
}

/** A finished US number for showing back: (631) 555-0142. */
export const phonePretty = (raw: string) => {
  const d = raw.replace(/\D/g, '').replace(/^1(?=\d{10}$)/, '')
  return d.length === 10 ? `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}` : raw
}
