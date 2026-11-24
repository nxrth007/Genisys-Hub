import { notFound } from 'next/navigation'
import { inkOn } from '@/lib/hl/color'
import { workFeed } from '@/lib/hl/work-photos'

export const dynamic = 'force-dynamic'

type Props = { params: Promise<{ accountId: string }> }

export async function generateMetadata({ params }: Props) {
  const feed = await workFeed((await params).accountId)
  return { title: feed ? `Recent work from ${feed.business}` : 'Recent work', robots: { index: false, follow: false } }
}

/**
 * /hl/w/<account>: a client's Recent Work, the photos they text to their business number
 * (src/lib/hl/work-photos.ts). The owner's confirmation text links here; their website shows the same
 * photos through /hl/work.js. Not indexed: the client's own site is the place for it.
 */
export default async function WorkPage({ params }: Props) {
  const feed = await workFeed((await params).accountId)
  if (!feed) notFound()
  const ink = inkOn(feed.color)
  const day = (iso: string) => new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
  return (
    <div className="min-h-screen bg-white text-[#101828]" style={{ colorScheme: 'light' }}>
      <style>{'html,body{background:#fff!important;color-scheme:light}'}</style>
      <header className="px-5 py-5" style={{ background: feed.color, color: ink }}>
        <div className="mx-auto flex max-w-4xl items-center gap-3">
          {feed.logo && (
            // eslint-disable-next-line @next/next/no-img-element -- the client's logo, wherever it's kept
            <img src={feed.logo} alt="" className="h-11 w-11 rounded-full bg-white object-contain p-1" />
          )}
          <div className="min-w-0">
            <p className="truncate text-[17px] font-semibold leading-tight">{feed.business}</p>
            <p className="text-[13px] opacity-80">Recent work</p>
          </div>
          {feed.website && (
            <a href={feed.website} target="_blank" rel="noreferrer" className="ml-auto rounded-lg bg-white/15 px-3 py-1.5 text-[13px] font-medium hover:bg-white/25">
              Website
            </a>
          )}
        </div>
      </header>
      <main className="mx-auto max-w-4xl px-5 py-8">
        {feed.photos.length === 0 ? (
          <p className="py-16 text-center text-[15px] text-[#667085]">No photos yet. Text a photo of a finished job to your business number and it shows up here.</p>
        ) : (
          <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            {feed.photos.map((p) => (
              <li key={p.id} className="relative aspect-square overflow-hidden rounded-2xl bg-[#EEF0F3]">
                <a href={p.url} target="_blank" rel="noreferrer">
                  {/* eslint-disable-next-line @next/next/no-img-element -- the photo itself, from Media Storage */}
                  <img src={p.url} alt={p.caption || `${feed.business}: recent work`} loading="lazy" className="h-full w-full object-cover" />
                  <span className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-[#101828]/70 to-transparent px-3 pb-2.5 pt-6 text-[13px] font-medium text-white">{p.caption || day(p.at)}</span>
                </a>
              </li>
            ))}
          </ul>
        )}
        <p className="mt-10 text-center text-[12px] text-[#98A2B3]">Powered by Genisys</p>
      </main>
    </div>
  )
}
