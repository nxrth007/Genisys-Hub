import { redirect } from 'next/navigation'
import { auth } from '@/auth'
import { AgencyView } from '@/components/genisys-os/agency-view'
import { memberAccountIds } from '@/lib/hl/logins'
import { HL_MEMBER_ROLE, MEMBER_HOME_SECTION } from '@/lib/hl/member-access'

/** The agency view; a sub-account's own login opens on their sub-account instead (keeping /login's ?arrive=1). */
export default async function HellLevelHome({ searchParams }: { searchParams: Promise<{ arrive?: string }> }) {
  const session = await auth()
  if (session?.user?.role === HL_MEMBER_ROLE) {
    const [first] = await memberAccountIds(session.user.id)
    const arrive = (await searchParams).arrive === '1' ? '?arrive=1' : ''
    redirect(first ? `/genisys-os/${first}/${MEMBER_HOME_SECTION}${arrive}` : '/login?error=no_account')
  }
  return <AgencyView />
}
