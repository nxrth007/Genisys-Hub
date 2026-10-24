import { redirect } from 'next/navigation'
import { auth } from '@/auth'
import { canAccessHellLevel } from '@/lib/hl/access'
import { HellShell } from '@/components/hell-level/shell'

export const metadata = { title: 'Hell-level' }

/**
 * Hell-level: the agency's own GoHighLevel, inside the Hub. Its own
 * full-screen shell (GHL's navy sidebar and light canvas) instead of the
 * Hub's; the root shell steps aside for /hell-level (root-shell.tsx).
 */
export default async function HellLevelLayout({ children }: { children: React.ReactNode }) {
  const session = await auth()
  if (!session?.user?.email) redirect('/signin?callbackUrl=/hell-level')
  if (!canAccessHellLevel(session.user.email)) redirect('/home')
  return <HellShell>{children}</HellShell>
}
