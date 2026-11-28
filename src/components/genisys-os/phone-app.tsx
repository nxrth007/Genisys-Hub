'use client'

import { useEffect, useState, useSyncExternalStore } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { Share, X } from 'lucide-react'
import { Button } from './ui'

/**
 * Genisys OS on a phone, as an app (app-meta.ts has the manifest side): the service worker, the
 * keyboard, coming back from the background, and the "put it on your home screen" card.
 */

/** Registers public/genisys-os-sw.js (an offline screen; it's also what makes Chrome offer "Install"). */
export function PhoneAppWorker() {
  useEffect(() => {
    if (!('serviceWorker' in navigator)) return
    navigator.serviceWorker.register('/genisys-os-sw.js', { scope: '/genisys-os' }).catch(() => undefined)
  }, [])
  return null
}

const never = () => () => {}

function media(query: string) {
  return {
    subscribe: (cb: () => void) => {
      const m = window.matchMedia(query)
      m.addEventListener('change', cb)
      return () => m.removeEventListener('change', cb)
    },
    get: () => window.matchMedia(query).matches,
  }
}
const coarse = media('(pointer: coarse)')
const phoneWidth = media('(max-width: 639px)')
const standaloneMode = media('(display-mode: standalone)')

/** A touch screen (a phone or tablet), not a mouse. False on the server and while hydrating. */
export function useTouchScreen(): boolean {
  return useSyncExternalStore(coarse.subscribe, coarse.get, () => false)
}

/** A phone-width screen (under 640px). False on the server and while hydrating. */
export function usePhoneWidth(): boolean {
  return useSyncExternalStore(phoneWidth.subscribe, phoneWidth.get, () => false)
}

/** Opened from the home screen, not in a browser tab. */
function useStandalone(): boolean {
  const display = useSyncExternalStore(standaloneMode.subscribe, standaloneMode.get, () => false)
  // iPhones before iOS 16.4 only say so here.
  const ios = useSyncExternalStore(never, () => (navigator as Navigator & { standalone?: boolean }).standalone === true, () => false)
  return display || ios
}

const isIos = () => /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)

/** Fields that bring up the keyboard (not checkboxes, pickers or buttons). */
function typesText(el: Element | null): boolean {
  if (!el) return false
  if (el instanceof HTMLTextAreaElement) return true
  if (el instanceof HTMLElement && el.isContentEditable) return true
  return el instanceof HTMLInputElement && ['text', 'email', 'tel', 'number', 'search', 'url', 'password'].includes(el.type)
}

/**
 * The shell's phone behaviour:
 * - The page doesn't rubber-band (html.gos-root in globals.css).
 * - iPhones don't shrink the page for the keyboard, so the app sizes itself to what's still visible
 *   (--gos-vh / --gos-vt, used on touch screens only), and the message box sits right on the keyboard.
 * - While typing, the bottom tab bar steps aside (html.gos-typing).
 * - Back from the background after half a minute: Genisys OS's lists load fresh.
 */
export function PhoneAppEffects() {
  const qc = useQueryClient()
  useEffect(() => {
    const root = document.documentElement
    root.classList.add('gos-root')

    const vv = window.visualViewport
    const fit = () => {
      if (!vv) return
      // Pinched in to read something: leave the page as it is.
      if (vv.scale > 1.01) {
        root.style.removeProperty('--gos-vh')
        root.style.removeProperty('--gos-vt')
        return
      }
      root.style.setProperty('--gos-vh', `${Math.round(vv.height)}px`)
      root.style.setProperty('--gos-vt', `${Math.round(vv.offsetTop)}px`)
    }
    fit()
    vv?.addEventListener('resize', fit)
    vv?.addEventListener('scroll', fit)

    const onFocusIn = (e: FocusEvent) => {
      if (typesText(e.target as Element)) root.classList.add('gos-typing')
    }
    // Focus moving from one field to the next shouldn't flash the tab bar back in between.
    const onFocusOut = () => requestAnimationFrame(() => !typesText(document.activeElement) && root.classList.remove('gos-typing'))
    document.addEventListener('focusin', onFocusIn)
    document.addEventListener('focusout', onFocusOut)

    let hiddenAt = 0
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') hiddenAt = Date.now()
      else if (hiddenAt && Date.now() - hiddenAt > 30_000) void qc.invalidateQueries({ queryKey: ['hl'] })
    }
    document.addEventListener('visibilitychange', onVisibility)

    return () => {
      root.classList.remove('gos-root', 'gos-typing')
      root.style.removeProperty('--gos-vh')
      root.style.removeProperty('--gos-vt')
      vv?.removeEventListener('resize', fit)
      vv?.removeEventListener('scroll', fit)
      document.removeEventListener('focusin', onFocusIn)
      document.removeEventListener('focusout', onFocusOut)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [qc])
  return null
}

const DISMISSED_KEY = 'gos-install-dismissed'
const dismissedStore = {
  subscribe: (cb: () => void) => {
    window.addEventListener(DISMISSED_KEY, cb)
    window.addEventListener('storage', cb)
    return () => {
      window.removeEventListener(DISMISSED_KEY, cb)
      window.removeEventListener('storage', cb)
    }
  },
  get: () => {
    try {
      return localStorage.getItem(DISMISSED_KEY) === '1'
    } catch {
      return false
    }
  },
}

type InstallPrompt = Event & { prompt: () => Promise<void>; userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }> }

