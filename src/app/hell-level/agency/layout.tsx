import { redirect } from 'next/navigation'
import { auth } from '@/auth'
import { HL_MEMBER_ROLE } from '@/lib/hl/member-access'

/** The agency view is Genisys's (the middleware turns sub-account logins away first). */
export default async function AgencyLayout({ children }: { children: React.ReactNode }) {
  const session = await auth()
  if (session?.user?.role === HL_MEMBER_ROLE) redirect('/hell-level')
  return children
}
