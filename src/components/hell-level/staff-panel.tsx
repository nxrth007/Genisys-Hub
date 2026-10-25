'use client'

import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Copy, KeyRound, Plus, Trash2, Users } from 'lucide-react'
import type { StaffRow } from '@/lib/hl/staff'
import type { LoginRow } from '@/lib/hl/logins'
import { prettyPhone } from '@/lib/hl/merge'
import { Avatar, Badge, Button, Card, Empty, ErrorNote, Field, Input, Modal, PageHeader, Spinner, Table, copyText, hlFetch, timeAgo } from './ui'
import { confirmAction } from './confirm'

type Login = Omit<LoginRow, 'invitedAt' | 'lastLoginAt'> & { invitedAt: string; lastLoginAt: string | null }

/** Settings → My Staff: the people on the sub-account, who can be on a calendar's team, and who can log in. */
export function StaffPanel({ accountId }: { accountId: string }) {
  const qc = useQueryClient()
  const q = useQuery<{ staff: StaffRow[] }>({ queryKey: ['hl', 'staff', accountId], queryFn: () => hlFetch(`/api/hl/accounts/${accountId}/staff`) })
  const logins = useQuery<{ logins: Login[] }>({ queryKey: ['hl', 'logins', accountId], queryFn: () => hlFetch(`/api/hl/accounts/${accountId}/logins`) })
  const [adding, setAdding] = useState(false)
  const [f, setF] = useState({ name: '', email: '', phone: '' })
  const [inviting, setInviting] = useState<StaffRow | null>(null)
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['hl', 'staff', accountId] })
    qc.invalidateQueries({ queryKey: ['hl', 'calendars', accountId] })
    qc.invalidateQueries({ queryKey: ['hl', 'logins', accountId] })
  }
  const add = useMutation({
    mutationFn: () => hlFetch(`/api/hl/accounts/${accountId}/staff`, { method: 'POST', json: f }),
    onSuccess: () => {
      refresh()
      setAdding(false)
      setF({ name: '', email: '', phone: '' })
    },
  })
  const remove = useMutation({ mutationFn: (id: string) => hlFetch(`/api/hl/accounts/${accountId}/staff?staffId=${id}`, { method: 'DELETE' }), onSuccess: refresh })
  const removeLogin = useMutation({
    mutationFn: (userId: string) => hlFetch(`/api/hl/accounts/${accountId}/logins?userId=${encodeURIComponent(userId)}`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['hl', 'logins', accountId] }),
  })
  const staff = q.data?.staff ?? []
  const loginOf = (s: StaffRow) => logins.data?.logins.find((l) => l.staffId === s.id) ?? null
  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-5 px-6 py-6">
      <PageHeader
        title="My Staff"
        description="The people on this sub-account. Put them on a calendar’s team (Calendars → Calendar Settings) and bookings go round robin between them. Invite them to log in and they work their leads at /login: Dashboard, Conversations, Calendars, Contacts and Opportunities (settings, automations, numbers and billing stay with Genisys)."
        actions={
          <Button variant="primary" icon={<Plus className="h-4 w-4" />} onClick={() => setAdding(true)}>
            Add staff member
          </Button>
        }
      />
      <Card>
        {q.isLoading ? (
          <div className="flex justify-center py-12">
            <Spinner />
          </div>
        ) : !staff.length ? (
          <Empty icon={<Users className="h-5 w-5" />} title="No staff yet">
            Add the owner (and anyone else who takes appointments). People on the GoHighLevel sub-account come over with the import.
          </Empty>
        ) : (
          <Table head={['Name', 'Email', 'Phone', 'Login', '']}>
            {staff.map((s) => {
              const login = loginOf(s)
              return (
                <tr key={s.id} className="border-b border-border-soft last:border-0">
                  <td className="px-4 py-2.5">
                    <span className="flex items-center gap-2.5">
                      <Avatar name={s.name} size={28} />
                      <span className="font-medium text-foreground">{s.name}</span>
                      {s.ghlId && <Badge color="gray">GoHighLevel</Badge>}
                    </span>
                  </td>
                  <td className="px-4 py-2.5 text-foreground/85">{login?.email ?? s.email ?? '—'}</td>
                  <td className="px-4 py-2.5 text-foreground/85">{s.phone ? prettyPhone(s.phone) : '—'}</td>
                  <td className="px-4 py-2.5">
                    {!login ? (
                      <Button size="sm" icon={<KeyRound className="h-3.5 w-3.5" />} onClick={() => setInviting(s)}>
                        Invite to log in
                      </Button>
                    ) : (
                      <span className="flex flex-wrap items-center gap-2">
                        {login.hasPassword ? <Badge color="green">Active</Badge> : <Badge color="amber">Invited</Badge>}
                        <span className="text-[12px] text-muted-foreground">
                          {login.lastLoginAt ? `signed in ${timeAgo(login.lastLoginAt)}` : login.hasPassword ? 'not signed in yet' : `sent ${timeAgo(login.invitedAt)}`}
                        </span>
                        <button type="button" className="text-[12px] text-primary hover:underline" onClick={() => setInviting(s)}>
                          {login.hasPassword ? 'Reset link' : 'Resend'}
                        </button>
                        <button
                          type="button"
                          className="text-[12px] text-muted-foreground hover:text-destructive"
                          onClick={() => void confirmAction(`Take ${s.name}’s login away? They’re signed out and can’t get back in.`, 'Remove login').then((ok) => ok && removeLogin.mutate(login.userId))}
                        >
                          Remove
                        </button>
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-2.5 text-right">
                    {!s.ghlId && (
                      <button
                        type="button"
                        className="text-muted-foreground hover:text-destructive"
                        title="Remove"
                        onClick={() => void confirmAction(`Remove ${s.name}? They come off any calendar team${login ? ' and lose their login' : ''}.`, 'Remove').then((ok) => ok && remove.mutate(s.id))}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    )}
                  </td>
                </tr>
              )
            })}
          </Table>
        )}
      </Card>
      <ErrorNote error={q.error || logins.error || remove.error || removeLogin.error} />
      <Modal
        open={adding}
        onClose={() => setAdding(false)}
        title="Add staff member"
        footer={
          <>
            <Button onClick={() => setAdding(false)}>Cancel</Button>
            <Button variant="primary" loading={add.isPending} disabled={!f.name.trim()} onClick={() => add.mutate()}>
              Add
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-3">
          <Field label="Name">
            <Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} autoFocus />
          </Field>
          <Field label="Email">
            <Input type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} />
          </Field>
          <Field label="Mobile phone">
            <Input type="tel" value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} />
          </Field>
          <ErrorNote error={add.error} />
        </div>
      </Modal>
      {inviting && <InviteModal key={inviting.id} accountId={accountId} staff={inviting} login={loginOf(inviting)} onClose={() => setInviting(null)} />}
    </div>
  )
}

