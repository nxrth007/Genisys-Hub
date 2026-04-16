'use client'

import { useState, useRef, useEffect } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useParams, useRouter } from 'next/navigation'
import { Hash, ArrowLeft, Send } from 'lucide-react'
import { cn } from '@/lib/utils'

type SlackMsg = {
  ts: string
  userId: string
  userName: string
  text: string
  threadTs?: string
  replyCount?: number
  timestamp: string
}

export default function SlackChannelPage() {
  const params = useParams()
  const router = useRouter()
  const qc = useQueryClient()
  const channelId = params.id as string
  const [reply, setReply] = useState('')
  const messagesEndRef = useRef<HTMLDivElement>(null)

  const { data, isLoading, error } = useQuery<{ messages: SlackMsg[]; channelName: string }>({
    queryKey: ['slack-messages', channelId],
    queryFn: async () => {
      const res = await fetch(`/api/slack/channels/${channelId}/messages`)
      if (!res.ok) {
        const d = await res.json().catch(() => ({}))
        throw new Error(d.error || 'Failed to load messages')
      }
      return res.json()
    },
    refetchInterval: 15000, // poll every 15s for new messages
  })

  const sendMutation = useMutation({
    mutationFn: async (text: string) => {
      const res = await fetch(`/api/slack/channels/${channelId}/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text }),
      })
      if (!res.ok) {
        const d = await res.json().catch(() => ({}))
        throw new Error(d.error || 'Send failed')
      }
      return res.json()
    },
    onSuccess: () => {
      setReply('')
      qc.invalidateQueries({ queryKey: ['slack-messages', channelId] })
    },
  })

  const messages = data?.messages ?? []
  const channelName = data?.channelName ?? channelId

  // Auto-scroll to bottom on new messages
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages.length])

  function handleSend(e: React.FormEvent) {
    e.preventDefault()
    if (reply.trim()) {
      sendMutation.mutate(reply.trim())
    }
  }

  return (
    <div className="flex flex-col h-[calc(100vh-10rem)] max-w-4xl">
      {/* Header */}
      <div className="flex items-center gap-3 mb-4">
        <button
          onClick={() => router.push('/slack')}
          className="rounded-md p-2 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-900 dark:hover:bg-zinc-800"
        >
          <ArrowLeft className="h-4 w-4" />
        </button>
        <Hash className="h-5 w-5 text-zinc-400" />
        <h2 className="text-lg font-semibold">{channelName}</h2>
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto rounded-xl border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900">
        {isLoading ? (
          <div className="flex items-center justify-center h-full text-sm text-zinc-500">
            Loading messages…
          </div>
        ) : error ? (
          <div className="p-6 text-center text-sm text-red-600">
            {(error as Error).message}
          </div>
        ) : messages.length === 0 ? (
          <div className="flex items-center justify-center h-full text-sm text-zinc-500">
            No messages in this channel yet.
          </div>
        ) : (
          <div className="p-4 space-y-1">
            {messages.map((msg, i) => {
              const prev = messages[i - 1]
              const showHeader =
                !prev ||
                prev.userName !== msg.userName ||
                new Date(msg.timestamp).getTime() - new Date(prev.timestamp).getTime() > 5 * 60 * 1000

              return (
                <div key={msg.ts}>
                  {showHeader && (
                    <div className="flex items-baseline gap-2 mt-3 mb-0.5">
                      <span className="font-semibold text-sm">{msg.userName}</span>
                      <span className="text-xs text-zinc-400">
                        {formatMsgTime(msg.timestamp)}
                      </span>
                    </div>
                  )}
                  <div className="text-sm text-zinc-700 dark:text-zinc-300 pl-0 leading-relaxed">
                    <SlackText text={msg.text} />
                    {msg.replyCount && msg.replyCount > 0 && (
                      <span className="ml-2 text-xs text-blue-500">
                        {msg.replyCount} {msg.replyCount === 1 ? 'reply' : 'replies'}
                      </span>
                    )}
                  </div>
                </div>
              )
            })}
            <div ref={messagesEndRef} />
          </div>
        )}
      </div>

      {/* Reply box */}
      <form onSubmit={handleSend} className="mt-3 flex gap-2">
        <input
          type="text"
          value={reply}
          onChange={(e) => setReply(e.target.value)}
          placeholder={`Message #${channelName}…`}
          className="flex-1 rounded-lg border border-zinc-200 bg-white px-4 py-2.5 text-sm focus:border-blue-500 focus:outline-none dark:border-zinc-800 dark:bg-zinc-900"
          disabled={sendMutation.isPending}
        />
        <button
          type="submit"
          disabled={sendMutation.isPending || !reply.trim()}
          className={cn(
            'rounded-lg bg-blue-600 px-4 py-2.5 text-white transition-colors hover:bg-blue-700 disabled:opacity-50',
            'inline-flex items-center gap-2 text-sm font-medium'
          )}
        >
          <Send className="h-4 w-4" />
          {sendMutation.isPending ? 'Sending…' : 'Send'}
        </button>
      </form>

      {sendMutation.isError && (
        <p className="mt-2 text-xs text-red-500">
          Failed: {(sendMutation.error as Error).message}
        </p>
      )}
    </div>
  )
}

/**
 * Basic Slack mrkdwn → text rendering.
 * Handles *bold*, _italic_, ~strikethrough~, `code`, and user mentions (<@U123>).
 * Full Slack block kit rendering is a larger project — this covers 90% of messages.
 */
function SlackText({ text }: { text: string }) {
  // Replace user mention IDs with a styled placeholder
  // In a real implementation, we'd resolve <@U123> to a display name.
  const processed = text
    .replace(/<@([A-Z0-9]+)>/g, '@user')
    .replace(/<(https?:\/\/[^|>]+)\|([^>]+)>/g, '$2') // <url|label> → label
    .replace(/<(https?:\/\/[^>]+)>/g, '$1') // <url> → url

  return <span>{processed}</span>
}

function formatMsgTime(iso: string): string {
  if (!iso) return ''
  try {
    const d = new Date(iso)
    const now = new Date()
    const isToday =
      d.getDate() === now.getDate() &&
      d.getMonth() === now.getMonth() &&
      d.getFullYear() === now.getFullYear()

    if (isToday) {
      return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
    }
    return d.toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    })
  } catch {
    return iso
  }
}
