import { redirect } from 'next/navigation'
import { auth } from '@/auth'
import { canAccessHellLevel } from '@/lib/hl/access'
import { memberAccountIds } from '@/lib/hl/logins'
import { HL_MEMBER_ROLE } from '@/lib/hl/member-access'
import { HellShell } from '@/components/hell-level/shell'

export const metadata = { title: 'Hell-level' }

/**
 * Hell-level: the agency's own GoHighLevel, inside the Hub. Its own
 * full-screen shell (GHL's navy sidebar and light canvas) instead of the
 * Hub's; the root shell steps aside for /hell-level (root-shell.tsx).
 *
 * Genisys (the Payments allowlist) gets all of it. A sub-account's own login
 * (a contractor, signed in at /login) gets their sub-accounts' day-to-day
 * screens (src/lib/hl/member-access.ts).
 */
export default async function HellLevelLayout({ children }: { children: React.ReactNode }) {
  const session = await auth()
  if (!session?.user?.email) redirect('/login?callbackUrl=/hell-level')
  const viewer = { name: session.user.name ?? null, email: session.user.email }
  if (session.user.role === HL_MEMBER_ROLE) {
    if (!(await memberAccountIds(session.user.id)).length) redirect('/login?error=no_account')
    return <HellShell viewer={{ ...viewer, admin: false }}>{children}</HellShell>
  }
  if (!canAccessHellLevel(session.user.email)) redirect('/home')
  return <HellShell viewer={{ ...viewer, admin: true }}>{children}</HellShell>
}
