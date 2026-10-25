import { notFound } from 'next/navigation'
import { publicMenu } from '@/lib/hl/service-menus'
import { BookingFrame } from '@/components/hell-level/booking-frame'
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
    <>
      <BookingFrame color={menu.color} business={menu.business} logo={menu.logo} title={menu.name} description={menu.description} legal={menu.services[0]?.calendar.legal ?? null}>
        <ServiceMenuBooking menu={menu} pageUrl={page ?? null} />
      </BookingFrame>
      <FrameHeight formId={menu.id} />
    </>
  )
}
