import { NextRequest } from 'next/server'
import { prisma } from '@/lib/prisma'
import { externalWrite, WriteError, requireOwner } from '@/lib/external-write'
import { externalOptions } from '@/lib/external-api'

/**
 * POST  /api/external/v1/clients/manage — create a client
 * PATCH /api/external/v1/clients/manage — archive / restore / edit one
 *
 * "Archive" sets active=false rather than deleting: appointments,
 * invoices and deliveries all reference Client, and removing the row
 * would orphan history the business still needs.
 */
export const POST = externalWrite(async ({ auth, body }) => {
  requireOwner(auth)

  const name = String(body.name ?? '').trim()
  if (!name) throw new WriteError('Client name is required.')

  const existing = await prisma.client.findUnique({ where: { name } })
  if (existing) throw new WriteError(`"${name}" already exists.`)

  const client = await prisma.client.create({
    data: {
      name,
      state: String(body.state ?? '').trim() || null,
      color: String(body.color ?? '').trim() || '#3b82f6',
      contactName: String(body.contactName ?? '').trim() || null,
      contactEmail: String(body.contactEmail ?? '').trim() || null,
      contactPhone: String(body.contactPhone ?? '').trim() || null,
      notes: String(body.notes ?? '').trim() || null,
    },
    select: { id: true, name: true },
  })
  return client
})

export const PATCH = externalWrite(async ({ auth, body }) => {
  requireOwner(auth)

  const id = String(body.id ?? '')
  if (!id) throw new WriteError('id is required.')

  const existing = await prisma.client.findUnique({ where: { id } })
  if (!existing) throw new WriteError('Client not found.', 404)

  const data: Record<string, unknown> = {}
  if (typeof body.active === 'boolean') data.active = body.active
  for (const f of [
    'state',
    'contactName',
    'contactEmail',
    'contactPhone',
    'notes',
    'color',
  ]) {
    if (typeof body[f] === 'string') {
      data[f] = (body[f] as string).trim() || null
    }
  }
  if (typeof body.name === 'string' && body.name.trim()) {
    data.name = body.name.trim()
  }

  if (Object.keys(data).length === 0) throw new WriteError('Nothing to update.')

  await prisma.client.update({ where: { id }, data })
  return { id, ...data }
})

export const OPTIONS = (req: NextRequest) => externalOptions(req)
