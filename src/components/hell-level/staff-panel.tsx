'use client'

import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Plus, Trash2, Users } from 'lucide-react'
import type { StaffRow } from '@/lib/hl/staff'
import { prettyPhone } from '@/lib/hl/merge'
import { Avatar, Badge, Button, Card, Empty, ErrorNote, Field, Input, Modal, PageHeader, Spinner, Table, hlFetch } from './ui'
import { confirmAction } from './confirm'

/** Settings → My Staff: the people on the sub-account, who can be on a calendar's team. */
export function StaffPanel({ accountId }: { accountId: string }) {
  const qc = useQueryClient()
  const q = useQuery<{ staff: StaffRow[] }>({ queryKey: ['hl', 'staff', accountId], queryFn: () => hlFetch(`/api/hl/accounts/${accountId}/staff`) })
  const [adding, setAdding] = useState(false)
  const [f, setF] = useState({ name: '', email: '', phone: '' })
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['hl', 'staff', accountId] })
    qc.invalidateQueries({ queryKey: ['hl', 'calendars', accountId] })
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
  const staff = q.data?.staff ?? []
  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-5 px-6 py-6">
      <PageHeader
        title="My Staff"
        description="The people on this sub-account. Put them on a calendar’s team (Calendars → Calendar Settings) and bookings go round robin between them."
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
          <Table head={['Name', 'Email', 'Phone', '']}>
            {staff.map((s) => (
              <tr key={s.id} className="border-b border-border-soft last:border-0">
                <td className="px-4 py-2.5">
                  <span className="flex items-center gap-2.5">
                    <Avatar name={s.name} size={28} />
                    <span className="font-medium text-foreground">{s.name}</span>
                    {s.ghlId && <Badge color="gray">GoHighLevel</Badge>}
                  </span>
                </td>
                <td className="px-4 py-2.5 text-foreground/85">{s.email ?? '—'}</td>
                <td className="px-4 py-2.5 text-foreground/85">{s.phone ? prettyPhone(s.phone) : '—'}</td>
                <td className="px-4 py-2.5 text-right">
                  {!s.ghlId && (
                    <button
                      type="button"
                      className="text-muted-foreground hover:text-destructive"
                      title="Remove"
                      onClick={() => void confirmAction(`Remove ${s.name}? They come off any calendar team.`, 'Remove').then((ok) => ok && remove.mutate(s.id))}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
      <ErrorNote error={q.error || remove.error} />
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
    </div>
  )
}
