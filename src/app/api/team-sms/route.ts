import { NextResponse } from 'next/server'
import { auth } from '@/auth'
import { canAccessPayments } from '@/lib/payments-access'
import { TEAM_ALERT_PHONES, teamTextLog, textTeam } from '@/lib/team-sms'

/**
 * The team's text alerts (src/lib/team-sms.ts): GET the recent sends and
 * their results; POST sends a test text to everyone on the list. Payments
 * allowlist (Alex, Ethan) only.
 */
async function allowed(): Promise<boolean> {
  const session = await auth()
  return canAccessPayments(session?.user?.email)
}

export async function GET() {
  if (!(await allowed())) return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  return NextResponse.json({ phones: TEAM_ALERT_PHONES.map((p) => p.name), log: await teamTextLog() })
}

export async function POST() {
  if (!(await allowed())) return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  const results = await textTeam('Genisys: test text from the Hub. Whop sign-up and onboarding alerts come to this number.', 'Test')
  return NextResponse.json({ results, log: await teamTextLog() })
}
