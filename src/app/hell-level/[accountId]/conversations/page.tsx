'use client'

import { Suspense, useEffect, useMemo, useRef, useState } from 'react'
import { useParams, useRouter, useSearchParams } from 'next/navigation'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { FileText, Mail, MessagesSquare, Phone, PhoneIncoming, PhoneMissed, Search, Send, Star, StickyNote, TriangleAlert } from 'lucide-react'
import { cn } from '@/lib/utils'
import { prettyPhone } from '@/lib/hl/merge'
import { contactLabel, useAccount } from '@/components/hell-level/bits'
import { ContactPanel, type ContactDetail } from '@/components/hell-level/contact-panel'
import { Avatar, Button, Empty, ErrorNote, Input, Spinner, Textarea, fmtDateTime, hlFetch, timeAgo } from '@/components/hell-level/ui'
import { NotYet, RecordsTable, rv, useSectionTab } from '@/components/hell-level/section'

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
  starred: boolean
  source: string | null
}

type Filter = 'unread' | 'recents' | 'starred' | 'all'
const FILTERS: { key: Filter; label: string }[] = [
  { key: 'unread', label: 'Unread' },
  { key: 'recents', label: 'Recents' },
  { key: 'starred', label: 'Starred' },
  { key: 'all', label: 'All' },
]

export default function ConversationsPage() {
  return (
    <Suspense fallback={<div className="flex justify-center py-24"><Spinner /></div>}>
      <ConversationsSection />
    </Suspense>
  )
}

function ConversationsSection() {
  const { accountId } = useParams<{ accountId: string }>()
  const tab = useSectionTab('conversations')
  if (tab === 'snippets')
    return (
      <RecordsTable
        accountId={accountId}
        kind="snippet"
        title="Snippets"
        emptyText="Saved replies from GoHighLevel show up here after the import."
        columns={[
          { label: 'Name', render: (r) => <span className="font-medium text-foreground">{r.name}</span> },
          { label: 'Type', render: (r) => <span className="eyebrow text-muted-foreground">{rv(r, 'type') || 'sms'}</span> },
          { label: 'Message', render: (r) => <span className="line-clamp-2 max-w-xl text-muted-foreground">{rv(r, 'template.body', 'template.text', 'body')}</span> },
        ]}
      />
    )
  if (tab === 'trigger-links')
    return (
      <RecordsTable
        accountId={accountId}
        kind="trigger_link"
        title="Trigger Links"
        emptyText="Trigger links from GoHighLevel show up here after the import."
        columns={[
          { label: 'Name', render: (r) => <span className="font-medium text-foreground">{r.name}</span> },
          { label: 'Redirects to', render: (r) => <span className="break-all text-muted-foreground">{rv(r, 'redirectTo')}</span> },
          { label: 'Key', render: (r) => <span className="font-mono text-[12px] text-muted-foreground">{rv(r, 'fieldKey')}</span> },
        ]}
      />
    )
  if (tab === 'manual-actions')
    return <NotYet title="Manual Actions" what="In GoHighLevel, workflows can queue calls and texts for a person to send one by one. Hell-level workflows send on their own, so there is no queue yet." />
  return <Conversations />
}

