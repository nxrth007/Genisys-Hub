'use client'

import Link from 'next/link'
import { useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { signIn, signOut } from 'next-auth/react'
import { ArrowRight, Eye, EyeOff } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Embers } from './enter-splash'
import { WhiteFire } from './white-fire'
import s from './enter-splash.module.css'

/**
 * /login (contractors' sign-in, src/lib/hl/logins.ts) and /login/password
 * (choosing a password from an invite or reset link): Hell-level's entrance
 * with a form where its button was. Getting in plays the entrance's exit,
 * and the CRM comes up out of the white (ArrivalGate, enter-splash.tsx).
 */

const TITLE = 'Hell-level'
/** When the white-out covers the screen: the CRM route swaps in under it (as the entrance). */
const SWAP_MS = 860
const TOO_MANY = 'Too many tries. Wait a few minutes and try again.'

const reduceMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches

/** Where to go once in: back where they were headed in Hell-level, else its front door. Never off the site. */
function landing(callbackUrl: string | null, arrive: boolean): string {
  const url = new URL('/hell-level', window.location.origin)
  if (callbackUrl) {
    try {
      const want = new URL(callbackUrl, window.location.origin)
      if (want.pathname === '/hell-level' || want.pathname.startsWith('/hell-level/')) {
        url.pathname = want.pathname
        url.search = want.search
      }
    } catch {
      // not a URL: the front door
    }
  }
  if (arrive) {
    url.searchParams.delete('enter')
    url.searchParams.set('arrive', '1')
  }
  return `${url.pathname}${url.search}`
}

/** The exit, then the CRM under the white. */
function useLeave() {
  const router = useRouter()
  const [leaving, setLeaving] = useState(false)
  const timer = useRef(0)
  useEffect(() => () => window.clearTimeout(timer.current), [])
  const leave = (to: string) => {
    setLeaving(true)
    timer.current = window.setTimeout(() => router.replace(to), reduceMotion() ? 0 : SWAP_MS)
  }
  return { leaving, leave }
}

function LoginFrame({ leaving, line, children }: { leaving: boolean; line: string; children: React.ReactNode }) {
  // The fire and embers read it every frame.
  const leavingRef = useRef(false)
  useEffect(() => {
    leavingRef.current = leaving
  }, [leaving])
  return (
    <div className={cn(s.root, s.loginRoot, leaving && s.leaving)}>
      <div className={s.art} aria-hidden>
        <div className={s.artInner}>
          <WhiteFire leaving={leavingRef} className={s.fire} />
        </div>
      </div>
      <div className={s.vignette} />
      <div className={s.shade} />
      <Embers leaving={leavingRef} />

      <div className={s.hud}>
        <span className={s.hudMark}>
          <i /> Genisys // Hell-level
        </span>
        <span className={s.status}>
          <i /> System online
        </span>
      </div>

      <main className={s.copy}>
        <div className={s.sys}>
          <span className={s.sysLabel}>
            <i /> System
          </span>
          <span className={s.typed} style={{ '--chars': line.length } as React.CSSProperties}>
            {line}
          </span>
        </div>
        <div className={s.titleWrap}>
          <h1 className={s.title} aria-label={TITLE}>
            {[...TITLE].map((ch, i) => (
              <span key={i} className={s.char} style={{ animationDelay: `${0.3 + i * 0.045}s` }} aria-hidden>
                {ch}
              </span>
            ))}
          </h1>
          <p className={s.ghost} aria-hidden>
            {TITLE}
          </p>
        </div>
        <p className={s.sub}>Genisys CRM</p>
        {children}
      </main>

      <p className={s.credit}>
        Created by <b>@Nxrth</b>
      </p>
      <span className={s.arise} aria-hidden>
        Arise
      </span>
      <div className={s.flash} />
      <div className={s.grain} />
      <div className={s.scan} />
    </div>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className={s.field}>
      <span className={s.label}>{label}</span>
      {children}
    </label>
  )
}

