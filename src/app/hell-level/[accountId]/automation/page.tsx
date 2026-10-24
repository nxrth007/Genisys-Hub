'use client'

import Link from 'next/link'
import { useMemo, useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Folder, Plus, Workflow, Zap } from 'lucide-react'
import { triggerLabel, type HlTrigger } from '@/lib/hl/types'
import { workflowTemplates } from '@/lib/hl/templates'
import { Badge, Button, Card, Empty, ErrorNote, Field, Input, Modal, PageHeader, Spinner, Toggle, hlFetch, timeAgo } from '@/components/hell-level/ui'

type WorkflowRow = {
  id: string
  name: string
  folder: string | null
  status: string
  trigger: HlTrigger
  steps: unknown[]
  template: string | null
  updatedAt: string
  runs30: number
  waiting: number
}

export default function AutomationPage() {
  const { accountId } = useParams<{ accountId: string }>()
  const router = useRouter()
  const qc = useQueryClient()
  const q = useQuery<{ workflows: WorkflowRow[] }>({ queryKey: ['hl', 'workflows', accountId], queryFn: () => hlFetch(`/api/hl/accounts/${accountId}/workflows`) })
  const [creating, setCreating] = useState(false)
  const [name, setName] = useState('')

  const create = useMutation({
    mutationFn: (body: Record<string, unknown>) => hlFetch<{ workflow: { id: string } }>(`/api/hl/accounts/${accountId}/workflows`, { method: 'POST', json: body }),
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: ['hl', 'workflows', accountId] })
      router.push(`/hell-level/${accountId}/automation/${r.workflow.id}`)
    },
  })
  const toggle = useMutation({
    mutationFn: (v: { id: string; status: string }) => hlFetch(`/api/hl/accounts/${accountId}/workflows/${v.id}`, { method: 'PATCH', json: { status: v.status } }),
    onSettled: () => qc.invalidateQueries({ queryKey: ['hl', 'workflows', accountId] }),
  })

  const folders = useMemo(() => {
    const m = new Map<string, WorkflowRow[]>()
    for (const w of q.data?.workflows ?? []) {
      const f = w.folder || 'Workflows'
      m.set(f, [...(m.get(f) ?? []), w])
    }
    return [...m.entries()]
  }, [q.data])

  const have = new Set((q.data?.workflows ?? []).map((w) => w.template))
  const missingTemplates = workflowTemplates().filter((t) => !have.has(t.key))

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-5 px-6 py-7">
      <PageHeader
        title="Workflows"
        description="What happens automatically when a lead comes in: texts back, owner alerts, pipeline moves."
        actions={
          <Button variant="primary" icon={<Plus className="h-4 w-4" />} onClick={() => setCreating(true)}>
            Create workflow
          </Button>
        }
      />
      {q.isLoading ? (
        <div className="flex justify-center py-20">
          <Spinner />
        </div>
      ) : !folders.length ? (
        <Card>
          <Empty icon={<Workflow className="h-5 w-5" />} title="No workflows" action={<Button variant="primary" onClick={() => setCreating(true)}>Create workflow</Button>}>
            Start from a template or a blank one.
          </Empty>
        </Card>
      ) : (
        folders.map(([folder, rows]) => (
          <Card key={folder}>
            <div className="flex items-center gap-2 border-b border-[#EAECF0] px-5 py-3">
              <Folder className="h-4 w-4 text-[#98A2B3]" />
              <p className="text-[14px] font-semibold text-[#101828]">{folder}</p>
              <span className="text-[13px] text-[#98A2B3]">{rows.length}</span>
            </div>
            <table className="w-full text-left text-[14px]">
              <thead>
                <tr className="border-b border-[#EAECF0] bg-[#F9FAFB] text-[12px] font-medium text-[#475467]">
                  <th className="px-5 py-2.5">Name</th>
                  <th className="px-4 py-2.5">Trigger</th>
                  <th className="px-4 py-2.5 text-right">Ran (30 days)</th>
                  <th className="px-4 py-2.5 text-right">Waiting</th>
                  <th className="px-4 py-2.5">Updated</th>
                  <th className="px-4 py-2.5">Status</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((w) => (
                  <tr key={w.id} className="border-b border-[#EAECF0] last:border-0 hover:bg-[#F9FAFB]">
                    <td className="px-5 py-3">
                      <Link href={`/hell-level/${accountId}/automation/${w.id}`} className="font-semibold text-[#101828] hover:text-[#155EEF]">
                        {w.name}
                      </Link>
                      <p className="text-[12px] text-[#667085]">{w.steps.length} action{w.steps.length === 1 ? '' : 's'}</p>
                    </td>
                    <td className="px-4 py-3">
                      <span className="inline-flex items-center gap-1.5 text-[13px] text-[#344054]">
                        <Zap className="h-3.5 w-3.5 text-[#F79009]" /> {triggerLabel(w.trigger.type)}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums text-[#344054]">{w.runs30}</td>
                    <td className="px-4 py-3 text-right tabular-nums text-[#344054]">{w.waiting}</td>
                    <td className="px-4 py-3 text-[#667085]">{timeAgo(w.updatedAt)}</td>
                    <td className="px-4 py-3">
                      <span className="flex items-center gap-2">
                        <Toggle
                          checked={w.status === 'published'}
                          onChange={(v) => toggle.mutate({ id: w.id, status: v ? 'published' : 'draft' })}
                          disabled={toggle.isPending}
                          label="Published"
                        />
                        <Badge color={w.status === 'published' ? 'green' : 'gray'}>{w.status === 'published' ? 'Published' : 'Draft'}</Badge>
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        ))
      )}
      <ErrorNote error={q.error || toggle.error} />

      <Modal
        open={creating}
        onClose={() => setCreating(false)}
        title="Create workflow"
        width="max-w-2xl"
        footer={
          <>
            <Button onClick={() => setCreating(false)}>Cancel</Button>
            <Button variant="primary" loading={create.isPending && !create.variables?.template} disabled={!name.trim()} onClick={() => create.mutate({ name })}>
              Start from scratch
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-5">
          <Field label="Name">
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Estimate follow-up" />
          </Field>
          <div>
            <p className="mb-2 text-[13px] font-medium text-[#344054]">Or start from a template</p>
            <div className="grid gap-2 sm:grid-cols-2">
              {workflowTemplates().map((t) => (
                <button
                  key={t.key}
                  type="button"
                  disabled={create.isPending}
                  onClick={() => create.mutate({ template: t.key })}
                  className="flex flex-col gap-1 rounded-lg border border-[#EAECF0] p-3 text-left transition hover:border-[#84ADFF] hover:bg-[#F5F8FF]"
                >
                  <span className="text-[14px] font-semibold text-[#101828]">{t.name}</span>
                  <span className="text-[12.5px] text-[#667085]">{t.description}</span>
                  {!missingTemplates.some((m) => m.key === t.key) && <span className="text-[11.5px] text-[#98A2B3]">Already in this sub-account; this adds another copy</span>}
                </button>
              ))}
            </div>
          </div>
          <ErrorNote error={create.error} />
        </div>
      </Modal>
    </div>
  )
}
