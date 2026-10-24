import { NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import type { Prisma } from '@/generated/prisma/client'
import { hlError, hlGuard, HlInputError, jsonBody, str } from '@/lib/hl/http'
import {
  LOVABLE_IP,
  connectLovable,
  copyDnsForTransfer,
  disconnectHost,
  metaOf,
  normalizeDomain,
  refreshFromRegistrar,
  refreshTransfer,
  releaseHeldTransfer,
  retryPurchase,
  siteRecords,
  verifyExternal,
  type HostConnection,
} from '@/lib/hl/domains'
import {
  PorkbunError,
  RECORD_TYPES,
  addEmailForward,
  addUrlForward,
  createRecord,
  deleteEmailForward,
  deleteRecord,
  deleteUrlForward,
  dnsRecords,
  editRecord,
  emailForwards,
  getNameservers,
  setNameservers,
  updateTransferAuthCode,
  urlForwards,
  type RecordInput,
} from '@/lib/hl/porkbun'

type Ctx = { params: Promise<{ id: string; domainId: string }> }

/** Porkbun's own nameservers, for a domain that isn't using them yet. */
const PORKBUN_NS = ['curitiba.ns.porkbun.com', 'fortaleza.ns.porkbun.com', 'maceio.ns.porkbun.com', 'salvador.ns.porkbun.com']

async function load(id: string, domainId: string) {
  const d = await prisma.hlDomain.findUnique({ where: { id: domainId } })
  return d && d.accountId === id ? d : null
}

/** Each part on its own: a domain mid-transfer has DNS but no forwarding yet, and one failing part shouldn't blank the page. */
async function part<T>(fn: () => Promise<T>): Promise<{ data: T | null; error: string | null }> {
  try {
    return { data: await fn(), error: null }
  } catch (err) {
    return { data: null, error: err instanceof Error ? err.message : String(err) }
  }
}

/** A connection with the records it needs, for the page to list. */
const withRecords = (h: HostConnection) => ({ ...h, records: siteRecords(h) })

/** GET: the domain with its DNS records, nameservers, email forwards and redirects (an external one: its connections and their DNS check). */
export async function GET(_req: Request, { params }: Ctx) {
  const guard = await hlGuard()
  if (guard instanceof NextResponse) return guard
  const { id, domainId } = await params
  const loaded = await load(id, domainId)
  if (!loaded) return NextResponse.json({ error: 'Domain not found' }, { status: 404 })
  let domain = loaded
  if (domain.origin === 'external') {
    // Re-check what's still waiting on its DNS provider.
    if ((metaOf(domain.meta).hosts ?? []).some((h) => !h.verifiedAt)) domain = await verifyExternal(domain.id)
    return NextResponse.json({ domain, hosts: (metaOf(domain.meta).hosts ?? []).map(withRecords) })
  }
  const live = domain.status === 'active' || domain.status === 'held' || domain.status === 'transferring'
  if (!live) return NextResponse.json({ domain })
  const [records, nameservers, forwards, redirects] = await Promise.all([
    part(() => dnsRecords(domain.name)),
    domain.status === 'active' ? part(() => getNameservers(domain.name)) : Promise.resolve({ data: null, error: null }),
    domain.status === 'active' ? part(() => emailForwards(domain.name)) : Promise.resolve({ data: null, error: null }),
    domain.status === 'active' ? part(() => urlForwards(domain.name)) : Promise.resolve({ data: null, error: null }),
  ])
  const meta = metaOf(domain.meta)
  const expectNs = meta.porkbunNameservers?.length ? meta.porkbunNameservers : PORKBUN_NS
  const onPorkbun = nameservers.data ? nameservers.data.some((n) => n.endsWith('.porkbun.com') || expectNs.includes(n)) : null
  // Connected products, read off the records: hosts pointed at Lovable, and email forwarding.
  if (records.data) {
    const pointed = new Set(records.data.filter((r) => r.type === 'A' && r.content === LOVABLE_IP).map((r) => (r.host === 'www' ? '' : r.host)))
    const known = meta.hosts ?? []
    const hosts: HostConnection[] = [...pointed].map((h) => known.find((k) => k.host === h) ?? { host: h, product: 'site' as const, addedAt: domain.createdAt.toISOString(), verifiedAt: null })
    const emailForwards = forwards.data?.length ?? meta.emailForwards ?? 0
    if (JSON.stringify(hosts) !== JSON.stringify(known) || emailForwards !== meta.emailForwards) {
      domain = await prisma.hlDomain.update({ where: { id: domain.id }, data: { meta: { ...meta, hosts, emailForwards } as Prisma.InputJsonValue } })
    }
  }
  return NextResponse.json({ domain, records, nameservers: { ...nameservers, onPorkbun }, forwards, redirects, hosts: (metaOf(domain.meta).hosts ?? []).map(withRecords) })
}

function recordInput(body: Record<string, unknown>): RecordInput {
  const type = String(body.type ?? '').toUpperCase()
  if (!(RECORD_TYPES as readonly string[]).includes(type)) throw new HlInputError('Pick a record type.')
  const content = str(body.content)
  if (!content) throw new HlInputError('The record needs a value.')
  const host = (str(body.host) ?? '').toLowerCase().replace(/\.$/, '').replace(/^@$/, '')
  if (host && !/^[a-z0-9_*]([a-z0-9_.-]*[a-z0-9_])?$/.test(host)) throw new HlInputError('The name can only have letters, numbers, dots, dashes and underscores (leave it blank for the domain itself).')
  const ttl = typeof body.ttl === 'number' ? body.ttl : Number(body.ttl) || null
  const prio = body.prio === '' || body.prio === null || body.prio === undefined ? null : Number(body.prio)
  if ((type === 'MX' || type === 'SRV') && (prio === null || !Number.isFinite(prio))) throw new HlInputError('MX and SRV records need a priority.')
  return { host, type, content, ttl, prio: prio !== null && Number.isFinite(prio) ? prio : null }
}

async function log(domainId: string, by: string, what: string, data: Prisma.HlDomainUpdateInput = {}) {
  const row = await prisma.hlDomain.findUniqueOrThrow({ where: { id: domainId }, select: { log: true } })
  const entries = [...((row.log as unknown[]) ?? []), { at: new Date().toISOString(), by, what }].slice(-100)
  await prisma.hlDomain.update({ where: { id: domainId }, data: { ...data, log: entries as Prisma.InputJsonValue } })
}

/**
 * POST { action, ... }:
 *   add-record / edit-record (recordId) / delete-record (recordId): DNS
 *   add-forward { address, forwardTo, confirm? } / delete-forward { address }: email forwarding
 *   add-redirect { host, location, permanent, includePath, wildcard } / delete-redirect { redirectId }
 *   connect-lovable { rootTxt, wwwTxt? }: point the domain at the client's Lovable site
 *   use-porkbun-ns: answer from the DNS here
 *   copy-dns / release / auth-code { authCode }: a transfer's steps
 *   refresh: ask Porkbun where things stand
 */
export async function POST(req: Request, { params }: Ctx) {
  const guard = await hlGuard()
  if (guard instanceof NextResponse) return guard
  const { id, domainId } = await params
  const domain = await load(id, domainId)
  if (!domain) return NextResponse.json({ error: 'Domain not found' }, { status: 404 })
  const by = guard.email
  try {
    const body = await jsonBody(req)
    const name = domain.name
    const dnsEditable = domain.status === 'active' || domain.status === 'held'
    switch (body.action) {
      case 'add-record': {
        if (!dnsEditable) throw new HlInputError('DNS can be edited once the domain is here.')
        const r = recordInput(body)
        await createRecord(name, r)
        await log(domainId, by, `Added ${r.type} ${r.host || '@'} → ${r.content}`)
        break
      }
      case 'edit-record': {
        if (!dnsEditable) throw new HlInputError('DNS can be edited once the domain is here.')
        const recordId = str(body.recordId)
        if (!recordId) throw new HlInputError('Which record?')
        const r = recordInput(body)
        await editRecord(name, recordId, r)
        await log(domainId, by, `Changed a ${r.type} record: ${r.host || '@'} → ${r.content}`)
        break
      }
      case 'delete-record': {
        if (!dnsEditable) throw new HlInputError('DNS can be edited once the domain is here.')
        const recordId = str(body.recordId)
        if (!recordId) throw new HlInputError('Which record?')
        const before = (await dnsRecords(name)).find((r) => r.id === recordId)
        await deleteRecord(name, recordId)
        await log(domainId, by, before ? `Deleted ${before.type} ${before.host || '@'} → ${before.content}` : `Deleted record ${recordId}`)
        break
      }
      case 'add-forward': {
        const address = str(body.address)?.toLowerCase().replace(new RegExp(`@${name.replace(/\./g, '\\.')}$`), '')
        const forwardTo = str(body.forwardTo)?.toLowerCase()
        if (!address || !/^[a-z0-9._*+-]+$/.test(address)) throw new HlInputError('The address is the part before the @, like “info”.')
        if (!forwardTo || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(forwardTo)) throw new HlInputError('Forward to a full email address.')
        try {
          await addEmailForward(name, address, forwardTo, body.confirm === true)
        } catch (err) {
          if (err instanceof PorkbunError && err.code === 'DNS_CHANGE_CONFIRMATION_REQUIRED') return NextResponse.json({ needsConfirm: true, message: err.message })
          throw err
        }
        await log(domainId, by, `Email ${address}@${name} now forwards to ${forwardTo}`)
        break
      }
      case 'delete-forward': {
        const address = str(body.address)
        if (!address) throw new HlInputError('Which address?')
        await deleteEmailForward(name, address)
        await log(domainId, by, `Stopped forwarding ${address}`)
        break
      }
      case 'add-redirect': {
        const location = str(body.location)
        if (!location || !/^https?:\/\/\S+$/.test(location)) throw new HlInputError('Redirect to a full address starting with https://.')
        const host = (str(body.host) ?? '').toLowerCase().replace(/^@$/, '')
        await addUrlForward(name, { host, location, permanent: body.permanent !== false, includePath: body.includePath === true, wildcard: body.wildcard === true })
        await log(domainId, by, `Redirect ${host ? `${host}.` : ''}${name} → ${location}`)
        break
      }
      case 'delete-redirect': {
        const redirectId = str(body.redirectId)
        if (!redirectId) throw new HlInputError('Which redirect?')
        await deleteUrlForward(name, redirectId)
        await log(domainId, by, 'Removed a redirect')
        break
      }
      case 'connect-lovable':
        if (domain.origin === 'external') throw new HlInputError('This domain’s DNS is elsewhere: add the records there, then Verify.')
        if (!dnsEditable) throw new HlInputError('Connect the site once the domain is here.')
        await connectLovable(domainId, { host: str(body.host) ?? '', rootTxt: str(body.rootTxt) ?? '', wwwTxt: str(body.wwwTxt), by })
        break
      case 'verify':
        await verifyExternal(domainId)
        break
      case 'disconnect':
        await disconnectHost(domainId, typeof body.host === 'string' ? body.host : '', by)
        break
      case 'use-porkbun-ns': {
        if (domain.status !== 'active') throw new HlInputError('Only for a domain that’s here.')
        const records = await dnsRecords(name)
        if (!records.length) throw new HlInputError('The DNS here is empty, so switching would take the site and email down. Add the records first.')
        const meta = (domain.meta as Record<string, unknown>) ?? {}
        const ns = (meta.porkbunNameservers as string[] | undefined)?.length ? (meta.porkbunNameservers as string[]) : PORKBUN_NS
        await setNameservers(name, ns)
        await log(domainId, by, `Nameservers set to Porkbun’s (${ns.join(', ')})`)
        break
      }
      case 'copy-dns':
        await copyDnsForTransfer(domainId, by)
        break
      case 'release':
        await releaseHeldTransfer(domainId, by)
        break
      case 'auth-code': {
        const authCode = str(body.authCode)
        if (!authCode) throw new HlInputError('Paste the new transfer code.')
        if (domain.status !== 'transferring' && domain.status !== 'held') throw new HlInputError('There’s no transfer waiting on a code.')
        await updateTransferAuthCode(name, authCode)
        await log(domainId, by, 'Entered a new transfer code', { lastError: null })
        break
      }
      case 'refresh':
        if (domain.origin === 'external') await verifyExternal(domainId)
        else if (domain.status === 'transferring' || domain.status === 'held') await refreshTransfer(domainId, by)
        else if (domain.status === 'failed' && domain.origin === 'bought') await retryPurchase(domainId, by)
        else await refreshFromRegistrar([domainId])
        break
      default:
        throw new HlInputError('Unknown action.')
    }
    return NextResponse.json({ domain: await prisma.hlDomain.findUnique({ where: { id: domainId } }) })
  } catch (err) {
    return hlError(err, `domain ${domain.name}`)
  }
}

/** DELETE: unlink from this sub-account. The domain stays in the Porkbun account (and can be linked again). */
export async function DELETE(_req: Request, { params }: Ctx) {
  const guard = await hlGuard()
  if (guard instanceof NextResponse) return guard
  const { id, domainId } = await params
  const domain = await load(id, domainId)
  if (!domain) return NextResponse.json({ error: 'Domain not found' }, { status: 404 })
  if (domain.status === 'held' || domain.status === 'transferring' || domain.status === 'pending') {
    return NextResponse.json({ error: 'A purchase or transfer is in progress; wait for it to finish.' }, { status: 400 })
  }
  await prisma.hlDomain.delete({ where: { id: domainId } })
  console.log(`[hell-level] ${guard.email} unlinked ${domain.name} from account ${id}`)
  return NextResponse.json({ ok: true, name: normalizeDomain(domain.name) })
}