function PasswordInput({ value, onChange, autoComplete, autoFocus }: { value: string; onChange: (v: string) => void; autoComplete: string; autoFocus?: boolean }) {
  const [show, setShow] = useState(false)
  return (
    <span className={s.inputWrap}>
      <input
        className={s.input}
        type={show ? 'text' : 'password'}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        autoComplete={autoComplete}
        autoFocus={autoFocus}
        required
      />
      <button type="button" className={s.reveal} onClick={() => setShow((v) => !v)} aria-label={show ? 'Hide password' : 'Show password'}>
        {show ? <EyeOff strokeWidth={1.75} /> : <Eye strokeWidth={1.75} />}
      </button>
    </span>
  )
}

function Submit({ busy, label, busyLabel }: { busy: boolean; label: string; busyLabel: string }) {
  return (
    <div className={s.actions}>
      <span className={s.btnWrap}>
        <button type="submit" className={s.btn} disabled={busy}>
          <span className={s.btnLabel}>{busy ? busyLabel : label}</span>
          <ArrowRight className={s.btnArrow} strokeWidth={1.75} />
        </button>
      </span>
    </div>
  )
}

/** /login: email and password, or "Forgot password?" for a link to choose a new one. */
export function SignInForm({ callbackUrl, forgot, notice, signOutFirst }: { callbackUrl: string | null; forgot: boolean; notice: string | null; signOutFirst: boolean }) {
  const { leaving, leave } = useLeave()
  const [mode, setMode] = useState<'signin' | 'forgot' | 'sent'>(forgot ? 'forgot' : 'signin')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(notice)

  // Signed in with nowhere left to go (their sub-account was archived): start clean.
  useEffect(() => {
    if (signOutFirst) void signOut({ redirect: false })
  }, [signOutFirst])

  const go = (m: typeof mode) => {
    setMode(m)
    setError(null)
  }

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (busy || leaving) return
    setBusy(true)
    setError(null)
    if (mode === 'forgot') {
      const r = await fetch('/api/hl/public/login/forgot', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email }) }).catch(() => null)
      setBusy(false)
      if (r?.status === 429) return setError(TOO_MANY)
      if (!r?.ok) return setError('That didn’t go through. Check your connection and try again.')
      return go('sent')
    }
    const res = await signIn('credentials', { email, password, redirect: false }).catch(() => null)
    if (!res || res.error) {
      setBusy(false)
      setError(
        res?.code === 'rate_limited'
          ? 'Too many tries. Wait 15 minutes, or reset your password.'
          : res?.code === 'no_account'
            ? 'Your login isn’t on a sub-account anymore. Ask Genisys to add you back.'
            : 'That email and password don’t match.',
      )
      return
    }
    leave(landing(callbackUrl, true))
  }

  return (
    <LoginFrame leaving={leaving} line="Sign in to continue.">
      <form className={s.form} onSubmit={submit}>
        {mode === 'signin' && (
          <>
            <Field label="Email">
              <input className={s.input} type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="username" autoFocus required />
            </Field>
            <Field label="Password">
              <PasswordInput value={password} onChange={setPassword} autoComplete="current-password" />
            </Field>
            <div className={s.formRow}>
              <button type="button" className={s.textBtn} onClick={() => go('forgot')}>
                Forgot password?
              </button>
            </div>
            {error && (
              <p className={s.error} role="alert">
                {error}
              </p>
            )}
            <Submit busy={busy || leaving} label="Sign in" busyLabel="Signing in…" />
          </>
        )}
        {mode === 'forgot' && (
          <>
            <p className={s.note}>Enter the email you sign in with. We’ll send a link to choose a new password.</p>
            <Field label="Email">
              <input className={s.input} type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="username" autoFocus required />
            </Field>
            {error && (
              <p className={s.error} role="alert">
                {error}
              </p>
            )}
            <Submit busy={busy} label="Send reset link" busyLabel="Sending…" />
            <div>
              <button type="button" className={s.textBtn} onClick={() => go('signin')}>
                ← Back to sign in
              </button>
            </div>
          </>
        )}
        {mode === 'sent' && (
          <>
            <p className={s.note}>
              If <b>{email}</b> has a login, a link to choose a new password is on its way by email (and a text, when we have your number). It works for an hour.
            </p>
            <div>
              <button type="button" className={s.textBtn} onClick={() => go('signin')}>
                ← Back to sign in
              </button>
            </div>
          </>
        )}
      </form>
      {mode === 'signin' && (
        <p className={s.alt}>
          Genisys team?
          <button type="button" className={s.textBtn} onClick={() => void signIn('google', { callbackUrl: landing(callbackUrl, false) })}>
            Continue with Google
          </button>
        </p>
      )}
    </LoginFrame>
  )
}

