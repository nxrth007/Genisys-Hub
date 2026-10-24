'use client'

import Link from 'next/link'
import { useParams } from 'next/navigation'
import { useState } from 'react'
import { Check, ChevronDown, ChevronRight, Circle, Rocket } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useAccount } from '@/components/hell-level/bits'
import { Badge, Card, ErrorNote, Spinner } from '@/components/hell-level/ui'

/** GHL's Launchpad: the setup checklist with a progress bar, and a "Setup Guide" index on the left. */
export default function LaunchpadPage() {
  const { accountId } = useParams<{ accountId: string }>()
  const q = useAccount(accountId)
  const [openKey, setOpenKey] = useState<string | null>(null)

  if (q.isLoading) {
    return (
      <div className="flex justify-center py-24">
        <Spinner />
      </div>
    )
  }
  if (!q.data) return <div className="p-6"><ErrorNote error={q.error} /></div>

  const { launchpad, account } = q.data
  const pct = Math.round((launchpad.done / launchpad.total) * 100)
  const next = launchpad.items.find((i) => !i.done)
  const expanded = openKey ?? next?.key ?? null
  const business = account.profile.businessName || account.name

  return (
    <div className="mx-auto flex max-w-6xl gap-6 px-6 py-7">
      <aside className="hidden w-60 shrink-0 lg:block">
        <p className="px-3 pb-2 text-[13px] font-semibold text-foreground/90">Setup Guide</p>
        <nav className="flex flex-col gap-0.5">
          {launchpad.items.map((i) => (
            <button
              key={i.key}
              type="button"
              onClick={() => setOpenKey(i.key)}
              className={cn(
                'flex items-center gap-2.5 rounded-lg px-3 py-2 text-left text-[13.5px] transition',
                expanded === i.key ? 'bg-card font-semibold text-foreground' : 'text-muted-foreground hover:bg-muted/60',
              )}
            >
              {i.done ? <Check className="h-4 w-4 shrink-0 text-success" strokeWidth={2.5} /> : <Circle className="h-4 w-4 shrink-0 text-muted-foreground" />}
              <span className="truncate">{i.title}</span>
            </button>
          ))}
        </nav>
      </aside>

      <div className="min-w-0 flex-1">
        <Card className="overflow-hidden">
          <div className="flex items-start gap-4 border-b border-border px-6 py-5">
            <span className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-primary-soft text-primary">
              <Rocket className="h-5 w-5" />
            </span>
            <div className="min-w-0 flex-1">
              <h1 className="text-[18px] font-semibold text-foreground">{pct === 100 ? `${business} is all set` : `Let’s get ${business} set up`}</h1>
              <p className="mt-0.5 text-[14px] text-muted-foreground">
                {pct === 100
                  ? 'Leads from the website and missed calls are answered automatically.'
                  : 'Finish these and Hell-level answers every website lead and missed call by itself.'}
              </p>
              <div className="mt-4 flex items-center gap-3">
                <div className="h-2 flex-1 overflow-hidden rounded-full bg-muted">
                  <div className="h-full rounded-full bg-primary transition-all" style={{ width: `${pct}%` }} />
                </div>
                <span className="text-[13px] font-semibold tabular-nums text-foreground/90">{pct}%</span>
              </div>
            </div>
          </div>
          <ul>
            {launchpad.items.map((i) => {
              const open = expanded === i.key
              return (
                <li key={i.key} className={cn('border-b border-border last:border-0', open && 'bg-surface-muted')}>
                  <button type="button" onClick={() => setOpenKey(open ? '' : i.key)} className="flex w-full items-center gap-4 px-6 py-4 text-left">
                    <span className={cn('grid h-7 w-7 shrink-0 place-items-center rounded-full', i.done ? 'bg-success/15 text-success' : 'border-2 border-border text-transparent')}>
                      <Check className="h-4 w-4" strokeWidth={3} />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className={cn('block text-[15px] font-semibold', i.done ? 'text-foreground/90' : 'text-foreground')}>{i.title}</span>
                      {!open && <span className="block truncate text-[13px] text-muted-foreground">{i.detail}</span>}
                    </span>
                    {i.done ? <Badge color="green">Done</Badge> : <Badge color="gray">To do</Badge>}
                    {open ? <ChevronDown className="h-4 w-4 text-muted-foreground/70" /> : <ChevronRight className="h-4 w-4 text-muted-foreground/70" />}
                  </button>
                  {open && (
                    <div className="flex flex-wrap items-center gap-4 px-6 pb-5 pl-[68px]">
                      <p className="min-w-[240px] flex-1 text-[14px] text-muted-foreground">{i.detail}</p>
                      <Link
                        href={`/hell-level/${accountId}/${i.href}`}
                        className={cn(
                          'inline-flex h-9 items-center rounded-lg px-4 text-[13.5px] font-semibold transition',
                          i.done ? 'border border-border bg-card text-foreground/90 hover:bg-muted/50' : 'bg-primary text-primary-foreground hover:bg-primary/90',
                        )}
                      >
                        {i.done ? 'View' : i.cta}
                      </Link>
                    </div>
                  )}
                </li>
              )
            })}
          </ul>
        </Card>
      </div>
    </div>
  )
}
