import { notFound } from 'next/navigation'
import { publicMenu } from '@/lib/hl/service-menus'
import { ServiceMenuBooking } from '@/components/hell-level/service-menu'
import { FrameHeight } from '@/components/hell-level/frame-height'

export const dynamic = 'force-dynamic'

type Props = { params: Promise<{ menuId: string }>; searchParams: Promise<{ page?: string }> }

export async function generateMetadata({ params }: Props) {
  const menu = await publicMenu((await params).menuId)
  return { title: menu ? `${menu.name} | ${menu.business}` : 'Book a service', robots: { index: false } }
}

/** A service menu's page (GHL's service menu widget): hosted here, and embedded on the client's site in an iframe. */
export default async function ServiceMenuPage({ params, searchParams }: Props) {
  const { menuId } = await params
  const menu = await publicMenu(menuId)
  if (!menu) notFound()
  const { page } = await searchParams
  return (
    <div className="min-h-screen bg-white text-[#101828]" style={{ colorScheme: 'light' }}>
      <style>{'html,body{background:#fff!important;color-scheme:light}'}</style>
      <main className="mx-auto flex w-full max-w-4xl px-5 py-6">
        <ServiceMenuBooking menu={menu} pageUrl={page ?? null} />
      </main>
      <FrameHeight formId={menu.id} />
    </div>
  )
}
