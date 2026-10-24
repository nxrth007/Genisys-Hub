'use client'

import Link from 'next/link'
import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { CheckSquare, Plus } from 'lucide-react'
import { cn } from '@/lib/utils'
import { contactLabel } from './bits'
import { Badge, Button, Card, Empty, ErrorNote, Field, Input, Modal, PageHeader, Spinner, Table, Textarea, fmtDateTime, hlFetch } from './ui'

type Task = {
  id: string
  title: string
  body: string | null
  dueDate: string | null
  completed: boolean
  assignedTo: string | null
  createdAt: string
  contact: { id: string; firstName: string | null; lastName: string | null; phone: string | null; email: string | null } | null
}

/** Contacts → Tasks, as in GHL: everyone's to-dos on contacts, due soonest first. */
export function TasksView({ accountId }: { accountId: string }) {
  const qc = useQueryClient()
  const [status, setStatus] = useState<'open' | 'done' | 'all'>('open')
  const [adding, setAdding] = useState(false)
  const [form, setForm] = useState({ title: '', body: '', dueDate: '' })
  const q = useQuery<{ tasks: Task[] }>({ queryKey: ['hl', 'tasks', accountId, status], queryFn: () => hlFetch(`/api/hl/accounts/${accountId}/tasks?status=${status}`) })
  const save = useMutation({
    mutationFn: (body: Record<string, unknown>) => hlFetch(`/api/hl/accounts/${accountId}/tasks`, { method: 'POST', json: body }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['hl', 'tasks', accountId] })
      setAdding(false)
      setForm({ title: '', body: '', dueDate: '' })
    },
  })
  // Read once: what counts as overdue doesn't need to tick while the page is open.
  const [now] = useState(() => Date.now())
  return (
    <div className="mx-auto flex max-w-7xl flex-col gap-4 px-6 py-6">
      <PageHeader
        title="Tasks"
        description="To-dos on contacts, imported from GoHighLevel and added here."
        actions={
          <>
            <div className="flex rounded-md border border-border p-0.5">
              {(['open', 'done', 'all'] as const).map((s) => (
                <button key={s} type="button" onClick={() => setStatus(s)} className={cn('rounded px-3 py-1 font-mono text-[12px] capitalize', status === s ? 'bg-muted text-foreground' : 'text-muted-foreground')}>
                  {s === 'open' ? 'Pending' : s === 'done' ? 'Completed' : 'All'}
                </button>
              ))}
            </div>
            <Button variant="primary" icon={<Plus className="h-3.5 w-3.5" />} onClick={() => setAdding(true)}>
              Add task
            </Button>
          </>
        }
      />
      <Card>
        {q.isLoading ? (
          <div className="flex justify-center py-14">
            <Spinner />
          </div>
        ) : !q.data?.tasks.length ? (
          <Empty icon={<CheckSquare className="h-5 w-5" />} title={status === 'done' ? 'Nothing completed yet' : 'No pending tasks'} />
        ) : (
          <Table head={['', 'Task', 'Contact', 'Due', 'Assigned to']}>
            {q.data.tasks.map((t) => {
              const overdue = !t.completed && t.dueDate && new Date(t.dueDate).getTime() < now
              return (
                <tr key={t.id} className="border-b border-border-soft last:border-0 hover:bg-muted/40">
                  <td className="w-10 px-4 py-2.5">
                    <input type="checkbox" checked={t.completed} onChange={(e) => save.mutate({ id: t.id, completed: e.target.checked })} className="h-4 w-4 accent-[var(--primary)]" />
                  </td>
                  <td className="px-4 py-2.5">
                    <p className={cn('font-medium text-foreground', t.completed && 'text-muted-foreground line-through')}>{t.title}</p>
                    {t.body && <p className="line-clamp-1 text-[12px] text-muted-foreground">{t.body}</p>}
                  </td>
                  <td className="px-4 py-2.5">
                    {t.contact ? (
                      <Link href={`/hell-level/${accountId}/conversations?contact=${t.contact.id}`} className="text-primary hover:underline">
                        {contactLabel(t.contact)}
                      </Link>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </td>
                  <td className="whitespace-nowrap px-4 py-2.5">{t.dueDate ? overdue ? <Badge color="red">{fmtDateTime(t.dueDate)}</Badge> : <span className="text-foreground/85">{fmtDateTime(t.dueDate)}</span> : <span className="text-muted-foreground">—</span>}</td>
                  <td className="px-4 py-2.5 text-muted-foreground">{t.assignedTo ?? '—'}</td>
                </tr>
              )
            })}
          </Table>
        )}
      </Card>
      <ErrorNote error={q.error || save.error} />
      <Modal
        open={adding}
        onClose={() => setAdding(false)}
        title="Add task"
        footer={
          <>
            <Button onClick={() => setAdding(false)}>Cancel</Button>
            {/* datetime-local has no zone; the browser's reading of it is the one the user meant. */}
            <Button variant="primary" loading={save.isPending} disabled={!form.title.trim()} onClick={() => save.mutate({ ...form, dueDate: form.dueDate ? new Date(form.dueDate).toISOString() : '' })}>
              Add
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-3">
          <Field label="Title">
            <Input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />
          </Field>
          <Field label="Details">
            <Textarea rows={3} value={form.body} onChange={(e) => setForm({ ...form, body: e.target.value })} />
          </Field>
          <Field label="Due">
            <Input type="datetime-local" value={form.dueDate} onChange={(e) => setForm({ ...form, dueDate: e.target.value })} />
          </Field>
        </div>
      </Modal>
    </div>
  )
}