function Conversations() {
  const { accountId } = useParams<{ accountId: string }>()
  const sp = useSearchParams()
  const router = useRouter()
  const qc = useQueryClient()
  const [filter, setFilter] = useState<Filter>((FILTERS.find((f) => f.key === sp.get('filter'))?.key ?? 'recents') as Filter)
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

  const open = (id: string) => router.replace(`/hell-level/${accountId}/conversations?contact=${id}&filter=${filter}`)

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
      <section className="flex w-[340px] shrink-0 flex-col border-r border-border bg-card">
        <div className="border-b border-border px-4 pb-3 pt-4">
          <div className="flex gap-1 border-b border-border">
            {FILTERS.map((f) => (
              <button
                key={f.key}
                type="button"
                onClick={() => setFilter(f.key)}
                className={cn('-mb-px flex-1 border-b-2 pb-2 text-[12.5px] font-medium transition', filter === f.key ? 'border-primary text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground')}
              >
                {f.label}
              </button>
            ))}
          </div>
          <label className="mt-3 flex h-9 items-center gap-2 rounded-lg border border-border px-3 text-muted-foreground/70 focus-within:border-primary/50">
            <Search className="h-4 w-4" />
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search name, phone, email" className="w-full bg-transparent text-[13px] text-foreground outline-none" />
          </label>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">
          {list.isLoading ? (
            <div className="flex justify-center py-10">
              <Spinner />
            </div>
          ) : !list.data?.conversations.length ? (
            <p className="px-5 py-10 text-center text-[13px] text-muted-foreground">{filter === 'unread' ? 'All caught up.' : filter === 'starred' ? 'Star a conversation to keep it here.' : 'No conversations yet. Texts, calls and form leads show up here.'}</p>
          ) : (
            list.data.conversations.map((c) => (
              <button
                key={c.id}
                type="button"
                onClick={() => open(c.id)}
                className={cn('flex w-full items-start gap-3 border-b border-border-soft px-4 py-3 text-left transition hover:bg-muted/50', selected === c.id && 'bg-primary-soft hover:bg-primary-soft')}
              >
                <Avatar name={contactLabel(c)} size={38} />
                <span className="min-w-0 flex-1">
                  <span className="flex items-baseline justify-between gap-2">
                    <span className={cn('truncate text-[14px] text-foreground', c.unread ? 'font-bold' : 'font-medium')}>{contactLabel(c)}</span>
                    <span className="shrink-0 text-[11.5px] text-muted-foreground/70">{timeAgo(c.lastMessageAt)}</span>
                  </span>
                  <span className={cn('mt-0.5 block truncate text-[13px]', c.unread ? 'font-medium text-foreground/90' : 'text-muted-foreground')}>{(c.lastMessage ?? '').replace(/\s+/g, ' ')}</span>
                </span>
                {c.starred && <Star className="mt-1 h-3.5 w-3.5 shrink-0 fill-warning text-warning" />}
                {!!c.unread && <span className="mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full bg-primary" />}
              </button>
            ))
          )}
        </div>
      </section>

      <section className="flex min-w-0 flex-1 flex-col bg-surface-muted">
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
        <aside className="hidden w-[300px] shrink-0 overflow-y-auto border-l border-border bg-card xl:block">
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
  const [mode, setMode] = useState<'sms' | 'email' | 'note'>('sms')
  const [text, setText] = useState('')
  const [subject, setSubject] = useState('')
  // Email: whether the sub-account can send it (Settings → Email Services).
  const email = useQuery<{ setup: { status: string; fromLocal: string; rootDomain: string } | null }>({
    queryKey: ['hl', 'email', accountId],
    queryFn: () => hlFetch(`/api/hl/accounts/${accountId}/email`),
    enabled: mode === 'email',
  })
  const bottom = useRef<HTMLDivElement>(null)

  useEffect(() => {
    bottom.current?.scrollIntoView({ block: 'end' })
  }, [detail.messages.length])

  const send = useMutation({
    mutationFn: () => hlFetch<{ ok: boolean; detail: string }>(`/api/hl/accounts/${accountId}/contacts/${c.id}/messages`, { method: 'POST', json: { kind: mode, body: text, ...(mode === 'email' ? { subject } : {}) } }),
    onSuccess: () => {
      setText('')
      setSubject('')
      qc.invalidateQueries({ queryKey: ['hl', 'contact', accountId, c.id] })
      qc.invalidateQueries({ queryKey: ['hl', 'conversations', accountId] })
    },
    onError: () => qc.invalidateQueries({ queryKey: ['hl', 'contact', accountId, c.id] }),
  })

  const star = useMutation({
    mutationFn: (v: boolean) => hlFetch(`/api/hl/accounts/${accountId}/contacts/${c.id}`, { method: 'PATCH', json: { starred: v } }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['hl', 'contact', accountId, c.id] })
      qc.invalidateQueries({ queryKey: ['hl', 'conversations', accountId] })
    },
  })
  const number = account.data?.numbers[0] ?? null
  const setup = email.data?.setup ?? null
  const warning = useMemo(() => {
    if (mode === 'email') {
      if (!c.email) return 'This contact has no email address.'
      if (c.emailDnd) return `No more email to this contact: they ${c.emailDndReason ?? 'unsubscribed'}.`
      if (email.data && !setup) return 'Email isn’t set up for this sub-account yet (Settings → Email Services).'
      if (setup && setup.status !== 'active') return 'Email is still being verified (Settings → Email Services).'
      return null
    }
    if (mode !== 'sms') return null
    if (!c.phone) return 'This contact has no phone number.'
    if (c.dnd) return 'This contact texted STOP. Nothing goes out until they text START.'
    if (!number) return 'This sub-account has no phone number yet (Settings → Phone Numbers).'
    if (number.kind === 'toll_free' && number.verificationStatus !== 'approved') return 'Texting isn’t approved yet: the number’s toll-free verification is still with Twilio.'
    if (!c.smsConsent) return 'No texting consent recorded. If they agreed, switch on “Agreed to texts” on the right.'
    return null
  }, [mode, c, number, email.data, setup])

  return (
    <>
      <div className="flex items-center justify-between gap-3 border-b border-border bg-card px-5 py-3">
        <div className="flex min-w-0 items-center gap-3">
          <Avatar name={contactLabel(c)} size={36} />
          <div className="min-w-0">
            <p className="truncate text-[15px] font-semibold text-foreground">{contactLabel(c)}</p>
            <p className="truncate text-[12.5px] text-muted-foreground">{[c.phone && prettyPhone(c.phone), c.email].filter(Boolean).join(' · ')}</p>
          </div>
        </div>
        <button
          type="button"
          onClick={() => star.mutate(!c.starred)}
          className="ml-auto grid h-9 w-9 place-items-center rounded-md border border-border bg-surface text-muted-foreground hover:bg-muted"
          title={c.starred ? 'Unstar' : 'Star'}
        >
          <Star className={cn('h-4 w-4', c.starred && 'fill-warning text-warning')} />
        </button>
        {c.phone && (
          <a href={`tel:${c.phone}`} className="inline-flex h-9 items-center gap-2 rounded-lg border border-border bg-card px-3 text-[13px] font-semibold text-foreground/90 hover:bg-muted/50">
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

      <div className="border-t border-border bg-card px-5 pb-4 pt-3">
        <div className="mx-auto max-w-3xl">
          <div className="mb-2 flex gap-4 text-[13px] font-semibold">
            <button type="button" onClick={() => setMode('sms')} className={cn('flex items-center gap-1.5 pb-1', mode === 'sms' ? 'border-b-2 border-primary text-primary' : 'text-muted-foreground')}>
              <Send className="h-3.5 w-3.5" /> SMS
            </button>
            <button type="button" onClick={() => setMode('email')} className={cn('flex items-center gap-1.5 pb-1', mode === 'email' ? 'border-b-2 border-primary text-primary' : 'text-muted-foreground')}>
              <Mail className="h-3.5 w-3.5" /> Email
            </button>
            <button type="button" onClick={() => setMode('note')} className={cn('flex items-center gap-1.5 pb-1', mode === 'note' ? 'border-b-2 border-warning text-warning' : 'text-muted-foreground')}>
              <StickyNote className="h-3.5 w-3.5" /> Internal note
            </button>
          </div>
          {warning && (
            <p className="mb-2 flex items-start gap-2 rounded-lg bg-warning/10 px-3 py-2 text-[12.5px] text-warning">
              <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" /> {warning}
            </p>
          )}
          {mode === 'email' && (
            <Input value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="Subject" className="mb-2" />
          )}
          <form
            onSubmit={(e) => {
              e.preventDefault()
              if (text.trim()) send.mutate()
            }}
            className={cn('flex items-end gap-2 rounded-xl border p-2', mode === 'note' ? 'border-warning/30 bg-warning/5' : 'border-border bg-card')}
          >
            <Textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                // An email is written over several lines: Enter only sends texts and notes.
                if (mode !== 'email' && e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault()
                  if (text.trim()) send.mutate()
                }
              }}
              rows={mode === 'email' ? 5 : 2}
              placeholder={mode === 'sms' ? 'Type a text message (Enter to send, Shift+Enter for a new line)' : mode === 'email' ? 'Write the email' : 'Write a note only your team sees'}
              className={cn('min-h-[44px] flex-1 resize-none border-0 bg-transparent shadow-none focus:ring-0', mode === 'email' ? 'max-h-72' : 'max-h-40')}
            />
            <Button type="submit" variant="primary" loading={send.isPending} disabled={!text.trim()}>
              {mode === 'note' ? 'Save note' : 'Send'}
            </Button>
          </form>
          <div className="mt-1.5 flex justify-between text-[11.5px] text-muted-foreground/70">
            <span>{mode === 'sms' && number ? `From ${prettyPhone(number.number)}` : mode === 'email' && setup ? `From ${setup.fromLocal}@${setup.rootDomain}${c.email ? ` to ${c.email}` : ''}` : ''}</span>
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
        <span className={cn('inline-flex items-center gap-2 rounded-full px-3 py-1.5 text-[12.5px] font-medium', missed ? 'bg-destructive/10 text-destructive' : 'bg-success/10 text-success')}>
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
      <div className="mx-auto w-full max-w-md rounded-xl border border-primary/30 bg-primary-soft px-4 py-3">
        <p className="flex items-center gap-2 text-[13px] font-semibold text-primary">
          <FileText className="h-4 w-4" /> {title}
          <span className="ml-auto text-[11.5px] font-normal text-primary/80">{fmtDateTime(m.createdAt)}</span>
        </p>
        {rest.length > 0 && <p className="mt-1.5 whitespace-pre-wrap text-[13px] text-foreground/90">{rest.join('\n')}</p>}
      </div>
    )
  }
  if (m.channel === 'note') {
    return (
      <div className="ml-auto w-full max-w-md rounded-xl border border-warning/30 bg-warning/10 px-4 py-2.5">
        <p className="whitespace-pre-wrap text-[13.5px] text-foreground/90">{m.body}</p>
        <p className="mt-1 text-[11.5px] text-warning">
          Note · {m.by ?? 'staff'} · {fmtDateTime(m.createdAt)}
        </p>
      </div>
    )
  }
  const out = m.direction === 'outbound'
  const failed = m.status === 'failed' || m.status === 'undelivered'
  if (m.channel === 'email') {
    const subject = typeof m.meta?.subject === 'string' ? m.meta.subject : '(no subject)'
    return (
      <div className={cn('flex flex-col', out ? 'items-end' : 'items-start')}>
        <div className={cn('w-full max-w-[80%] rounded-2xl border px-4 py-3', out ? 'rounded-br-md border-primary/30 bg-primary-soft' : 'rounded-bl-md border-border bg-card', failed && 'border-destructive/40 bg-destructive/10')}>
          <p className="flex items-center gap-1.5 text-[12.5px] font-semibold text-foreground">
            <Mail className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            <span className="truncate">{subject}</span>
          </p>
          <p className="mt-1.5 whitespace-pre-wrap text-[13.5px] leading-relaxed text-foreground/90">{m.body}</p>
        </div>
        <p className={cn('mt-1 text-[11.5px]', failed ? 'text-destructive' : 'text-muted-foreground/70')}>
          {fmtDateTime(m.createdAt)} · Email{!out && m.from ? ` from ${m.from}` : ''}
          {m.meta?.automatic ? ' · Automatic reply' : ''}
          {out && ` · ${m.by === 'automation' ? 'Automation' : (m.by ?? '').split('@')[0] || 'Staff'}`}
          {out && ` · ${failed ? `Failed${m.error ? `: ${m.error}` : ''}` : m.status === 'delivered' ? 'Delivered' : 'Sent'}`}
        </p>
      </div>
    )
  }
  return (
    <div className={cn('flex flex-col', out ? 'items-end' : 'items-start')}>
      <div
        className={cn(
          'max-w-[75%] whitespace-pre-wrap rounded-2xl px-4 py-2.5 text-[14px] leading-relaxed',
          out ? 'rounded-br-md bg-primary text-primary-foreground' : 'rounded-bl-md border border-border bg-card text-foreground',
          failed && 'bg-destructive/10 text-destructive ring-1 ring-destructive/30',
        )}
      >
        {m.body}
      </div>
      <p className={cn('mt-1 text-[11.5px]', failed ? 'text-destructive' : 'text-muted-foreground/70')}>
        {fmtDateTime(m.createdAt)}
        {out && ` · ${m.by === 'automation' ? 'Automation' : (m.by ?? '').split('@')[0] || 'Staff'}`}
        {out && ` · ${failed ? `Failed${m.error ? `: ${m.error}` : ''}` : m.status === 'delivered' ? 'Delivered' : m.status === 'sent' ? 'Sent' : 'Sending'}`}
      </p>
    </div>
  )
}
