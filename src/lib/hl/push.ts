import { prisma } from '@/lib/prisma'
import { decryptSecret, encryptSecret } from '@/lib/crypto'
import { HlInputError } from './http'
import { HL_MEMBER_ROLE } from './member-access'
import {
  encryptPayload,
  inboxNotification,
  newVapidKeys,
  pushEndpointAllowed,
  subscriptionKeysOk,
  vapidAuthorization,
  type InboxKind,
  type VapidKeys,
} from './push-crypto'

/**
 * Genisys OS notifications (Web Push, like LeadConnector's app): when something new lands in a
 * conversation (a lead's text, a website form or chat, a missed call, an online booking), every
 * phone or browser that turned notifications on for that sub-account buzzes with who and what,
 * and a tap opens the conversation.
 *
 * Who gets them: a contractor's devices for every sub-account they're on; Genisys staff's devices
 * only for the sub-accounts they chose to follow there (Notify me, in the menu). Turned on from
 * the menu or the Dashboard card (src/components/genisys-os/notifications.tsx); the phone's side is
 * public/genisys-os-sw.js. The encryption is push-crypto.ts.
 *
 * The Hub's key pair is made the first time anyone turns notifications on and kept in AppSetting
 * (private half encrypted with VAULT_MASTER_KEY). It must never change: every subscription is
 * tied to it.
 */

const VAPID_SETTING = 'hl.push.vapid'
let keysCache: VapidKeys | null = null

const site = () => (process.env.AUTH_URL || 'https://genisys-hub.onrender.com').replace(/\/+$/, '')

/** A local check (never production) may send to a receiver on this machine. */
const localTest = () => process.env.NODE_ENV !== 'production' && process.env.HL_PUSH_LOCAL_TEST === '1'

const endpointOk = (endpoint: string) => pushEndpointAllowed(endpoint, { localTest: localTest() })

function readKeys(value: string): VapidKeys {
  const v = JSON.parse(value) as { publicKey: string; privateKey: { ciphertext: string; nonce: string } }
  return { publicKey: v.publicKey, privateKey: decryptSecret(Buffer.from(v.privateKey.ciphertext, 'base64'), Buffer.from(v.privateKey.nonce, 'base64')) }
}

/** The Hub's push keys, made once. Two containers racing on the first use both end up with the one that was saved. */
export async function vapidKeys(): Promise<VapidKeys> {
  if (keysCache) return keysCache
  const row = await prisma.appSetting.findUnique({ where: { key: VAPID_SETTING } })
  if (row) return (keysCache = readKeys(row.value))
  const fresh = newVapidKeys()
  const sealed = encryptSecret(fresh.privateKey)
  const value = JSON.stringify({
    publicKey: fresh.publicKey,
    privateKey: { ciphertext: Buffer.from(sealed.ciphertext).toString('base64'), nonce: Buffer.from(sealed.nonce).toString('base64') },
    createdAt: new Date().toISOString(),
  })
  try {
    await prisma.appSetting.create({ data: { key: VAPID_SETTING, value } })
    console.log('[genisys-os] made the push key pair')
    return (keysCache = fresh)
  } catch {
    const again = await prisma.appSetting.findUniqueOrThrow({ where: { key: VAPID_SETTING } })
    return (keysCache = readKeys(again.value))
  }
}

export type PushDevice = { endpoint: string; p256dh: string; auth: string }

/** Is this device on for this person (and, for staff, this sub-account)? With the key a browser subscribes with. */
export async function pushStatus(o: { userId: string; endpoint: string | null; accountId: string | null }): Promise<{ publicKey: string; on: boolean }> {
  const { publicKey } = await vapidKeys()
  if (!o.endpoint) return { publicKey, on: false }
  const row = await prisma.hlPushSubscription.findUnique({ where: { endpoint: o.endpoint }, select: { userId: true, accountIds: true } })
  const on = !!row && row.userId === o.userId && (row.accountIds.length === 0 || (!!o.accountId && row.accountIds.includes(o.accountId)))
  return { publicKey, on }
}

/**
 * Turn a device on. A contractor's covers all their sub-accounts; staff add `follow` to the ones
 * the device covers. A device that was someone else's (a shared phone, a new sign-in) stops
 * getting the last person's leads. `replaces`: the browser renewed its subscription (the service
 * worker's pushsubscriptionchange), so the old row's follows carry over.
 */
