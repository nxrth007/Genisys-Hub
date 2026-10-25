import { redirect } from 'next/navigation'
import { auth } from '@/auth'
import { memberAccountIds } from '@/lib/hl/logins'
import { HL_MEMBER_ROLE } from '@/lib/hl/member-access'

/** A sub-account's own login opens only theirs; any other goes back to /hell-level (their first). */
export default async function AccountLayout({ children, params }: { children: React.ReactNode; params: Promise<{ accountId: string }> }) {
  const session = await auth()
  if (session?.user?.role === HL_MEMBER_ROLE) {
    const { accountId } = await params
    if (!(await memberAccountIds(session.user.id)).includes(accountId)) redirect('/hell-level')
  }
  return children
}
