import { redirect } from 'next/navigation'
import { auth } from '@/auth'
import { officeDemoAllowed } from '@/lib/office/demo'
import { OfficeView } from '@/components/office/office-view'

/**
 * /office — a live isometric "virtual office" of the Hub's pipeline bots.
 * Staff only (admin/member), same as the /api/office/state route it polls.
 */
export const metadata = { title: 'Office · Genisys Hub' }

export default async function OfficePage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const session = await auth()
  const role = (session?.user as { role?: string } | undefined)?.role
  if (role !== 'admin' && role !== 'member') redirect('/today')
  const sp = await searchParams
  const demo = sp.demo === '1' && officeDemoAllowed()
  return <OfficeView demo={demo} user={{ name: session?.user?.name ?? null, email: session?.user?.email ?? null, image: session?.user?.image ?? null, role: role ?? null }} />
}