/** /login/password?u=&t=: choose a password from an invite or reset link, then straight in. */
export function SetPasswordForm({ u, t }: { u: string; t: string }) {
  const { leaving, leave } = useLeave()
  const [check, setCheck] = useState<{ email: string } | { error: string } | null>(null)
  const [password, setPassword] = useState('')
  const [again, setAgain] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    const q = new URLSearchParams({ u, t })
    void fetch(`/api/hl/public/login/password?${q}`)
      .then(async (r) => {
        const body = (await r.json().catch(() => ({}))) as { email?: string; error?: string }
        setCheck(r.ok && body.email ? { email: body.email } : { error: r.status === 429 ? TOO_MANY : body.error || 'This link didn’t work.' })
      })
      .catch(() => setCheck({ error: 'That didn’t load. Check your connection and refresh.' }))
  }, [u, t])

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (busy || leaving || !check || !('email' in check)) return
    if (password.length < 8) return setError('Use at least 8 characters.')
    if (password !== again) return setError('Those two don’t match.')
    setBusy(true)
    setError(null)
    const r = await fetch('/api/hl/public/login/password', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ u, t, password }) }).catch(() => null)
    const body = (await r?.json().catch(() => ({}))) as { email?: string; error?: string } | undefined
    if (!r?.ok || !body?.email) {
      setBusy(false)
      return setError(r?.status === 429 ? TOO_MANY : body?.error || 'That didn’t go through. Check your connection and try again.')
    }
    setSaved(true)
    const res = await signIn('credentials', { email: body.email, password, redirect: false }).catch(() => null)
    if (!res || res.error) {
      setBusy(false)
      return setError('Your password is saved. Sign in with it on the sign-in page.')
    }
    leave(landing(null, true))
  }

  return (
    <LoginFrame leaving={leaving} line="Choose your password.">
      <form className={s.form} onSubmit={submit}>
        {!check ? (
          <p className={s.note}>Checking your link…</p>
        ) : 'error' in check ? (
          <>
            <p className={s.error} role="alert">
              {check.error}
            </p>
            <div>
              <Link href="/login?forgot=1" className={s.textBtn}>
                Send me a new link →
              </Link>
            </div>
          </>
        ) : (
          <>
            <p className={s.note}>
              For <b>{check.email}</b>. At least 8 characters; you’ll sign in with it from now on.
            </p>
            {/* For password managers: which login this password belongs to. */}
            <input type="email" value={check.email} autoComplete="username" readOnly hidden />
            <Field label="New password">
              <PasswordInput value={password} onChange={setPassword} autoComplete="new-password" autoFocus />
            </Field>
            <Field label="Type it again">
              <PasswordInput value={again} onChange={setAgain} autoComplete="new-password" />
            </Field>
            {error && (
              <p className={s.error} role="alert">
                {error}
              </p>
            )}
            {saved && error ? (
              <div>
                <Link href="/login" className={s.textBtn}>
                  Go to sign in →
                </Link>
              </div>
            ) : (
              <Submit busy={busy || leaving} label="Save and sign in" busyLabel="Saving…" />
            )}
          </>
        )}
      </form>
    </LoginFrame>
  )
}
