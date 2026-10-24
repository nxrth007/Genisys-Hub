'use client'

import { Suspense, useState } from 'react'
import { useParams, useRouter, useSearchParams } from 'next/navigation'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Contact, Plus, Search } from 'lucide-react'
import { prettyPhone } from '@/lib/hl/merge'
import { contactLabel, SOURCE_LABEL, type ContactRow } from '@/components/hell-level/bits'
import { Avatar, Badge, Button, Card, Empty, ErrorNote, Field, Input, Modal, PageHeader, Select, Spinner, Toggle, hlFetch, timeAgo } from '@/components/hell-level/ui'

type ContactsResponse = { contacts: ContactRow[]; total: number; page: number; pageSize: number; tags: string[] }

export default function ContactsPage() {
  return (
    <Suspense fallback={<div className="flex justify-center py-24"><Spinner /></div>}>
      <Contacts />
    </Suspense>
  )
}

function Contacts() {
  const { accountId } = useParams<{ accountId: string }>()
  const sp = useSearchParams()
  const router = useRouter()
  const qc = useQueryClient()
  const [q, setQ] = useState(sp.get('q') ?? '')
  const [tag, setTag] = useState('')
  const [page, setPage] = useState(0)
  const [adding, setAdding] = useState(false)
  const [form, setForm] = useState({ firstName: '', lastName: '', phone: '', email: '', consent: false })

  const list = useQuery<ContactsResponse>({
    queryKey: ['hl', 'contacts', accountId, q, tag, page],
    queryFn: () => hlFetch(`/api/hl/accounts/${accountId}/contacts?q=${encodeURIComponent(q)}&tag=${encodeURIComponent(tag)}&page=${page}`),
  })
  const add = useMutation({
    mutationFn: () => hlFetch<{ contact: ContactRow }>(`/api/hl/accounts/${accountId}/contacts`, { method: 'POST', json: form }),
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: ['hl', 'contacts', accountId] })
      setAdding(false)
      setForm({ firstName: '', lastName: '', phone: '', email: '', consent: false })
      router.push(`/hell-level/${accountId}/conversations?contact=${r.contact.id}`)
    },
  })

  const d = list.data
  const pages = d ? Math.max(1, Math.ceil(d.total / d.pageSize)) : 1

  return (
    <div className="mx-auto flex max-w-7xl flex-col gap-5 px-6 py-7">
      <PageHeader
        title="Contacts"
        description={d ? `${d.total.toLocaleString('en-US')} contact${d.total === 1 ? '' : 's'}` : 'Everyone who filled a form, called or texted.'}
        actions={
          <Button variant="primary" icon={<Plus className="h-4 w-4" />} onClick={() => setAdding(true)}>
            Add contact
          </Button>
        }
      />
      <Card>
        <div className="flex flex-wrap items-center gap-3 border-b border-[#EAECF0] px-4 py-3">
          <label className="flex h-10 min-w-[260px] flex-1 items-center gap-2 rounded-lg border border-[#D0D5DD] px-3 text-[#98A2B3] focus-within:border-[#84ADFF]">
            <Search className="h-4 w-4" />
            <input
              value={q}
              onChange={(e) => {
                setQ(e.target.value)
                setPage(0)
              }}
              placeholder="Search by name, phone or email"
              className="w-full bg-transparent text-[14px] text-[#101828] outline-none"
            />
          </label>
          <Select
            value={tag}
            onChange={(e) => {
              setTag(e.target.value)
              setPage(0)
            }}
            className="w-48"
          >
            <option value="">All tags</option>
            {(d?.tags ?? []).map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </Select>
        </div>
        {list.isLoading ? (
          <div className="flex justify-center py-16">
            <Spinner />
          </div>
        ) : !d?.contacts.length ? (
          <Empty icon={<Contact className="h-5 w-5" />} title={q || tag ? 'No contacts match' : 'No contacts yet'}>
            {q || tag ? 'Try another search.' : 'Contacts appear here when someone fills the website form, uses the chat widget, calls or texts the number.'}
          </Empty>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-[14px]">
              <thead>
                <tr className="border-b border-[#EAECF0] bg-[#F9FAFB] text-[12px] font-medium text-[#475467]">
                  <th className="px-5 py-3">Name</th>
                  <th className="px-4 py-3">Phone</th>
                  <th className="px-4 py-3">Email</th>
                  <th className="px-4 py-3">Source</th>
                  <th className="px-4 py-3">Tags</th>
                  <th className="px-4 py-3">Created</th>
                </tr>
              </thead>
              <tbody>
                {d.contacts.map((c) => (
                  <tr key={c.id} onClick={() => router.push(`/hell-level/${accountId}/conversations?contact=${c.id}`)} className="cursor-pointer border-b border-[#EAECF0] last:border-0 hover:bg-[#F9FAFB]">
                    <td className="px-5 py-3">
                      <span className="flex items-center gap-3">
                        <Avatar name={contactLabel(c)} size={32} />
                        <span className="font-medium text-[#101828]">{contactLabel(c)}</span>
                        {c.dnd && <Badge color="red">DND</Badge>}
                      </span>
                    </td>
                    <td className="whitespace-nowrap px-4 py-3 text-[#344054]">{c.phone ? prettyPhone(c.phone) : '—'}</td>
                    <td className="px-4 py-3 text-[#344054]">{c.email ?? '—'}</td>
                    <td className="whitespace-nowrap px-4 py-3 text-[#667085]">{SOURCE_LABEL[c.source ?? ''] ?? c.source ?? '—'}</td>
                    <td className="px-4 py-3">
                      <span className="flex flex-wrap gap-1">
                        {c.tags.slice(0, 3).map((t) => (
                          <Badge key={t} color="blue">
                            {t}
                          </Badge>
                        ))}
                        {c.tags.length > 3 && <Badge>+{c.tags.length - 3}</Badge>}
                      </span>
                    </td>
                    <td className="whitespace-nowrap px-4 py-3 text-[#667085]">{timeAgo(c.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {d && d.total > d.pageSize && (
          <div className="flex items-center justify-between border-t border-[#EAECF0] px-5 py-3 text-[13px] text-[#475467]">
            <span>
              Page {page + 1} of {pages}
            </span>
            <span className="flex gap-2">
              <Button size="sm" disabled={page === 0} onClick={() => setPage((p) => p - 1)}>
                Previous
              </Button>
              <Button size="sm" disabled={page + 1 >= pages} onClick={() => setPage((p) => p + 1)}>
                Next
              </Button>
            </span>
          </div>
        )}
      </Card>

      <Modal
        open={adding}
        onClose={() => setAdding(false)}
        title="Add contact"
        footer={
          <>
            <Button onClick={() => setAdding(false)}>Cancel</Button>
            <Button variant="primary" loading={add.isPending} onClick={() => add.mutate()}>
              Add contact
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-4">
          <div className="grid grid-cols-2 gap-3">
            <Field label="First name">
              <Input value={form.firstName} onChange={(e) => setForm({ ...form, firstName: e.target.value })} />
            </Field>
            <Field label="Last name">
              <Input value={form.lastName} onChange={(e) => setForm({ ...form, lastName: e.target.value })} />
            </Field>
          </div>
          <Field label="Phone">
            <Input value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} placeholder="(555) 123-4567" />
          </Field>
          <Field label="Email">
            <Input value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
          </Field>
          <label className="flex items-center justify-between gap-3 rounded-lg border border-[#EAECF0] p-3 text-[14px] text-[#344054]">
            <span>
              They agreed to receive texts
              <span className="block text-[12px] text-[#667085]">Only switch on if they said yes; automations won’t text them otherwise.</span>
            </span>
            <Toggle checked={form.consent} onChange={(v) => setForm({ ...form, consent: v })} />
          </label>
          <ErrorNote error={add.error} />
        </div>
      </Modal>
      <ErrorNote error={list.error} />
    </div>
  )
}
