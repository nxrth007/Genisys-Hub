import { redirect } from 'next/navigation'
import { auth } from '@/auth'
import { SignInForm } from '@/components/hell-level/login-screen'
import { canAccessHellLevel } from '@/lib/hl/access'
import { memberAccountIds } from '@/lib/hl/logins'
import { HL_MEMBER_ROLE } from '@/lib/hl/member-access'

export const metadata = { title: 'Sign in · Genisys CRM' }

type Search = { callbackUrl?: string | string[]; forgot?: string | string[]; error?: string | string[] }

/**
 * Contractors' sign-in to their Hell-level sub-account (invited from
 * Settings → My Staff, src/lib/hl/logins.ts). Genisys has a Google button
 * here too, since signed-out /hell-level lands here.
 */
export default async function LoginPage({ searchParams }: { searchParams: Promise<Search> }) {
  const sp = await searchParams
  const one = (v: string | string[] | undefined) => (typeof v === 'string' ? v : null)
  const session = await auth()
  let stranded = false
  if (session?.user?.email) {
    if (session.user.role === HL_MEMBER_ROLE) {
      if ((await memberAccountIds(session.user.id)).length) redirect('/hell-level')
      stranded = true
    } else if (canAccessHellLevel(session.user.email)) {
      redirect('/hell-level')
    }
  }
  const noAccount = stranded || one(sp.error) === 'no_account'
  return (
    <SignInForm
      callbackUrl={one(sp.callbackUrl)}
      forgot={one(sp.forgot) === '1'}
      notice={noAccount ? 'Your login isn’t on a sub-account anymore. Ask Genisys to add you back.' : null}
      signOutFirst={stranded}
    />
  )
}
