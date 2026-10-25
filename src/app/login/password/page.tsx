import { SetPasswordForm } from '@/components/hell-level/login-screen'

export const metadata = { title: 'Choose your password · Genisys CRM' }

/** The link in a login invite or a password reset (src/lib/hl/logins.ts): choose a password, then straight in. */
export default async function SetPasswordPage({ searchParams }: { searchParams: Promise<{ u?: string | string[]; t?: string | string[] }> }) {
  const { u, t } = await searchParams
  return <SetPasswordForm u={typeof u === 'string' ? u : ''} t={typeof t === 'string' ? t : ''} />
}