/**
 * "Put Genisys OS on your home screen", on a phone's browser until it's installed or waved away:
 * Chrome on Android gets an Install button (its own prompt), iPhones the Share → Add to Home Screen
 * steps (Safari has no prompt to offer).
 */
export function InstallHint() {
  const touch = useTouchScreen()
  const standalone = useStandalone()
  const dismissed = useSyncExternalStore(dismissedStore.subscribe, dismissedStore.get, () => true)
  const ios = useSyncExternalStore(never, isIos, () => false)
  const [prompt, setPrompt] = useState<InstallPrompt | null>(null)

  useEffect(() => {
    const onPrompt = (e: Event) => {
      // Waved away before: Chrome may still offer its own.
      if (dismissedStore.get()) return
      e.preventDefault()
      setPrompt(e as InstallPrompt)
    }
    const onInstalled = () => setPrompt(null)
    window.addEventListener('beforeinstallprompt', onPrompt)
    window.addEventListener('appinstalled', onInstalled)
    return () => {
      window.removeEventListener('beforeinstallprompt', onPrompt)
      window.removeEventListener('appinstalled', onInstalled)
    }
  }, [])

  const dismiss = () => {
    try {
      localStorage.setItem(DISMISSED_KEY, '1')
    } catch {
      // private mode: it comes back next visit
    }
    window.dispatchEvent(new Event(DISMISSED_KEY))
  }

  if (!touch || standalone || dismissed) return null
  return (
    <div className="mx-3 mt-3 flex items-start gap-3 rounded-xl border border-border bg-card px-3.5 py-3 md:hidden">
      {/* eslint-disable-next-line @next/next/no-img-element -- a fixed 40px icon from public/ */}
      <img src="/icons/genisys-os-192.png" alt="" width={40} height={40} className="h-10 w-10 shrink-0 rounded-[10px]" />
      <div className="min-w-0 flex-1">
        <p className="text-[14px] font-semibold leading-snug text-foreground">Put Genisys OS on your home screen</p>
        <p className="mt-0.5 text-[13px] leading-snug text-muted-foreground">
          {prompt ? (
            'It opens full screen like an app, one tap from your home screen.'
          ) : ios ? (
            <>
              In Safari, tap Share <Share className="inline h-3.5 w-3.5 -translate-y-px" aria-label="the Share button" />, then <b className="font-medium text-foreground/90">Add to Home Screen</b>.
            </>
          ) : (
            <>
              Open your browser’s menu and tap <b className="font-medium text-foreground/90">Add to Home screen</b> (or <b className="font-medium text-foreground/90">Install app</b>).
            </>
          )}
        </p>
        {prompt && (
          <Button
            size="sm"
            variant="primary"
            className="mt-2.5"
            onClick={() => {
              void prompt.prompt()
              void prompt.userChoice.then((c) => {
                setPrompt(null)
                if (c.outcome === 'accepted') dismiss()
              })
            }}
          >
            Install
          </Button>
        )}
      </div>
      <button type="button" onClick={dismiss} aria-label="Hide" className="-mr-1.5 -mt-1 grid h-9 w-9 shrink-0 place-items-center rounded-md text-muted-foreground active:bg-foreground/[0.06]">
        <X className="h-4 w-4" />
      </button>
    </div>
  )
}