export async function savePushDevice(o: { userId: string; staff: boolean; device: PushDevice; follow: string | null; replaces: string | null; userAgent: string | null }): Promise<void> {
  const { endpoint, p256dh, auth } = o.device
  if (!endpointOk(endpoint)) throw new HlInputError('That isn’t a browser notification address Genisys OS can send to.')
  if (!subscriptionKeysOk(p256dh, auth)) throw new HlInputError('The browser sent keys Genisys OS can’t encrypt to.')
  if (o.staff && !o.follow && !o.replaces) throw new HlInputError('Pick the sub-account to be notified about.')
  const [row, old] = await Promise.all([
    prisma.hlPushSubscription.findUnique({ where: { endpoint } }),
    o.replaces && o.replaces !== endpoint ? prisma.hlPushSubscription.findUnique({ where: { endpoint: o.replaces } }) : null,
  ])
  const mine = (r: typeof row) => (r && r.userId === o.userId ? r.accountIds : [])
  const accountIds = o.staff ? [...new Set([...mine(row), ...mine(old), ...(o.follow ? [o.follow] : [])])] : []
  const data = { userId: o.userId, p256dh, auth, accountIds, userAgent: o.userAgent?.slice(0, 300) ?? null, failures: 0 }
  await prisma.hlPushSubscription.upsert({ where: { endpoint }, create: { endpoint, ...data }, update: data })
  if (old && old.userId === o.userId) await prisma.hlPushSubscription.delete({ where: { id: old.id } }).catch(() => undefined)
}

/** Turn a device off: staff stop following one sub-account there (the row goes with the last); otherwise the row goes. */
export async function removePushDevice(o: { userId: string; endpoint: string; unfollow: string | null }): Promise<void> {
  const row = await prisma.hlPushSubscription.findUnique({ where: { endpoint: o.endpoint } })
  if (!row || row.userId !== o.userId) return
  if (o.unfollow) {
    const left = row.accountIds.filter((id) => id !== o.unfollow)
    if (left.length) {
      await prisma.hlPushSubscription.update({ where: { id: row.id }, data: { accountIds: left } })
      return
    }
  }
  await prisma.hlPushSubscription.delete({ where: { id: row.id } }).catch(() => undefined)
}

type InboxContact = { id: string; accountId: string; firstName: string | null; lastName: string | null; phone: string | null; email: string | null }

/**
 * Something new in this contact's conversation: buzz everyone's phones for the sub-account. Called
 * right where a conversation turns unread (a text, an email, a form / chat / booking line, a missed
 * call), so it never waits on the push services and never throws.
 */
export function notifyInbox(contact: InboxContact, kind: InboxKind, text: string): void {
  void sendInbox(contact, kind, text).catch((err) => console.warn('[genisys-os] notification failed:', err instanceof Error ? err.message : err))
}

async function sendInbox(contact: InboxContact, kind: InboxKind, text: string): Promise<void> {
  const devices = await prisma.hlPushSubscription.findMany({
    where: {
      OR: [
        { accountIds: { has: contact.accountId } },
        { accountIds: { isEmpty: true }, user: { role: HL_MEMBER_ROLE, hlMemberships: { some: { accountId: contact.accountId } } } },
      ],
    },
  })
  if (!devices.length) return
  const account = await prisma.hlAccount.findUnique({ where: { id: contact.accountId }, select: { archivedAt: true } })
  if (!account || account.archivedAt) return
  // The badge on the app's icon: conversations waiting, as the bell counts them.
  const unread = await prisma.hlContact.count({ where: { accountId: contact.accountId, unread: { gt: 0 } } })
  const payload = Buffer.from(JSON.stringify(inboxNotification({ accountId: contact.accountId, contact, kind, text, unread })))
  const keys = await vapidKeys()
  await Promise.all(devices.map((d) => deliver(d, payload, keys)))
}

async function deliver(d: { id: string; endpoint: string; p256dh: string; auth: string; failures: number }, payload: Buffer, keys: VapidKeys): Promise<void> {
  const host = (() => {
    try {
      return new URL(d.endpoint).host
    } catch {
      return 'a bad address'
    }
  })()
  if (!endpointOk(d.endpoint)) {
    await prisma.hlPushSubscription.delete({ where: { id: d.id } }).catch(() => undefined)
    return
  }
  let status = 0
  let detail = ''
  try {
    const res = await fetch(d.endpoint, {
      method: 'POST',
      headers: {
        TTL: '86400',
        Urgency: 'high',
        'Content-Encoding': 'aes128gcm',
        'Content-Type': 'application/octet-stream',
        Authorization: vapidAuthorization(d.endpoint, keys, site()),
      },
      body: new Uint8Array(encryptPayload(payload, d)),
      // A push service answers; it never sends us elsewhere.
      redirect: 'error',
      signal: AbortSignal.timeout(10_000),
    })
    status = res.status
    if (!res.ok) detail = (await res.text().catch(() => '')).slice(0, 200)
  } catch (err) {
    detail = err instanceof Error ? err.message : String(err)
  }
  if (status >= 200 && status < 300) {
    await prisma.hlPushSubscription.update({ where: { id: d.id }, data: { failures: 0, lastSentAt: new Date() } }).catch(() => undefined)
    return
  }
  // 404/410: the browser unsubscribed, or the app was removed. Five failures in a row: the same, in effect.
  const gone = status === 404 || status === 410 || d.failures + 1 >= 5
  console.warn(`[genisys-os] notification to ${host} failed (${status || 'no answer'})${detail ? `: ${detail}` : ''}${gone ? ' - device dropped' : ''}`)
  if (gone) await prisma.hlPushSubscription.delete({ where: { id: d.id } }).catch(() => undefined)
  else await prisma.hlPushSubscription.update({ where: { id: d.id }, data: { failures: { increment: 1 } } }).catch(() => undefined)
}
