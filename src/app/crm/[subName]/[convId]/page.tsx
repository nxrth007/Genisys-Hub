'use client'

import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useParams, useRouter } from 'next/navigation'
import { ArrowLeft, Send, User } from 'lucide-react'
import { cn } from '@/lib/utils'

type Message = {
  id: string
  body: string
  dateAdded: string
  direction: string
  type: number | string
  messageType?: string
}

type Conversation = {
  id: string
  contactId?: string
  contactName?: string
  contactEmail?: string
}

type Contact = {
  id?: string
  name?: string
  firstName?: string
  lastName?: string
  email?: string
  phone?: string
  companyName?: string
  source?: string
  dateAdded?: string
  address1?: string
  city?: string
  state?: string
  postalCode?: string
  country?: string
  tags?: string[]
}

export default function ConversationDetailPage() {
  const params = useParams()
  const router = useRouter()
  const qc = useQueryClient()
  const subName = decodeURIComponent(params.subName as string)
  const convId = params.convId as string
  const encodedSub = encodeURIComponent(subName)

  const [replyText, setReplyText] = useState('')
  const [replyType, setReplyType] = useState<'Email' | 'SMS'>('Email')

  type ThreadDiagnostics = {
    mergedConversationCount: number
    totalMessages: number
    perConversation: Array<{
      id: string
      lastMessageType: string | null
      lastMessageDate: string | null
      messageCount: number
      messageTypes: Record<string, number>
      firstMessageDate: string | null
      lastMessageDateInPage: string | null
    }>
  }

  const { data, isLoading, error } = useQuery<{
    conversation: Conversation
    messages: Message[]
    contact: Contact | null
    diagnostics?: ThreadDiagnostics
  }>({
    queryKey: ['crm-conversation', subName, convId],
    queryFn: async () => {
      const res = await fetch(`/api/crm/conversations/${encodedSub}/${convId}`)
      if (!res.ok) {
        const d = await res.json().catch(() => ({}))
        throw new Error(d.error || 'Failed to load conversation')
      }
      return res.json()
    },
  })

  const sendMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch(`/api/crm/messages/${encodedSub}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          conversationId: convId,
          contactId: data?.contact?.id || data?.conversation?.contactId,
          message: replyText,
          type: replyType,
        }),
      })
      if (!res.ok) {
        const d = await res.json().catch(() => ({}))
        throw new Error(d.error || 'Send failed')
      }
      return res.json()
    },
    onSuccess: () => {
      setReplyText('')
      qc.invalidateQueries({ queryKey: ['crm-conversation', subName, convId] })
    },
  })

  if (isLoading) {
    return <div className="p-8 text-center text-sm text-zinc-500">Loading conversation…</div>
  }

  if (error) {
    return (
      <div className="space-y-4">
        <button
          onClick={() => router.push('/crm')}
          className="flex items-center gap-2 text-sm text-blue-600 hover:underline"
        >
          <ArrowLeft className="h-4 w-4" /> Back to CRM
        </button>
        <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700 dark:bg-red-950 dark:border-red-900 dark:text-red-200">
          {(error as Error).message}
        </div>
      </div>
    )
  }

  const conversation = data?.conversation
  const contact = data?.contact
  const messages = data?.messages ?? []

  const contactName =
    contact?.name ||
    [contact?.firstName, contact?.lastName].filter(Boolean).join(' ') ||
    conversation?.contactName ||
    conversation?.contactEmail ||
    'Unknown Contact'

  return (
    <div className="space-y-4">
      <button
        onClick={() => router.push('/crm')}
        className="flex items-center gap-2 text-sm text-blue-600 hover:underline"
      >
        <ArrowLeft className="h-4 w-4" /> Back to CRM
      </button>

      <div className="flex gap-4">
        {/* Messages */}
        <div className="flex-1 min-w-0">
          <div className="rounded-xl border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900">
            <div className="flex items-center gap-3 border-b border-zinc-200 px-5 py-3 dark:border-zinc-800">
              <div className="rounded-full bg-zinc-100 p-2 dark:bg-zinc-800">
                <User className="h-4 w-4 text-zinc-500" />
              </div>
              <div>
                <h3 className="font-semibold text-sm">{contactName}</h3>
                <p className="text-xs text-zinc-500">{subName}</p>
              </div>
            </div>

            <div className="p-4 space-y-3 max-h-[500px] overflow-y-auto">
              {messages.length === 0 ? (
                <p className="py-8 text-center text-sm text-zinc-500">No messages yet.</p>
              ) : (
                messages
                  .slice()
                  .reverse()
                  .map((msg) => <MessageBubble key={msg.id} msg={msg} contactName={contactName} />)
              )}
            </div>

            {/* Reply */}
            <div className="border-t border-zinc-200 p-4 dark:border-zinc-800">
              <div className="flex gap-2 mb-3">
                {(['Email', 'SMS'] as const).map((t) => (
                  <button
                    key={t}
                    onClick={() => setReplyType(t)}
                    className={cn(
                      'rounded-full px-3 py-1 text-xs font-medium',
                      replyType === t
                        ? 'bg-blue-600 text-white'
                        : 'bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300'
                    )}
                  >
                    {t}
                  </button>
                ))}
              </div>
              <textarea
                value={replyText}
                onChange={(e) => setReplyText(e.target.value)}
                placeholder={`Type your ${replyType.toLowerCase()} reply…`}
                rows={3}
                className="w-full rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm focus:border-blue-500 focus:outline-none dark:border-zinc-800 dark:bg-zinc-950"
              />
              <div className="flex justify-between items-center mt-2">
                <span className="text-xs text-zinc-400">Sending via GoHighLevel</span>
                <button
                  onClick={() => sendMutation.mutate()}
                  disabled={sendMutation.isPending || !replyText.trim()}
                  className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
                >
                  <Send className="h-4 w-4" />
                  {sendMutation.isPending ? 'Sending…' : `Send ${replyType}`}
                </button>
              </div>
              {sendMutation.isError && (
                <p className="mt-2 text-xs text-red-600">
                  {(sendMutation.error as Error).message}
                </p>
              )}
              {sendMutation.isSuccess && (
                <p className="mt-2 text-xs text-green-600">Message sent.</p>
              )}
            </div>
          </div>

          {/* Diagnostics drawer — surfaces what GHL actually returned
              when admin reports "I'm missing messages." Collapsed by
              default; opens to a per-conversation breakdown that
              tells us if the contactId search is even returning the
              expected sibling containers (SMS + Email + Call) or
              if the merger isn't finding them. */}
          {data?.diagnostics && (
            <details className="mt-3 rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-2 text-xs dark:border-zinc-800 dark:bg-zinc-900">
              <summary className="cursor-pointer text-zinc-500 select-none">
                Thread diagnostics — {data.diagnostics.mergedConversationCount}{' '}
                conversation
                {data.diagnostics.mergedConversationCount === 1 ? '' : 's'}{' '}
                merged · {data.diagnostics.totalMessages} message
                {data.diagnostics.totalMessages === 1 ? '' : 's'}
              </summary>
              <div className="mt-2 space-y-2">
                {data.diagnostics.perConversation.map((c) => (
                  <div
                    key={c.id}
                    className="rounded-md border border-zinc-200 bg-white p-2 dark:border-zinc-800 dark:bg-zinc-950"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <code className="truncate text-[10px] text-zinc-500">
                        {c.id}
                      </code>
                      <span className="flex-shrink-0 rounded-full bg-zinc-100 px-1.5 py-0.5 text-[10px] font-semibold dark:bg-zinc-800">
                        {c.messageCount} msg
                        {c.messageCount === 1 ? '' : 's'}
                      </span>
                    </div>
                    <div className="mt-1 text-[11px] text-zinc-600 dark:text-zinc-400">
                      Last GHL meta:{' '}
                      <code>{c.lastMessageType ?? '—'}</code>
                      {c.lastMessageDate && (
                        <> · {new Date(c.lastMessageDate).toLocaleString('en-US')}</>
                      )}
                    </div>
                    {Object.keys(c.messageTypes).length > 0 && (
                      <div className="mt-1 flex flex-wrap gap-1">
                        {Object.entries(c.messageTypes).map(([t, n]) => (
                          <span
                            key={t}
                            className="rounded bg-zinc-100 px-1.5 py-0.5 text-[10px] dark:bg-zinc-800"
                          >
                            {t}: {n}
                          </span>
                        ))}
                      </div>
                    )}
                    {c.firstMessageDate && c.lastMessageDateInPage && (
                      <div className="mt-1 text-[10px] text-zinc-500">
                        Range:{' '}
                        {new Date(c.firstMessageDate).toLocaleString('en-US')}{' '}
                        →{' '}
                        {new Date(c.lastMessageDateInPage).toLocaleString(
                          'en-US',
                        )}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </details>
          )}
        </div>

        {/* Contact panel */}
        <div className="hidden lg:block w-72 flex-shrink-0">
          <div className="rounded-xl border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900 sticky top-6">
            <div className="border-b border-zinc-200 p-4 dark:border-zinc-800">
              <h3 className="font-semibold">{contactName}</h3>
              {contact?.id && (
                <p className="text-[10px] font-mono text-zinc-400 mt-1 truncate">{contact.id}</p>
              )}
            </div>
            <div className="p-4 space-y-2 text-xs">
              {contact?.email && <InfoRow label="Email" value={contact.email} />}
              {contact?.phone && <InfoRow label="Phone" value={contact.phone} />}
              {contact?.companyName && <InfoRow label="Company" value={contact.companyName} />}
              {contact?.source && <InfoRow label="Source" value={contact.source} />}
              {(contact?.address1 || contact?.city) && (
                <InfoRow
                  label="Address"
                  value={[
                    contact?.address1,
                    contact?.city,
                    contact?.state,
                    contact?.postalCode,
                    contact?.country,
                  ]
                    .filter(Boolean)
                    .join(', ')}
                />
              )}
              {contact?.dateAdded && (
                <InfoRow label="Added" value={new Date(contact.dateAdded).toLocaleDateString()} />
              )}

              {contact?.tags && contact.tags.length > 0 && (
                <div className="pt-2 border-t border-zinc-100 dark:border-zinc-800 mt-2">
                  <p className="text-zinc-400 mb-1.5">Tags</p>
                  <div className="flex flex-wrap gap-1">
                    {contact.tags.map((tag) => (
                      <span
                        key={tag}
                        className="rounded-full bg-blue-100 px-2 py-0.5 text-[10px] text-blue-700 dark:bg-blue-900 dark:text-blue-300"
                      >
                        {tag}
                      </span>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <span className="text-zinc-400">{label}:</span>{' '}
      <span className="text-zinc-700 dark:text-zinc-300 break-words">{value}</span>
    </div>
  )
}

function MessageBubble({ msg, contactName }: { msg: Message; contactName: string }) {
  // GHL type: 1=Call, 2=SMS, 3=Email
  const mt = String(msg.messageType || '').toUpperCase()
  const numType = Number(msg.type)
  const isEmail = mt === 'TYPE_EMAIL' || numType === 3
  const isSms = mt === 'TYPE_SMS' || numType === 2
  const isCall = mt === 'TYPE_CALL' || numType === 1
  const isOut = msg.direction === 'outbound' || (isEmail && !msg.direction)

  let bg = 'bg-amber-50 border-amber-200 dark:bg-amber-950 dark:border-amber-900'
  let label = isEmail ? 'Email received' : isSms ? 'SMS received' : isCall ? 'Call missed' : 'Received'
  let align = ''

  if (isOut && isEmail) {
    bg = 'bg-green-50 border-green-200 dark:bg-green-950 dark:border-green-900'
    label = 'Email sent'
    align = 'ml-auto'
  } else if (isOut && isSms) {
    bg = 'bg-blue-50 border-blue-200 dark:bg-blue-950 dark:border-blue-900'
    label = 'SMS sent'
    align = 'ml-auto'
  } else if (isCall) {
    bg = 'bg-zinc-100 border-zinc-300 dark:bg-zinc-800 dark:border-zinc-700'
    label = msg.direction === 'inbound' ? 'Inbound call' : 'Outbound call'
    align = msg.direction === 'inbound' ? '' : 'ml-auto'
  } else if (isOut) {
    bg = 'bg-green-50 border-green-200 dark:bg-green-950 dark:border-green-900'
    label = 'Sent'
    align = 'ml-auto'
  }

  return (
    <div className={cn('rounded-lg border p-3 max-w-[85%]', bg, align)}>
      <div className="flex justify-between text-[10px] mb-1 gap-2">
        <span className="font-semibold">{isOut ? 'You' : contactName}</span>
        <span className="text-zinc-400">
          {label} · {formatMsgTime(msg.dateAdded)}
        </span>
      </div>
      <p className="text-xs whitespace-pre-wrap">{msg.body}</p>
    </div>
  )
}

function formatMsgTime(iso: string): string {
  try {
    return new Date(iso).toLocaleString('en-US', {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    })
  } catch {
    return iso
  }
}
