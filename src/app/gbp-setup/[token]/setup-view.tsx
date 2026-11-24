'use client'

import { useState } from 'react'
import { Check, Copy, ExternalLink, Loader2, MapPin } from 'lucide-react'
import type { OwnerField } from '@/lib/gbp-kit'
import type { PublicSetup } from '@/lib/gbp-setup'

const CREATE_URL = 'https://business.google.com/create'
const BIG = 'inline-flex w-fit items-center gap-2 rounded-lg bg-emerald-600 px-4 py-2.5 text-[14px] font-semibold text-white transition hover:bg-emerald-700'

/**
 * The client-facing page: plain, phone-friendly, every answer one tap to copy. Google's listing for them,
 * when there is one, comes first: claim it instead of making a second.
 */
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
  const claim = setup.mode === 'claim'
  const one = setup.listings.length === 1
  return (
    <main className="min-h-screen bg-background px-4 py-8 text-foreground">
      <div className="mx-auto flex max-w-2xl flex-col gap-6">
        <header className="flex flex-col gap-2">
          <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-muted-foreground">Genisys</p>
          <h1 className="text-[26px] font-semibold leading-tight tracking-tight">{claim ? 'Claim your Google Business Profile' : 'Set up your Google Business Profile'}</h1>
          <p className="text-[14px] leading-relaxed text-muted-foreground">
            {claim
              ? `Hi ${first}. Google Maps already lists ${setup.businessName}. Claim that listing and it’s yours to manage: it’s how people find you in local search, and where customers leave reviews. It takes about 10 minutes, and we’ve written every answer for you.`
              : `Hi ${first}. This puts ${setup.businessName} on Google Maps and in local search, and it’s where customers leave reviews. It takes about 10 minutes. We’ve already written every answer Google asks for: tap Copy, then paste it into Google.`}
          </p>
        </header>

        {setup.mode === 'create' ? (
          <Step n={1} title="Start your profile">
            <p className="text-[13.5px] leading-relaxed text-muted-foreground">
              Open Google’s setup page and sign in with your own Google account (create one if you don’t have it). The profile will belong to you.
            </p>
            <a href={CREATE_URL} target="_blank" rel="noreferrer" className={BIG}>
              Open Google Business Profile <ExternalLink className="h-4 w-4" />
            </a>
          </Step>
        ) : (
          <Step n={1} title={claim ? 'Claim your listing' : one ? 'First: is this you?' : 'First: is one of these you?'}>
            <p className="text-[13.5px] leading-relaxed text-muted-foreground">
              {claim
                ? one
                  ? 'This is what Google has. Open it, '
                  : 'Google lists you more than once. Open the first one, or whichever is right, '
                : `Google Maps lists ${one ? 'a business that may be yours. If it is' : 'businesses that may be yours. If one is'}, open it, `}
              tap <b>Claim this business</b> (it may say <b>Own this business?</b>) and sign in with your own Google account. The profile will belong to you.
            </p>
            <ul className="flex flex-col gap-2">
              {setup.listings.map((l) => (
                <li key={l.mapsUrl} className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border-soft bg-surface p-3">
                  <span className="min-w-0">
                    <span className="flex items-center gap-1.5 text-[14px] font-medium">
                      <MapPin className="h-4 w-4 shrink-0" /> {l.name}
                    </span>
                    {l.address && <span className="block text-[12.5px] text-muted-foreground">{l.address}</span>}
                  </span>
                  <a href={l.mapsUrl} target="_blank" rel="noreferrer" className={BIG}>
                    Open on Google Maps <ExternalLink className="h-4 w-4" />
                  </a>
                </li>
              ))}
            </ul>
            <p className="text-[12.5px] leading-snug text-muted-foreground">
              If Google says someone else already manages it, tap Request access, then text us and we’ll help.
              {claim && !one && ' Claim just one: once it’s yours, text us and we’ll help get the extras removed.'}
            </p>
            {claim ? (
              <p className="text-[13.5px] leading-relaxed text-muted-foreground">
                Not your business?{' '}
                <a href={CREATE_URL} target="_blank" rel="noreferrer" className="font-medium text-foreground underline underline-offset-2">
                  Start a new profile
                </a>{' '}
                instead, signed in with your own Google account.
              </p>
            ) : (
              <div className="flex flex-col gap-2 border-t border-border-soft pt-3">
                <p className="text-[13.5px] leading-relaxed text-muted-foreground">Not you? Start a new profile, signed in with your own Google account. It will belong to you.</p>
                <a
                  href={CREATE_URL}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex w-fit items-center gap-2 rounded-lg border border-border bg-card px-4 py-2.5 text-[14px] font-semibold transition hover:bg-muted"
                >
                  Open Google Business Profile <ExternalLink className="h-4 w-4" />
                </a>
              </div>
            )}
          </Step>
        )}

        <Step n={2} title={claim ? 'Check your details' : 'Copy in your answers'}>
          <p className="text-[13.5px] leading-relaxed text-muted-foreground">
            {claim ? 'Open Edit profile and make each of these match.' : 'Google asks these in about this order. Copy each one into the matching question.'}
          </p>
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

function CopyBox({ field }: { field: OwnerField }) {
  const [copied, setCopied] = useState(false)
  const text = field.text
  if (field.guide) {
    return (
      <div className="flex flex-col gap-1 rounded-lg border border-border-soft bg-surface p-3">
        <p className="text-[13px] font-medium">{field.label}</p>
        <p className="text-[13px] leading-snug text-muted-foreground">{text}</p>
      </div>
    )
  }
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
