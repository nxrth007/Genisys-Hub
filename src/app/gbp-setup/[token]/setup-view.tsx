'use client'

import { useState } from 'react'
import { Check, Copy, ExternalLink, Loader2 } from 'lucide-react'
import type { GbpField } from '@/lib/gbp-kit'
import type { PublicSetup } from '@/lib/gbp-setup'

const BLANK = /⟦([^⟧]+)⟧/g
const forCopy = (t: string) => t.replace(BLANK, (_m, l: string) => `[${l}]`)

/** The client-facing page: plain, phone-friendly, every answer one tap to copy. */
export function SetupView({ token, setup }: { token: string; setup: PublicSetup }) {
  const [url, setUrl] = useState('')
  const [state, setState] = useState<'idle' | 'sending' | 'done' | 'error'>(setup.done ? 'done' : 'idle')
  const [error, setError] = useState<string | null>(null)

  async function submit() {
    setState('sending')
    setError(null)
    try {
      const res = await fetch(`/api/public/gbp/${token}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ profileUrl: url }),
      })
      const out = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string }
      if (!res.ok || !out.ok) throw new Error(out.error || 'Something went wrong. Try again, or text us the link.')
      setState('done')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setState('error')
    }
  }

  const first = setup.ownerFirstName || 'there'
  return (
    <main className="min-h-screen bg-background px-4 py-8 text-foreground">
      <div className="mx-auto flex max-w-2xl flex-col gap-6">
        <header className="flex flex-col gap-2">
          <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-muted-foreground">Genisys</p>
          <h1 className="text-[26px] font-semibold leading-tight tracking-tight">Set up your Google Business Profile</h1>
          <p className="text-[14px] leading-relaxed text-muted-foreground">
            Hi {first}. This puts {setup.businessName} on Google Maps and in local search, and it’s where customers leave reviews. It takes about 10
            minutes. We’ve already written every answer Google asks for: tap Copy, then paste it into Google.
          </p>
        </header>

        <Step n={1} title="Start your profile">
          <p className="text-[13.5px] leading-relaxed text-muted-foreground">
            Open Google’s setup page and sign in with your own Google account (create one if you don’t have it). The profile will belong to you.
          </p>
          <a
            href="https://business.google.com/create"
            target="_blank"
            rel="noreferrer"
            className="inline-flex w-fit items-center gap-2 rounded-lg bg-emerald-600 px-4 py-2.5 text-[14px] font-semibold text-white transition hover:bg-emerald-700"
          >
            Open Google Business Profile <ExternalLink className="h-4 w-4" />
          </a>
        </Step>

        <Step n={2} title="Copy in your answers">
          <p className="text-[13.5px] leading-relaxed text-muted-foreground">Google asks these in about this order. Copy each one into the matching question.</p>
          <div className="flex flex-col gap-3">
            {setup.fields.map((f) => (
              <CopyBox key={f.id} field={f} />
            ))}
          </div>
        </Step>

        <Step n={3} title="Add Genisys as a manager">
          <p className="text-[13.5px] leading-relaxed text-muted-foreground">
            So we can keep your profile up to date for you. In your profile, open the menu, go to <b>Settings</b>, then <b>People and access</b>, tap{' '}
            <b>Add</b>, paste this email and choose <b>Manager</b>.
          </p>
          <CopyBox field={{ id: 'manager', label: 'Genisys email', text: setup.managerEmail, mono: true }} />
        </Step>

        <Step n={4} title="Verify it with Google">
          <p className="text-[13.5px] leading-relaxed text-muted-foreground">
            Google needs to confirm the business is yours before the profile shows up. Tap <b>Verify</b> on your profile and follow what it asks. It’s usually
            a short video: record one unbroken clip showing your business name (truck, sign or paperwork), your tools or equipment, and you at work.
          </p>
        </Step>

        <Step n={5} title="Send us your profile link">
          {state === 'done' ? (
            <p className="flex items-center gap-2 rounded-lg border border-emerald-500/40 bg-emerald-500/10 px-3 py-2.5 text-[14px] text-emerald-700 dark:text-emerald-300">
              <Check className="h-4 w-4" /> Got it, thank you! We’ll take it from here.
            </p>
          ) : (
            <>
              <p className="text-[13.5px] leading-relaxed text-muted-foreground">
                In your profile, tap <b>Share</b>, copy the link, and paste it here so we know it’s done.
              </p>
              <input
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="https://maps.app.goo.gl/…"
                inputMode="url"
                className="h-11 w-full rounded-lg border border-border bg-card px-3 text-[14px] outline-none focus:border-foreground/30"
              />
              {error && <p className="text-[13px] text-destructive">{error}</p>}
              <button
                type="button"
                onClick={submit}
                disabled={state === 'sending' || !url.trim()}
                className="inline-flex w-fit items-center gap-2 rounded-lg bg-foreground px-4 py-2.5 text-[14px] font-semibold text-background transition hover:opacity-90 disabled:opacity-50"
              >
                {state === 'sending' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />} I’m done
              </button>
            </>
          )}
        </Step>

        <p className="pb-6 text-center text-[12.5px] text-muted-foreground">Stuck on a step? Reply to our text or email and we’ll walk you through it.</p>
      </div>
    </main>
  )
}

function Step({ n, title, children }: { n: number; title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-3 rounded-xl border border-border bg-card p-4">
      <h2 className="flex items-center gap-2.5 text-[16px] font-semibold">
        <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-foreground text-[12px] font-bold text-background">{n}</span>
        {title}
      </h2>
      {children}
    </section>
  )
}

function CopyBox({ field }: { field: GbpField }) {
  const [copied, setCopied] = useState(false)
  const text = forCopy(field.text)
  return (
    <div className="flex flex-col gap-1.5 rounded-lg border border-border-soft bg-surface p-3">
      <div className="flex items-center justify-between gap-3">
        <p className="text-[13px] font-medium">{field.label}</p>
        <button
          type="button"
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(text)
              setCopied(true)
              setTimeout(() => setCopied(false), 1500)
            } catch {
              setCopied(false)
            }
          }}
          className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-border bg-card px-3 py-1.5 text-[12.5px] font-medium transition hover:bg-muted"
        >
          {copied ? <Check className="h-3.5 w-3.5 text-emerald-600" /> : <Copy className="h-3.5 w-3.5" />}
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <p className={`whitespace-pre-wrap break-words text-[14px] leading-relaxed ${field.mono ? 'font-mono text-[13px]' : ''}`}>{text}</p>
      {field.note && <p className="text-[12px] leading-snug text-muted-foreground">{field.note}</p>}
    </div>
  )
}
