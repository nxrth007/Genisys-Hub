'use client'

import { Suspense, useEffect, useMemo, useRef, useState } from 'react'
import { useParams, useRouter, useSearchParams } from 'next/navigation'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { FileText, MessagesSquare, Phone, PhoneIncoming, PhoneMissed, Search, Send, StickyNote, TriangleAlert } from 'lucide-react'
import { cn } from '@/lib/utils'
import { prettyPhone } from '@/lib/hl/merge'
import { contactLabel, useAccount } from '@/components/hell-level/bits'
import { ContactPanel, type ContactDetail } from '@/components/hell-level/contact-panel'
import { Avatar, Button, Empty, ErrorNote, Spinner, Textarea, fmtDateTime, hlFetch, timeAgo } from '@/components/hell-level/ui'

type Conversation = {
  id: string
  firstName: string | null
  lastName: string | null
  phone: string | null
  email: string | null
  lastMessage: string | null
  lastMessageAt: string | null
  unread: number
  dnd: boolean
  source: string | null
}

export default function ConversationsPage() {
  return (
    <Suspense fallback={<div className="flex justify-center py-24"><Spinner /></div>}>
      <Conversations />
    </Suspense>
  )
}

function Conversations() {
  const { accountId } = useParams<{ accountId: string }>()
  const sp = useSearchParams()
  const router = useRouter()
  const qc = useQueryClient()
  const [filter, setFilter] = useState<'all' | 'unread'>(sp.get('filter') === 'unread' ? 'unread' : 'all')
  const [q, setQ] = useState('')
  const selected = sp.get('contact')

  const list = useQuery<{ conversations: Conversation[] }>({
    queryKey: ['hl', 'conversations', accountId, filter, q],
    queryFn: () => hlFetch(`/api/hl/accounts/${accountId}/conversations?filter=${filter}&q=${encodeURIComponent(q)}`),
    refetchInterval: 15_000,
  })
  const detail = useQuery<ContactDetail>({
    queryKey: ['hl', 'contact', accountId, selected],
    queryFn: () => hlFetch(`/api/hl/accounts/${accountId}/contacts/${selected}`),
    enabled: !!selected,
    refetchInterval: 10_000,
  })

  const open = (id: string) => router.replace(`/hell-level/${accountId}/conversations?contact=${id}${filter === 'unread' ? '&filter=unread' : ''}`)

  // Opening a conversation marks it read.
  const unread = detail.data?.contact.unread ?? 0
  useEffect(() => {
    if (!selected || !unread) return
    void hlFetch(`/api/hl/accounts/${accountId}/contacts/${selected}`, { method: 'PATCH', json: { read: true } }).then(() => {
      qc.invalidateQueries({ queryKey: ['hl', 'conversations', accountId] })
      qc.invalidateQueries({ queryKey: ['hl', 'accounts'] })
    })
  }, [selected, unread, accountId, qc])

  return (
    <div className="flex h-full min-h-0">
      <section className="flex w-[340px] shrink-0 flex-col border-r border-[#EAECF0] bg-white">
        <div className="border-b border-[#EAECF0] px-4 pb-3 pt-4">
          <h1 className="text-[18px] font-semibold text-[#101828]">Conversations</h1>
          <div className="mt-3 flex gap-1 rounded-lg bg-[#F2F4F7] p-1">
            {(['all', 'unread'] as const).map((f) => (
              <button
                key={f}
                type="button"
                onClick={() => setFilter(f)}
                className={cn('flex-1 rounded-md py-1.5 text-[13px] font-semibold capitalize transition', filter === f ? 'bg-white text-[#101828] shadow-sm' : 'text-[#667085]')}
              >
                {f}
              </button>
            ))}
          </div>
          <label className="mt-3 flex h-9 items-center gap-2 rounded-lg border border-[#D0D5DD] px-3 text-[#98A2B3] focus-within:border-[#84ADFF]">
            <Search className="h-4 w-4" />
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search name, phone, email" className="w-full bg-transparent text-[13px] text-[#101828] outline-none" />
          </label>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">
          {list.isLoading ? (
            <div className="flex justify-center py-10">
              <Spinner />
            </div>
          ) : !list.data?.conversations.length ? (
            <p className="px-5 py-10 text-center text-[13px] text-[#667085]">{filter === 'unread' ? 'All caught up.' : 'No conversations yet. Texts, calls and form leads show up here.'}</p>
          ) : (
            list.data.conversations.map((c) => (
              <button
                key={c.id}
                type="button"
                onClick={() => open(c.id)}
                className={cn('flex w-full items-start gap-3 border-b border-[#F2F4F7] px-4 py-3 text-left transition hover:bg-[#F9FAFB]', selected === c.id && 'bg-[#EFF4FF] hover:bg-[#EFF4FF]')}
              >
                <Avatar name={contactLabel(c)} size={38} />
                <span className="min-w-0 flex-1">
                  <span className="flex items-baseline justify-between gap-2">
                    <span className={cn('truncate text-[14px] text-[#101828]', c.unread ? 'font-bold' : 'font-medium')}>{contactLabel(c)}</span>
                    <span className="shrink-0 text-[11.5px] text-[#98A2B3]">{timeAgo(c.lastMessageAt)}</span>
                  </span>
                  <span className={cn('mt-0.5 block truncate text-[13px]', c.unread ? 'font-medium text-[#344054]' : 'text-[#667085]')}>{(c.lastMessage ?? '').replace(/\s+/g, ' ')}</span>
                </span>
                {!!c.unread && <span className="mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full bg-[#155EEF]" />}
              </button>
            ))
          )}
        </div>
      </section>

      <section className="flex min-w-0 flex-1 flex-col bg-[#F9FAFB]">
        {!selected ? (
          <Empty icon={<MessagesSquare className="h-5 w-5" />} title="Pick a conversation">
            Every text, call and website lead for this sub-account lands here.
          </Empty>
        ) : detail.isLoading ? (
          <div className="flex justify-center py-24">
            <Spinner />
          </div>
        ) : !detail.data ? (
          <div className="p-6">
            <ErrorNote error={detail.error} />
          </div>
        ) : (
          <Thread accountId={accountId} detail={detail.data} />
        )}
      </section>

      {selected && detail.data && (
        <aside className="hidden w-[300px] shrink-0 overflow-y-auto border-l border-[#EAECF0] bg-white xl:block">
          <ContactPanel key={detail.data.contact.id} accountId={accountId} detail={detail.data} onDeleted={() => router.replace(`/hell-level/${accountId}/conversations`)} />
        </aside>
      )}
    </div>
  )
}

function Thread({ accountId, detail }: { accountId: string; detail: ContactDetail }) {
  const qc = useQueryClient()
  const account = useAccount(accountId)
  const c = detail.contact
  const [mode, setMode] = useState<'sms' | 'note'>('sms')
  const [text, setText] = useState('')
  const bottom = useRef<HTMLDivElement>(null)

  useEffect(() => {
    bottom.current?.scrollIntoView({ block: 'end' })
  }, [detail.messages.length])

  const send = useMutation({
    mutationFn: () => hlFetch<{ ok: boolean; detail: string }>(`/api/hl/accounts/${accountId}/contacts/${c.id}/messages`, { method: 'POST', json: { kind: mode, body: text } }),
    onSuccess: () => {
      setText('')
      qc.invalidateQueries({ queryKey: ['hl', 'contact', accountId, c.id] })
      qc.invalidateQueries({ queryKey: ['hl', 'conversations', accountId] })
    },
    onError: () => qc.invalidateQueries({ queryKey: ['hl', 'contact', accountId, c.id] }),
  })

  const number = account.data?.numbers[0] ?? null
  const warning = useMemo(() => {
    if (mode !== 'sms') return null
    if (!c.phone) return 'This contact has no phone number.'
    if (c.dnd) return 'This contact texted STOP. Nothing goes out until they text START.'
    if (!number) return 'This sub-account has no phone number yet (Settings → Phone Numbers).'
    if (number.kind === 'toll_free' && number.verificationStatus !== 'approved') return 'Texting isn’t approved yet: the number’s toll-free verification is still with Twilio.'
    if (!c.smsConsent) return 'No texting consent recorded. If they agreed, switch on “Agreed to texts” on the right.'
    return null
  }, [mode, c, number])

  return (
    <>
      <div className="flex items-center justify-between gap-3 border-b border-[#EAECF0] bg-white px-5 py-3">
        <div className="flex min-w-0 items-center gap-3">
          <Avatar name={contactLabel(c)} size={36} />
          <div className="min-w-0">
            <p className="truncate text-[15px] font-semibold text-[#101828]">{contactLabel(c)}</p>
            <p className="truncate text-[12.5px] text-[#667085]">{[c.phone && prettyPhone(c.phone), c.email].filter(Boolean).join(' · ')}</p>
          </div>
        </div>
        {c.phone && (
          <a href={`tel:${c.phone}`} className="inline-flex h-9 items-center gap-2 rounded-lg border border-[#D0D5DD] bg-white px-3 text-[13px] font-semibold text-[#344054] hover:bg-[#F9FAFB]">
            <Phone className="h-4 w-4" /> Call
          </a>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
        <div className="mx-auto flex max-w-3xl flex-col gap-3">
          {detail.messages.map((m) => (
            <MessageRow key={m.id} m={m} />
          ))}
          <div ref={bottom} />
        </div>
      </div>

      <div className="border-t border-[#EAECF0] bg-white px-5 pb-4 pt-3">
        <div className="mx-auto max-w-3xl">
          <div className="mb-2 flex gap-4 text-[13px] font-semibold">
            <button type="button" onClick={() => setMode('sms')} className={cn('flex items-center gap-1.5 pb-1', mode === 'sms' ? 'border-b-2 border-[#155EEF] text-[#155EEF]' : 'text-[#667085]')}>
              <Send className="h-3.5 w-3.5" /> SMS
            </button>
            <button type="button" onClick={() => setMode('note')} className={cn('flex items-center gap-1.5 pb-1', mode === 'note' ? 'border-b-2 border-[#DC6803] text-[#DC6803]' : 'text-[#667085]')}>
              <StickyNote className="h-3.5 w-3.5" /> Internal note
            </button>
          </div>
          {warning && (
            <p className="mb-2 flex items-start gap-2 rounded-lg bg-[#FFFAEB] px-3 py-2 text-[12.5px] text-[#B54708]">
              <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" /> {warning}
            </p>
          )}
          <form
            onSubmit={(e) => {
              e.preventDefault()
              if (text.trim()) send.mutate()
            }}
            className={cn('flex items-end gap-2 rounded-xl border p-2', mode === 'note' ? 'border-[#FEDF89] bg-[#FFFCF5]' : 'border-[#D0D5DD] bg-white')}
          >
            <Textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault()
                  if (text.trim()) send.mutate()
                }
              }}
              rows={2}
              placeholder={mode === 'sms' ? 'Type a text message (Enter to send, Shift+Enter for a new line)' : 'Write a note only your team sees'}
              className="max-h-40 min-h-[44px] flex-1 resize-none border-0 bg-transparent shadow-none focus:ring-0"
            />
            <Button type="submit" variant="primary" loading={send.isPending} disabled={!text.trim()}>
              {mode === 'sms' ? 'Send' : 'Save note'}
            </Button>
          </form>
          <div className="mt-1.5 flex justify-between text-[11.5px] text-[#98A2B3]">
            <span>{mode === 'sms' && number ? `From ${prettyPhone(number.number)}` : ''}</span>
            {mode === 'sms' && <span>{text.length} characters · {Math.max(1, Math.ceil(text.length / 153))} segment(s)</span>}
          </div>
          {send.error && <ErrorNote error={send.error} />}
        </div>
      </div>
    </>
  )
}

