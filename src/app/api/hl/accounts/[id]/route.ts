import { NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import type { Prisma } from '@/generated/prisma/client'
import { mergeProfile, profileForClient, readProfile } from '@/lib/hl/accounts'
import { hlAccountOr404, hlError, hlGuard, HlInputError, jsonBody, str } from '@/lib/hl/http'
import { launchpad } from '@/lib/hl/launchpad'
import { findSiteBrand } from '@/lib/hl/logo'
import { setDefaultAccount } from '@/lib/hl/ghl-import'

type Ctx = { params: Promise<{ id: string }> }

/** GET: the sub-account with its profile, numbers and Launchpad checklist. */
export async function GET(_req: Request, { params }: Ctx) {
  const guard = await hlGuard()
  if (guard instanceof NextResponse) return guard
  const { id } = await params
  const account = await hlAccountOr404(id)
  if (account instanceof NextResponse) return account
  const [numbers, lp, client] = await Promise.all([
    prisma.hlPhoneNumber.findMany({ where: { accountId: id, status: 'active' }, orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }] }),
    launchpad(id),
    account.clientId ? prisma.client.findUnique({ where: { id: account.clientId }, select: { id: true, name: true, siteUrl: true } }) : null,
  ])
  return NextResponse.json({ account: { ...account, profile: readProfile(account.profile) }, numbers, launchpad: lp, client })
}

/**
 * PATCH { name?, timezone?, profile?: {...}, refillProfile?: true, archived?: boolean }
 * refillProfile re-reads the client's onboarding answers into blank profile fields.
 */
export async function PATCH(req: Request, { params }: Ctx) {
  const guard = await hlGuard()
  if (guard instanceof NextResponse) return guard
  const { id } = await params
  const account = await hlAccountOr404(id)
  if (account instanceof NextResponse) return account
  try {
    const body = await jsonBody(req)
    if (body.makeDefault === true) {
      await setDefaultAccount(id)
      return NextResponse.json({ ok: true })
    }
    // "Find them on their website": the logo and brand colour on the site (the one typed in the form, else the profile's), not saved yet.
    if (body.findLogo === true) {
      const site = str(body.website) || readProfile(account.profile).website || ''
      const found = site ? await findSiteBrand(site).catch(() => null) : null
      return NextResponse.json({ logoUrl: found?.logo ?? null, brandColor: found?.color ?? null })
    }
    const data: Prisma.HlAccountUpdateInput = {}
    const name = str(body.name)
    if (name) data.name = name
    const tz = str(body.timezone)
    if (tz) {
      try {
        new Intl.DateTimeFormat('en-US', { timeZone: tz })
      } catch {
        throw new HlInputError(`“${tz}” isn’t a timezone (try America/New_York).`)
      }
      data.timezone = tz
    }
    let profile = readProfile(account.profile)
    if (body.profile && typeof body.profile === 'object') profile = mergeProfile(profile, body.profile as Record<string, unknown>)
    if (body.refillProfile === true && account.clientId) {
      const fromClient = await profileForClient(account.clientId)
      const filled: Record<string, string> = { ...(profile as Record<string, string>) }
      for (const [k, v] of Object.entries(fromClient)) if (!filled[k]?.trim() && v) filled[k] = v
      profile = filled
    }
    data.profile = profile as Prisma.InputJsonValue
    if (typeof body.archived === 'boolean') data.archivedAt = body.archived ? new Date() : null
    const updated = await prisma.hlAccount.update({ where: { id }, data })
    return NextResponse.json({ account: { ...updated, profile: readProfile(updated.profile) } })
  } catch (err) {
    return hlError(err, 'update sub-account')
  }
}
