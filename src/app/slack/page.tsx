'use client'

import { useQuery } from '@tanstack/react-query'
import Link from 'next/link'
import { Hash, Lock, Users, AlertCircle } from 'lucide-react'

type Channel = {
  id: string
  name: string
  topic: string
  memberCount: number
  isPrivate: boolean
  isMember: boolean
}

export default function SlackPage() {
  const { data, isLoading, error } = useQuery<{ channels: Channel[] }>({
    queryKey: ['slack-channels'],
    queryFn: async () => {
      const res = await fetch('/api/slack/channels')
      if (!res.ok) {
        const d = await res.json().catch(() => ({}))
        throw new Error(d.error || 'Failed to load channels')
      }
      return res.json()
    },
    retry: false,
  })

  const channels = data?.channels ?? []

  return (
    <div className="max-w-4xl space-y-6">
      <div>
        <div className="flex items-center gap-3">
          <div className="rounded-lg bg-purple-50 p-2.5 dark:bg-purple-950">
            <Hash className="h-6 w-6 text-purple-600" />
          </div>
          <div>
            <h2 className="text-2xl font-bold tracking-tight">Slack</h2>
            <p className="text-sm text-zinc-500">
              Client channels and team conversations from your Slack workspace.
            </p>
          </div>
        </div>
      </div>

      <div className="rounded-xl border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900 overflow-hidden">
        {isLoading ? (
          <div className="px-6 py-12 text-center text-sm text-zinc-500">Loading channels…</div>
        ) : error ? (
          <div className="px-6 py-8">
            <div className="flex items-start gap-3 rounded-md border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200">
              <AlertCircle className="h-4 w-4 mt-0.5 flex-shrink-0" />
              <div>
                <div className="font-medium">Could not load Slack channels</div>
                <div className="text-xs mt-1">{(error as Error).message}</div>
                <div className="text-xs mt-1 text-amber-600 dark:text-amber-300">
                  Make sure &quot;Slack Bot Token&quot; is in the vault and the bot is installed in your workspace.
                </div>
              </div>
            </div>
          </div>
        ) : channels.length === 0 ? (
          <div className="px-6 py-12 text-center text-sm text-zinc-500">
            <Hash className="mx-auto h-8 w-8 text-zinc-300 mb-3" />
            <p>No channels found. Make sure the bot is installed in your Slack workspace.</p>
          </div>
        ) : (
          <div className="divide-y divide-zinc-100 dark:divide-zinc-800">
            {channels.map((ch) => (
              <Link
                key={ch.id}
                href={`/slack/${ch.id}`}
                className="flex items-center gap-4 px-6 py-4 transition-colors hover:bg-zinc-50 dark:hover:bg-zinc-800"
              >
                <div className="flex-shrink-0 rounded-lg bg-zinc-100 p-2.5 dark:bg-zinc-800">
                  {ch.isPrivate ? (
                    <Lock className="h-5 w-5 text-zinc-500" />
                  ) : (
                    <Hash className="h-5 w-5 text-zinc-500" />
                  )}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-medium text-sm">#{ch.name}</span>
                    {ch.isPrivate && (
                      <span className="text-xs bg-zinc-100 text-zinc-500 px-1.5 py-0.5 rounded dark:bg-zinc-800">
                        private
                      </span>
                    )}
                  </div>
                  {ch.topic && (
                    <p className="text-xs text-zinc-500 truncate mt-0.5">{ch.topic}</p>
                  )}
                </div>
                <div className="flex items-center gap-1 text-xs text-zinc-400 flex-shrink-0">
                  <Users className="h-3 w-3" />
                  {ch.memberCount}
                </div>
              </Link>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
