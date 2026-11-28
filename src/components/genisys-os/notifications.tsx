'use client'

import { useCallback, useEffect, useState, useSyncExternalStore } from 'react'
import { Bell, BellOff, BellRing, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { isIos, useInstallCardShowing, useTouchScreen } from './phone-app'
import { Button, Toggle } from './ui'

/**
 * Genisys OS notifications on this phone or browser (src/lib/hl/push.ts sends them; the service
 * worker shows them): the switch in the menu, the Dashboard card that offers them, the number on
 * the app's icon, and forgetting the device on sign-out.
 *
 * A contractor's switch covers all their sub-accounts. Genisys staff switch on one sub-account at a
 * time ("Notify me about X"), so nobody hears about every client by accident.
 */

const SW = '/genisys-os-sw.js'
const SCOPE = '/genisys-os'
/** Fired when a switch changes, so the menu's and the card's agree. */
const CHANGED = 'gos-push-changed'

export type PushState = 'loading' | 'unsupported' | 'needs-install' | 'blocked' | 'off' | 'on'

const supported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window
const standalone = () => window.matchMedia('(display-mode: standalone)').matches || (navigator as Navigator & { standalone?: boolean }).standalone === true

/** The app's service worker, running (registered here if this page hasn't yet). */
async function worker(): Promise<ServiceWorkerRegistration> {
  const reg = await navigator.serviceWorker.register(SW, { scope: SCOPE })
  if (reg.active) return reg
  const w = reg.installing || reg.waiting
  if (w)
    await new Promise<void>((resolve) => {
      const done = () => (w.state === 'activated' || w.state === 'redundant') && resolve()
      w.addEventListener('statechange', done)
      done()
    })
  return reg
}

function keyBytes(b64url: string): Uint8Array<ArrayBuffer> {
  const b64 = b64url.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (b64url.length % 4)) % 4)
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
}

const sameKey = (a: ArrayBuffer | null | undefined, b: Uint8Array) => !!a && a.byteLength === b.length && new Uint8Array(a).every((x, i) => x === b[i])