/** "Invite to log in": a link to choose their password, by email (and a text to their phone), and to copy. */
function InviteModal({ accountId, staff, login, onClose }: { accountId: string; staff: StaffRow; login: Login | null; onClose: () => void }) {
  const qc = useQueryClient()
  const [email, setEmail] = useState(login?.email ?? staff.email ?? '')
  const [copied, setCopied] = useState(false)
  const invite = useMutation({
    mutationFn: () => hlFetch<{ link: string; sent: string[] }>(`/api/hl/accounts/${accountId}/logins`, { method: 'POST', json: { staffId: staff.id, email } }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['hl', 'logins', accountId] })
      qc.invalidateQueries({ queryKey: ['hl', 'staff', accountId] })
    },
  })
  const done = invite.data
  const first = staff.name.split(/\s+/)[0] || staff.name
  return (
    <Modal
      open
      onClose={onClose}
      title={done ? `${first}’s link is out` : login ? `A fresh link for ${first}` : `Give ${first} a login`}
      footer={
        done ? (
          <Button variant="primary" onClick={onClose}>
            Done
          </Button>
        ) : (
          <>
            <Button onClick={onClose}>Cancel</Button>
            <Button variant="primary" loading={invite.isPending} disabled={!email.trim()} onClick={() => invite.mutate()}>
              {login ? 'Send new link' : 'Send invite'}
            </Button>
          </>
        )
      }
    >
      {done ? (
        <div className="flex flex-col gap-3 text-[13px]">
          <p className="text-foreground/85">
            {done.sent.length ? `${done.sent.join(' and ').replace(/^./, (c) => c.toUpperCase())}.` : 'The email and text didn’t go out, so pass this link on yourself.'} It works for 7 days; they choose a password, then sign in at /login with {email.trim().toLowerCase()}.
          </p>
          <div className="flex items-center gap-2">
            <Input readOnly value={done.link} onFocus={(e) => e.currentTarget.select()} className="font-mono text-[12px]" />
            <Button
              icon={<Copy className="h-3.5 w-3.5" />}
              onClick={() => {
                copyText(done.link)
                setCopied(true)
              }}
            >
              {copied ? 'Copied' : 'Copy'}
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          <p className="text-[13px] text-muted-foreground">
            {login
              ? 'They get a new link to choose their password (the old link stops working).'
              : `They get a link to choose their own password${staff.phone ? ', by email and a text' : ' by email'}. They’ll see this sub-account’s Dashboard, Conversations, Calendars, Contacts and Opportunities; settings, automations, numbers and billing stay with Genisys.`}
          </p>
          <Field label="Email they sign in with">
            <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoFocus />
          </Field>
          <ErrorNote error={invite.error} />
        </div>
      )}
    </Modal>
  )
}
