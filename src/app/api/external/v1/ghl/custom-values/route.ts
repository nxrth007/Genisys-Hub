import { NextRequest } from 'next/server'
import { withOwnerApi, externalOptions } from '@/lib/external-api'
import { externalWrite, WriteError, requireOwner } from '@/lib/external-write'
import {
  getCustomValues,
  upsertCustomValue,
  deleteCustomValue,
} from '@/lib/ghl'

/**
 * /api/external/v1/ghl/custom-values — editable website copy.
 *
 * GHL's funnel API cannot write page content, so a template's text is
 * only reachable through custom values: the builder renders
 * {{ custom_values.some_key }} wherever one is placed, and this route
 * is what changes what those render to.
 *
 * Owner-gated in both directions. These values are live client website
 * copy — a bad write is visible to the client's customers immediately,
 * which is not a staff surface.
 */

const DEFAULT_SUBACCOUNT = 'GHL Genisys Token'

function subaccountFrom(value: string | null): string {
  const name = (value ?? '').trim()
  return name.length > 0 ? name : DEFAULT_SUBACCOUNT
}

export const GET = withOwnerApi(async (req) => {
  const subaccount = subaccountFrom(req.nextUrl.searchParams.get('subaccount'))
  const customValues = await getCustomValues(subaccount)

  return {
    subaccount,
    // Sorted by name so repeated calls are diffable; the API returns
    // them in creation order, which shuffles as copy gets added.
    customValues: [...customValues].sort((a, b) => a.name.localeCompare(b.name)),
    count: customValues.length,
  }
})

export const PUT = externalWrite(async ({ auth, body }) => {
  requireOwner(auth)

  const subaccount = subaccountFrom(
    typeof body.subaccount === 'string' ? body.subaccount : null
  )

  // Accept one {name, value} or a batch, so a page's worth of copy can
  // go up in a single call rather than one request per headline.
  const rawItems = Array.isArray(body.values)
    ? body.values
    : [{ name: body.name, value: body.value }]

  const items = rawItems.map((item) => {
    const entry = (item ?? {}) as Record<string, unknown>
    const name = String(entry.name ?? '').trim()
    const value = entry.value
    if (!name) throw new WriteError('each item needs a non-empty name')
    if (typeof value !== 'string') {
      throw new WriteError(`value for "${name}" must be a string`)
    }
    return { name, value }
  })

  if (items.length === 0) throw new WriteError('nothing to write')

  // Sequential: upsert reads the full list to find a name match, so
  // running these in parallel would race and create duplicates.
  const results = []
  for (const item of items) {
    const { customValue, created } = await upsertCustomValue(
      subaccount,
      item.name,
      item.value
    )
    results.push({ ...customValue, created })
  }

  return { subaccount, written: results.length, customValues: results }
})

export const DELETE = externalWrite(async ({ auth, body }, req) => {
  requireOwner(auth)

  // Deletes here carry their arguments in the query string, matching the
  // rest of the external API; a JSON body is still honoured if one is sent.
  const params = req.nextUrl.searchParams
  const subaccount = subaccountFrom(
    params.get('subaccount') ??
      (typeof body.subaccount === 'string' ? body.subaccount : null)
  )
  const id = String(params.get('id') ?? body.id ?? '').trim()
  if (!id) throw new WriteError('id is required')

  await deleteCustomValue(subaccount, id)
  return { subaccount, id, deleted: true }
})

export function OPTIONS(req: NextRequest) {
  return externalOptions(req)
}