async function api<T>(method: 'GET' | 'POST' | 'DELETE', o: { query?: Record<string, string>; body?: object } = {}): Promise<T> {
  const res = await fetch(`/api/hl/push${o.query ? `?${new URLSearchParams(o.query)}` : ''}`, {
    method,
    ...(o.body ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(o.body) } : {}),
  })
  const data = (await res.json().catch(() => ({}))) as T & { error?: string }
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`)
  return data
}

async function readState(accountId: string | null, staff: boolean): Promise<PushState> {
  if (!supported()) return isIos() && !standalone() ? 'needs-install' : 'unsupported'
  if (Notification.permission === 'denied') return 'blocked'
  // Only reading: no registering here.
  const reg = await navigator.serviceWorker.getRegistration(SCOPE)
  const sub = await reg?.pushManager.getSubscription()
  if (!sub) return 'off'
  const s = await api<{ on: boolean }>('GET', { query: { endpoint: sub.endpoint, ...(staff && accountId ? { accountId } : {}) } })
  return s.on ? 'on' : 'off'
}

const friendly = (err: unknown) => {
  const name = err instanceof DOMException ? err.name : ''
  if (name === 'NotAllowedError') return 'Notifications are blocked for this site in the browser’s settings.'
  if (name === 'AbortError' || name === 'NotSupportedError' || /push service/i.test(String(err))) return 'This browser can’t receive notifications.'
  return err instanceof Error ? err.message : 'That didn’t work. Try again.'
}

/** This device's notifications for the sub-account (staff) or for all of the login's (contractor). */
export function usePush(accountId: string | null, staff: boolean) {
  const [state, setState] = useState<PushState>('loading')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [version, setVersion] = useState(0)

  useEffect(() => {
    let live = true
    readState(accountId, staff)
      .then((s) => live && setState(s))
      .catch(() => live && setState('off'))
    return () => {
      live = false
    }
  }, [accountId, staff, version])

  useEffect(() => {
    const again = () => setVersion((v) => v + 1)
    window.addEventListener(CHANGED, again)
    return () => window.removeEventListener(CHANGED, again)
  }, [])

  const turnOn = useCallback(async () => {
    setBusy(true)
    setError(null)
    try {
      // First thing in the tap: iPhones only ask while the tap is still fresh.
      const permission = await Notification.requestPermission()
      if (permission !== 'granted') {
        setState(permission === 'denied' ? 'blocked' : 'off')
        window.dispatchEvent(new Event(CHANGED))
        return
      }
      const reg = await worker()
      const { publicKey } = await api<{ publicKey: string }>('GET')
      const key = keyBytes(publicKey)
      let sub = await reg.pushManager.getSubscription()
      if (sub && !sameKey(sub.options.applicationServerKey, key)) {
        await sub.unsubscribe()
        sub = null
      }
      sub ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key })
      const json = sub.toJSON()
      await api('POST', { body: { endpoint: json.endpoint, keys: json.keys, accountId: staff ? accountId : null } })
      setState('on')
      window.dispatchEvent(new Event(CHANGED))
    } catch (err) {
      setError(friendly(err))
    } finally {
      setBusy(false)
    }
  }, [accountId, staff])

  const turnOff = useCallback(async () => {
    setBusy(true)
    setError(null)
    try {
      const reg = await navigator.serviceWorker.getRegistration(SCOPE)
      const sub = await reg?.pushManager.getSubscription()
      if (sub) {
        await api('DELETE', { body: { endpoint: sub.endpoint, accountId: staff ? accountId : null } })
        // A contractor's device is off altogether; staff may still follow other sub-accounts on it.
        if (!staff) await sub.unsubscribe().catch(() => undefined)
      }
      setState('off')
      window.dispatchEvent(new Event(CHANGED))
    } catch (err) {
      setError(friendly(err))
    } finally {
      setBusy(false)
    }
  }, [accountId, staff])

  return { state, busy, error, turnOn, turnOff }
}

/** The menu's switch (desktop sidebar and the phone's slide-in menu). Nothing where a browser can't do notifications. */
export function NotifySwitch({ accountId, accountName, staff, roomy }: { accountId: string; accountName: string | null; staff: boolean; roomy?: boolean }) {
  const p = usePush(accountId, staff)
  if (p.state === 'loading' || p.state === 'unsupported') return null
  const label = staff ? `Notify me: ${accountName ?? 'this sub-account'}` : 'Notifications'
  const hint =
    p.error ??
    (p.state === 'needs-install'
      ? 'Add Genisys OS to your Home Screen to turn these on.'
      : p.state === 'blocked'
        ? 'Blocked for this site in the browser’s settings.'
        : p.state === 'on'
          ? 'On for this device.'
          : 'New texts, leads and missed calls on this device.')
  const Icon = p.state === 'on' ? Bell : BellOff
  return (
    <div className={cn('flex items-center gap-2.5 rounded-md px-2.5', roomy ? 'py-2' : 'py-1.5')}>
      <Icon className={cn('h-[15px] w-[15px] shrink-0', p.state === 'on' ? 'text-primary' : 'text-muted-foreground')} strokeWidth={1.75} />
      <span className="min-w-0 flex-1">
        <span className={cn('block truncate font-mono text-foreground/80', roomy ? 'text-[14px]' : 'text-[12.5px]')}>{label}</span>
        <span className={cn('block leading-snug', p.error ? 'text-destructive' : 'text-muted-foreground', roomy ? 'text-[12px]' : 'text-[11px]')}>{hint}</span>
      </span>
      {(p.state === 'on' || p.state === 'off') && <Toggle checked={p.state === 'on'} disabled={p.busy} onChange={(v) => void (v ? p.turnOn() : p.turnOff())} label={label} />}
    </div>
  )
}

const DISMISSED = 'gos-notify-dismissed'
const dismissedStore = {
  subscribe: (cb: () => void) => {
    window.addEventListener(DISMISSED, cb)
    return () => window.removeEventListener(DISMISSED, cb)
  },
  get: () => {
    try {
      return localStorage.getItem(DISMISSED) === '1'
    } catch {
      return false
    }
  },
}

/**
 * The Dashboard's offer, on a phone, once the app is on the home screen (or the install card was
 * waved away), and only if the browser has never been asked: one tap turns notifications on.
 */
export function NotifyCard({ accountId, staff }: { accountId: string; staff: boolean }) {
  const touch = useTouchScreen()
  const installShowing = useInstallCardShowing()
  const dismissed = useSyncExternalStore(dismissedStore.subscribe, dismissedStore.get, () => true)
  const p = usePush(accountId, staff)
  if (!touch || installShowing || dismissed || p.state !== 'off' || Notification.permission !== 'default') return null
  const dismiss = () => {
    try {
      localStorage.setItem(DISMISSED, '1')
    } catch {
      // private mode: it comes back next visit
    }
    window.dispatchEvent(new Event(DISMISSED))
  }
  return (
    <div className="mx-3 mt-3 flex items-start gap-3 rounded-xl border border-border bg-card px-3.5 py-3 md:hidden">
      <span className="grid h-10 w-10 shrink-0 place-items-center rounded-[10px] bg-primary-soft text-primary">
        <BellRing className="h-5 w-5" />
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-[14px] font-semibold leading-snug text-foreground">Know the moment a lead reaches out</p>
        <p className="mt-0.5 text-[13px] leading-snug text-muted-foreground">Get a notification on this phone when a lead texts, fills your website form or chat, or calls and misses you.</p>
        {p.error && <p className="mt-1 text-[12.5px] text-destructive">{p.error}</p>}
        <Button size="sm" variant="primary" className="mt-2.5" loading={p.busy} onClick={() => void p.turnOn()}>
          Turn on notifications
        </Button>
      </div>
      <button type="button" onClick={dismiss} aria-label="Hide" className="-mr-1.5 -mt-1 grid h-9 w-9 shrink-0 place-items-center rounded-md text-muted-foreground active:bg-foreground/[0.06]">
        <X className="h-4 w-4" />
      </button>
    </div>
  )
}

type Badging = Navigator & { setAppBadge?: (n?: number) => Promise<void>; clearAppBadge?: () => Promise<void> }

/** The number on the app's home-screen icon: conversations waiting (a contractor's; staff see every client, so none). */
export function useAppBadge(count: number | null) {
  useEffect(() => {
    const nav = navigator as Badging
    if (count === null || !nav.setAppBadge || !nav.clearAppBadge) return
    void (count > 0 ? nav.setAppBadge(count) : nav.clearAppBadge()).catch(() => undefined)
  }, [count])
}

/**
 * Signing out: this device stops getting this login's notifications (the next person to sign in on
 * the phone shouldn't see the last one's leads). Gives up after 3 seconds so signing out never hangs.
 */
export async function forgetThisDevice(): Promise<void> {
  const forget = async () => {
    if (!('serviceWorker' in navigator)) return
    const reg = await navigator.serviceWorker.getRegistration(SCOPE)
    const sub = await reg?.pushManager?.getSubscription()
    if (!sub) return
    await api('DELETE', { body: { endpoint: sub.endpoint } }).catch(() => undefined)
    await sub.unsubscribe().catch(() => undefined)
    await (navigator as Badging).clearAppBadge?.().catch(() => undefined)
  }
  await Promise.race([forget().catch(() => undefined), new Promise((r) => setTimeout(r, 3000))])
}
