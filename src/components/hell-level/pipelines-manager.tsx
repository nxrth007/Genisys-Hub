'use client'

import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowDown, ArrowUp, Plus, Trash2 } from 'lucide-react'
import type { HlStage } from '@/lib/hl/types'
import { Button, Card, ErrorNote, Input, Spinner, hlFetch } from './ui'
import { confirmAction } from './confirm'

/** Pipelines and their stages: Opportunities → Pipelines, and Settings → Opportunities & Pipelines. */
export function PipelinesManager({ accountId }: { accountId: string }) {
  const qc = useQueryClient()
  const q = useQuery<{ pipelines: { id: string; name: string; stages: HlStage[]; opportunities: unknown[] }[] }>({
    queryKey: ['hl', 'pipelines', accountId],
    queryFn: () => hlFetch(`/api/hl/accounts/${accountId}/pipelines`),
  })
  const add = useMutation({
    mutationFn: () => hlFetch(`/api/hl/accounts/${accountId}/pipelines`, { method: 'POST', json: { name: 'New pipeline', stages: [{ name: 'New' }, { name: 'In progress' }, { name: 'Done' }] } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['hl', 'pipelines', accountId] }),
  })
  if (!q.data) return <div className="flex justify-center py-10">{q.error ? <ErrorNote error={q.error} /> : <Spinner />}</div>
  return (
    <div className="flex flex-col gap-4">
      {q.data.pipelines.map((p) => (
        <PipelineEditor key={p.id} accountId={accountId} pipeline={p} canDelete={q.data!.pipelines.length > 1} />
      ))}
      <Button icon={<Plus className="h-4 w-4" />} loading={add.isPending} onClick={() => add.mutate()} className="self-start">
        Add pipeline
      </Button>
      <ErrorNote error={add.error} />
    </div>
  )
}

function PipelineEditor({ accountId, pipeline, canDelete }: { accountId: string; pipeline: { id: string; name: string; stages: HlStage[]; opportunities: unknown[] }; canDelete: boolean }) {
  const qc = useQueryClient()
  const [name, setName] = useState(pipeline.name)
  const [stages, setStages] = useState<{ id?: string; name: string }[]>(pipeline.stages)
  const save = useMutation({
    mutationFn: () => hlFetch(`/api/hl/accounts/${accountId}/pipelines/${pipeline.id}`, { method: 'PATCH', json: { name, stages } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['hl', 'pipelines', accountId] }),
  })
  const del = useMutation({
    mutationFn: () => hlFetch(`/api/hl/accounts/${accountId}/pipelines/${pipeline.id}`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['hl', 'pipelines', accountId] }),
  })
  const move = (i: number, d: -1 | 1) =>
    setStages((s) => {
      const next = [...s]
      const j = i + d
      if (j < 0 || j >= next.length) return s
      ;[next[i], next[j]] = [next[j], next[i]]
      return next
    })
  return (
    <Card className="flex flex-col gap-4 p-5">
      <div className="flex items-center gap-3">
        <Input value={name} onChange={(e) => setName(e.target.value)} className="max-w-sm font-semibold" />
        <span className="text-[13px] text-muted-foreground">{pipeline.opportunities.length} opportunities</span>
      </div>
      <div className="flex flex-col gap-2">
        {stages.map((s, i) => (
          <div key={s.id ?? `new-${i}`} className="flex items-center gap-2">
            <span className="w-6 text-right text-[12px] text-muted-foreground/70">{i + 1}</span>
            <Input value={s.name} onChange={(e) => setStages((all) => all.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} className="max-w-md" />
            <button type="button" onClick={() => move(i, -1)} className="grid h-8 w-8 place-items-center rounded-md hover:bg-muted" title="Move up">
              <ArrowUp className="h-3.5 w-3.5" />
            </button>
            <button type="button" onClick={() => move(i, 1)} className="grid h-8 w-8 place-items-center rounded-md hover:bg-muted" title="Move down">
              <ArrowDown className="h-3.5 w-3.5" />
            </button>
            <button type="button" onClick={() => setStages((all) => all.filter((_, j) => j !== i))} className="grid h-8 w-8 place-items-center rounded-md text-destructive hover:bg-destructive/10" title="Remove stage">
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          </div>
        ))}
        <Button size="sm" icon={<Plus className="h-3.5 w-3.5" />} className="self-start" onClick={() => setStages((s) => [...s, { name: 'New stage' }])}>
          Add stage
        </Button>
      </div>
      <ErrorNote error={save.error || del.error} />
      <div className="flex justify-between border-t border-border pt-4">
        {canDelete ? (
          <Button variant="ghost" className="text-destructive" loading={del.isPending} onClick={() => void confirmAction(`Delete the “${pipeline.name}” pipeline?`, 'Delete pipeline').then((ok) => ok && del.mutate())}>
            Delete pipeline
          </Button>
        ) : (
          <span />
        )}
        <Button variant="primary" loading={save.isPending} onClick={() => save.mutate()}>
          Save pipeline
        </Button>
      </div>
    </Card>
  )
}
