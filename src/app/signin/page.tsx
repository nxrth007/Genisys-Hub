'use client'

import { signIn } from 'next-auth/react'
import Link from 'next/link'
import { Target, Headphones, Users } from 'lucide-react'

export default function SignInPage() {
  return (
    <div className="flex min-h-[calc(100vh-64px)] items-center justify-center">
      <div className="w-full max-w-sm rounded-xl border border-border bg-card p-8">
        <div className="mb-6 flex items-center justify-center gap-2">
          <Target className="h-7 w-7 text-primary" />
          <h1 className="text-xl font-bold">Genisys Hub</h1>
        </div>
        <p className="mb-6 text-center text-sm text-muted-foreground">
          Sign in with your leadgenisys.com Google account.
        </p>
        <button
          onClick={() => signIn('google', { callbackUrl: '/' })}
          className="w-full rounded-lg bg-foreground px-4 py-2.5 text-sm font-medium text-primary-foreground transition-colors hover:bg-foreground/90"
        >
          Continue with Google
        </button>
        <p className="mt-4 text-center text-xs text-muted-foreground/70">
          Only @leadgenisys.com and @trustware.io accounts can sign in.
        </p>

        <div className="my-6 flex items-center gap-3 text-xs text-muted-foreground/70">
          <div className="h-px flex-1 bg-muted bg-surface-muted" />
          <span>or</span>
          <div className="h-px flex-1 bg-muted bg-surface-muted" />
        </div>

        <Link
          href="/signin/agent"
          className="flex w-full items-center justify-center gap-2 rounded-lg border border-border bg-card px-4 py-2.5 text-sm font-medium text-foreground/85 transition-colors hover:bg-muted border-border bg-card text-foreground hover:bg-muted"
        >
          <Headphones className="h-4 w-4 text-primary" />
          If you are an agent please click here to sign in
        </Link>

        {/* Team #N signin — for offshore agents on Mary's team. They
            have a different surface (EOD reports only) and a different
            registration flow, so they get a dedicated button rather
            than landing on the agent sign-in by mistake. */}
        <Link
          href="/signin/team"
          className="mt-2 flex w-full items-center justify-center gap-2 rounded-lg border border-border bg-card px-4 py-2.5 text-sm font-medium text-foreground/85 transition-colors hover:bg-muted border-border bg-card text-foreground hover:bg-muted"
        >
          <Users className="h-4 w-4 text-primary" />
          Team #1 Signin
        </Link>
      </div>
    </div>
  )
}
