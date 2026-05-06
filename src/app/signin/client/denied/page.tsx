'use client'

/**
 * Terminal screen for client_denied. We don't elaborate on the reason
 * — the denial email Alex sends has the explanation. This page just
 * keeps the user from getting stuck in a redirect loop.
 */
import Image from 'next/image'
import { signOut } from 'next-auth/react'
import { XCircle, LogOut } from 'lucide-react'

export default function ClientDeniedPage() {
  return (
    <div className="flex min-h-[calc(100vh-64px)] items-center justify-center bg-gradient-to-b from-zinc-50 to-zinc-100 px-4 dark:from-zinc-950 dark:to-zinc-900">
      <div className="w-full max-w-sm rounded-xl border border-zinc-200 bg-white p-8 text-center shadow-lg dark:border-zinc-800 dark:bg-zinc-900">
        <div className="mb-5 flex items-center justify-center">
          <Image
            src="/genisys-logo.png"
            alt="Lead Genisys"
            width={450}
            height={150}
            priority
            className="h-auto w-44 dark:invert"
          />
        </div>
        <div className="mx-auto mb-3 flex h-10 w-10 items-center justify-center rounded-full bg-rose-100 dark:bg-rose-950">
          <XCircle className="h-5 w-5 text-rose-600 dark:text-rose-300" />
        </div>
        <h1 className="text-base font-semibold">Account not active</h1>
        <p className="mt-2 text-xs text-zinc-500">
          This Lead Genisys account isn&apos;t active. If you believe
          this is a mistake, reach out to your account manager and
          we&apos;ll take a look.
        </p>

        <button
          onClick={() => signOut({ callbackUrl: '/signin/client' })}
          className="mt-6 inline-flex items-center gap-1.5 rounded-md border border-zinc-200 bg-white px-3 py-1.5 text-xs font-medium text-zinc-700 hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200 dark:hover:bg-zinc-800"
        >
          <LogOut className="h-3.5 w-3.5" />
          Sign out
        </button>
      </div>
    </div>
  )
}
