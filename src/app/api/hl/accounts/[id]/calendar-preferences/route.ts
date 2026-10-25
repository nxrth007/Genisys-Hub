import { NextResponse } from 'next/server'
import { getPrefs, savePrefs } from '@/lib/hl/calendar-records'
import { hlAccountOr404, hlError, hlGuard, jsonBody, hlAccountGuard } from '@/lib/hl/http'

type Ctx = { params: Promise<{ id: string }> }

/** GET: the sub-account's calendar preferences, and the signed-in user's own (as `me`). */
export async function GET(_req: Request, { params }: Ctx) {
  const { id } = await params
  const guard = await hlAccountGuard(id)
  if (guard instanceof NextResponse) return guard
  const account = await hlAccountOr404(id)
  if (account instanceof NextResponse) return account
  const prefs = await getPrefs(id)
  return NextResponse.json({ prefs: { ...prefs, users: undefined }, me: prefs.users[guard.email] ?? {} })
}

/** PUT { weekStartsOn?, timeFormat?, widgetLanguage?, services?, me? } */
export async function PUT(req: Request, { params }: Ctx) {
  const guard = await hlGuard()
  if (guard instanceof NextResponse) return guard
  const { id } = await params
  const account = await hlAccountOr404(id)
  if (account instanceof NextResponse) return account
  try {
    const prefs = await savePrefs(id, await jsonBody(req), guard.email)
    return NextResponse.json({ prefs: { ...prefs, users: undefined }, me: prefs.users[guard.email] ?? {} })
  } catch (err) {
    return hlError(err, 'calendar preferences')
  }
}
