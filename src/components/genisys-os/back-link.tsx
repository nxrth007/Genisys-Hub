'use client'

import Link from 'next/link'
import { ArrowLeft } from 'lucide-react'

/**
 * An editor's back arrow. It goes up to the list the item lives in (the right
 * tab, not the section's first one) and says where, for screen readers and on hover.
 */
export function BackLink({ href, to }: { href: string; to: string }) {
  return (
    <Link href={href} aria-label={`Back to ${to}`} title={`Back to ${to}`} className="grid h-9 w-9 place-items-center rounded-lg text-muted-foreground hover:bg-muted">
      <ArrowLeft className="h-5 w-5" />
    </Link>
  )
}
