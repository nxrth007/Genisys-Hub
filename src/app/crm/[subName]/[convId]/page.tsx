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
  /** Media URLs from GHL — MMS images for SMS, plus email attachments
   *  hydrated from /conversations/messages/email/{id}. Images render
   *  inline; everything else renders as a download chip. */
  attachments?: string[]
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

  const { data, isLoading, error } = useQuery<{
    conversation: Conversation
    messages: Message[]
    contact: Contact | null
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
  // Direction inference. The OLD logic `direction === 'outbound' ||
  // (isEmail && !direction)` defaulted direction-less emails to
  // outbound — which is wrong for inbound emails that come back
  // from GHL's messages list with the direction field missing
  // (Alex's Joe Moder reply: visible in GHL native, here it
  // rendered as "Email sent" by "You" with empty body, looking
  // identical to the admin's own outbound placeholder bubbles).
  // Now: only mark as outbound when GHL explicitly says so.
  // Anything else falls through as inbound — labeled with the
  // contact's name + left-aligned, so admin can spot replies they
  // hadn't noticed.
  const isOut = msg.direction === 'outbound'

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

  // Empty body fallback — GHL sometimes returns email message
  // records with body=null/"" (especially older inbound emails
  // whose full content lives on /conversations/messages/email/{id}
  // rather than the conversations list endpoint). Render a clear
  // placeholder instead of an invisible bubble so Alex can see
  // these exist + we can chase the actual content via a follow-up
  // fetch if it matters.
  const hasBody = !!(msg.body && String(msg.body).trim())
  const attachments = msg.attachments ?? []

  return (
    <div className={cn('rounded-lg border p-3 max-w-[85%]', bg, align)}>
      <div className="flex justify-between text-[10px] mb-1 gap-2">
        <span className="font-semibold">{isOut ? 'You' : contactName}</span>
        <span className="text-zinc-400">
          {label} · {formatMsgTime(msg.dateAdded)}
        </span>
      </div>
      {hasBody ? (
        <p className="text-xs whitespace-pre-wrap">{msg.body}</p>
      ) : attachments.length === 0 ? (
        <p className="text-xs italic text-zinc-400">
          (no body returned by GHL — full content lives on the
          message-detail endpoint)
        </p>
      ) : null}
      {attachments.length > 0 && (
        <div
          className={cn(
            'flex flex-wrap gap-2',
            hasBody ? 'mt-2' : '',
          )}
        >
          {attachments.map((url) => (
            <Attachment key={url} url={url} />
          ))}
        </div>
      )}
    </div>
  )
}

/** Single attachment renderer. Image URLs become inline thumbnails
 *  (click to open full-size in a new tab); everything else renders as
 *  a download chip with the filename + extension. GHL serves
 *  signed/public URLs so we can `<img src>` them directly. */
function Attachment({ url }: { url: string }) {
  // Strip query string before sniffing the extension — signed S3 URLs
  // append `?X-Amz-Signature=…` which would otherwise hide the .jpg.
  const path = url.split('?')[0] ?? url
  const lower = path.toLowerCase()
  const isImage = /\.(jpe?g|png|gif|webp|heic|svg|bmp|avif)$/i.test(lower)
  const filename = decodeURIComponent(path.split('/').pop() || 'attachment')

  if (isImage) {
    return (
      <a
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        className="block overflow-hidden rounded-md border border-zinc-200 dark:border-zinc-700"
        title={filename}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={url}
          alt={filename}
          className="max-h-[280px] max-w-[280px] object-cover"
        />
      </a>
    )
  }

  // Non-image — small download chip. Extension shows as an uppercase
  // badge so admin can tell PDFs apart from voice memos at a glance.
  const ext = (lower.match(/\.([a-z0-9]+)$/)?.[1] ?? 'file').toUpperCase()
  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex items-center gap-2 rounded-md border border-zinc-200 bg-white/60 px-2 py-1 text-[11px] hover:bg-white dark:border-zinc-700 dark:bg-zinc-900/60 dark:hover:bg-zinc-900"
      title={url}
    >
      <span className="rounded bg-zinc-200 px-1.5 py-0.5 font-mono text-[9px] font-semibold text-zinc-700 dark:bg-zinc-700 dark:text-zinc-200">
        {ext}
      </span>
      <span className="max-w-[180px] truncate">{filename}</span>
    </a>
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
