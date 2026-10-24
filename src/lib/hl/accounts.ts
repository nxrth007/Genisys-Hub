import { prisma } from '@/lib/prisma'
import { boardInputs } from '@/lib/automation-copy-server'
import type { Prisma } from '@/generated/prisma/client'
import { HlInputError } from './http'
import { toE164 } from './phone'
import { CHAT_FIELDS, CHAT_SETTINGS, LEAD_STAGES, QUOTE_FORM_FIELDS, QUOTE_FORM_SETTINGS, workflowTemplates } from './templates'
import type { HlProfile } from './types'

/**
 * Sub-accounts: one per client, made from the client's onboarding answers.
 * Creating one is free (it's rows in the Hub's database, not a GHL plan
 * feature), so every client can have one; phone numbers are the only part
 * that costs money, and those are bought by a person.
 */

const clean = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim()

export function readProfile(v: unknown): HlProfile {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as HlProfile) : {}
}

/** The business profile as the client's onboarding answers, Automation Copy board and Google profile board have it. */
export async function profileForClient(clientId: string): Promise<HlProfile> {
  const [client, inputs, gbp] = await Promise.all([
    prisma.client.findUnique({
      where: { id: clientId },
      select: {
        name: true,
        contactPhone: true,
        address: true,
        ein: true,
        intakes: { orderBy: { receivedAt: 'desc' }, take: 1, select: { customerPhone: true, businessContact: true, businessAddress: true, ein: true, businessName: true } },
      },
    }),
    boardInputs(clientId).catch(() => null),
    prisma.appSetting.findUnique({ where: { key: `gbp.client.${clientId}` } }).catch(() => null),
  ])
  if (!client) throw new HlInputError('That client no longer exists.')
  const intake = client.intakes[0]
  let reviewLink = ''
  try {
    reviewLink = clean((JSON.parse(gbp?.value ?? '{}') as { reviewUrl?: string }).reviewUrl)
  } catch {
    // no Google profile board yet
  }
  const ownerPhone = toE164(intake?.customerPhone) ?? toE164(client.contactPhone) ?? toE164(intake?.businessContact)
  const ein = clean(intake?.ein || client.ein).replace(/[^\d-]/g, '')
  return {
    businessName: clean(inputs?.businessName) || clean(client.name),
    ownerFirstName: clean(inputs?.ownerFirstName),
    ownerName: clean(inputs?.ownerFullName),
    businessPhone: clean(inputs?.phone),
    website: clean(inputs?.quoteLink),
    notifyPhone: ownerPhone ?? '',
    notifyEmail: clean(inputs?.notifyEmail),
    reviewLink,
    address: clean(intake?.businessAddress || client.address),
    legalName: clean(intake?.businessName) || clean(client.name),
    ein: ein.replace(/\D/g, '').length === 9 ? ein : '',
  }
}

/**
 * The pipeline, forms and automations a new sub-account starts with. Safe to
 * run again: it only adds what's missing (by template key / name).
 */
export async function ensureStarterKit(accountId: string): Promise<void> {
  const [pipelines, forms, workflows] = await Promise.all([
    prisma.hlPipeline.count({ where: { accountId } }),
    prisma.hlForm.findMany({ where: { accountId }, select: { id: true, kind: true } }),
    prisma.hlWorkflow.findMany({ where: { accountId }, select: { template: true } }),
  ])
  if (!pipelines) {
    await prisma.hlPipeline.create({ data: { accountId, name: 'Leads', stages: LEAD_STAGES as unknown as Prisma.InputJsonValue } })
  }
  let quote = forms.find((f) => f.kind === 'form')?.id
  let chat = forms.find((f) => f.kind === 'chat')?.id
  if (!quote) {
    quote = (
      await prisma.hlForm.create({
        data: { accountId, name: 'Website Quote Form', kind: 'form', fields: QUOTE_FORM_FIELDS as unknown as Prisma.InputJsonValue, settings: QUOTE_FORM_SETTINGS as Prisma.InputJsonValue },
      })
    ).id
  }
  if (!chat) {
    chat = (
      await prisma.hlForm.create({
        data: { accountId, name: 'Website Chat Widget', kind: 'chat', fields: CHAT_FIELDS as unknown as Prisma.InputJsonValue, settings: CHAT_SETTINGS as Prisma.InputJsonValue },
      })
    ).id
  }
  const have = new Set(workflows.map((w) => w.template))
  for (const t of workflowTemplates({ quote, chat })) {
    if (have.has(t.key)) continue
    await prisma.hlWorkflow.create({
      data: {
        accountId,
        name: t.name,
        folder: t.folder,
        template: t.key,
        status: t.publish ? 'published' : 'draft',
        publishedAt: t.publish ? new Date() : null,
        trigger: t.trigger as unknown as Prisma.InputJsonValue,
        steps: t.steps as unknown as Prisma.InputJsonValue,
      },
    })
  }
}

/** The client's sub-account, made (with its starter kit) if it doesn't exist yet. */
export async function createAccountForClient(clientId: string): Promise<{ id: string; created: boolean }> {
  const existing = await prisma.hlAccount.findUnique({ where: { clientId }, select: { id: true } })
  if (existing) return { id: existing.id, created: false }
  const profile = await profileForClient(clientId)
  const account = await prisma.hlAccount
    .create({
      data: { clientId, name: profile.businessName || 'New sub-account', profile: profile as Prisma.InputJsonValue },
      select: { id: true },
    })
    .catch(async (err) => {
      // Two clicks at once: the unique clientId lets only one through.
      const again = await prisma.hlAccount.findUnique({ where: { clientId }, select: { id: true } })
      if (again) return again
      throw err
    })
  await ensureStarterKit(account.id)
  return { id: account.id, created: true }
}

/** A sub-account with no client behind it (the agency's own, a test account…). */
export async function createStandaloneAccount(name: string): Promise<{ id: string }> {
  const n = clean(name)
  if (!n) throw new HlInputError('Give the sub-account a name.')
  const account = await prisma.hlAccount.create({ data: { name: n, profile: { businessName: n } }, select: { id: true } })
  await ensureStarterKit(account.id)
  return account
}

/** Merge profile changes; blank strings clear a value. */
export function mergeProfile(current: HlProfile, patch: Record<string, unknown>): HlProfile {
  const next: Record<string, string> = { ...(current as Record<string, string>) }
  for (const [k, v] of Object.entries(patch)) {
    if (typeof v !== 'string') continue
    next[k] = k === 'notifyPhone' ? v.trim() : clean(v)
  }
  return next as HlProfile
}