function MessageRow({ m }: { m: ContactDetail['messages'][number] }) {
  if (m.channel === 'call') {
    const missed = m.status === 'missed'
    return (
      <div className="flex justify-center">
        <span className={cn('inline-flex items-center gap-2 rounded-full px-3 py-1.5 text-[12.5px] font-medium', missed ? 'bg-[#FEF3F2] text-[#B42318]' : 'bg-[#ECFDF3] text-[#067647]')}>
          {missed ? <PhoneMissed className="h-3.5 w-3.5" /> : <PhoneIncoming className="h-3.5 w-3.5" />}
          {m.status === 'ringing' ? 'Incoming call' : m.body || (missed ? 'Missed call' : 'Call')}
          <span className="font-normal opacity-70">· {fmtDateTime(m.createdAt)}</span>
        </span>
      </div>
    )
  }
  if (m.channel === 'activity') {
    const [title, ...rest] = m.body.split('\n')
    return (
      <div className="mx-auto w-full max-w-md rounded-xl border border-[#D1E0FF] bg-[#EFF4FF] px-4 py-3">
        <p className="flex items-center gap-2 text-[13px] font-semibold text-[#004EEB]">
          <FileText className="h-4 w-4" /> {title}
          <span className="ml-auto text-[11.5px] font-normal text-[#528BFF]">{fmtDateTime(m.createdAt)}</span>
        </p>
        {rest.length > 0 && <p className="mt-1.5 whitespace-pre-wrap text-[13px] text-[#344054]">{rest.join('\n')}</p>}
      </div>
    )
  }
  if (m.channel === 'note') {
    return (
      <div className="ml-auto w-full max-w-md rounded-xl border border-[#FEDF89] bg-[#FFFAEB] px-4 py-2.5">
        <p className="whitespace-pre-wrap text-[13.5px] text-[#344054]">{m.body}</p>
        <p className="mt-1 text-[11.5px] text-[#B54708]">
          Note · {m.by ?? 'staff'} · {fmtDateTime(m.createdAt)}
        </p>
      </div>
    )
  }
  const out = m.direction === 'outbound'
  const failed = m.status === 'failed' || m.status === 'undelivered'
  return (
    <div className={cn('flex flex-col', out ? 'items-end' : 'items-start')}>
      <div
        className={cn(
          'max-w-[75%] whitespace-pre-wrap rounded-2xl px-4 py-2.5 text-[14px] leading-relaxed',
          out ? 'rounded-br-md bg-[#155EEF] text-white' : 'rounded-bl-md border border-[#EAECF0] bg-white text-[#101828]',
          failed && 'bg-[#FEF3F2] text-[#B42318] ring-1 ring-[#FECDCA]',
        )}
      >
        {m.body}
      </div>
      <p className={cn('mt-1 text-[11.5px]', failed ? 'text-[#D92D20]' : 'text-[#98A2B3]')}>
        {fmtDateTime(m.createdAt)}
        {out && ` · ${m.by === 'automation' ? 'Automation' : (m.by ?? '').split('@')[0] || 'Staff'}`}
        {out && ` · ${failed ? `Failed${m.error ? `: ${m.error}` : ''}` : m.status === 'delivered' ? 'Delivered' : m.status === 'sent' ? 'Sent' : 'Sending'}`}
      </p>
    </div>
  )
}
