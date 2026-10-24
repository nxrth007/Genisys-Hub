'use client'

import Link from 'next/link'
import { Suspense, useEffect, useRef, useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { useMutation, useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query'
import { ChevronRight, EllipsisVertical, FolderClosed, FolderPlus, Plus, Search, Workflow, Zap } from 'lucide-react'
import { cn } from '@/lib/utils'
import { triggerLabel, type HlTrigger } from '@/lib/hl/types'
import { workflowTemplates } from '@/lib/hl/templates'
import { useSectionTab } from '@/components/hell-level/section'
import { Badge, Button, Card, Empty, ErrorNote, Field, Input, Modal, PageHeader, Spinner, Table, fmtDateTime, hlFetch } from '@/components/hell-level/ui'

type WorkflowRow = {
  id: string
  name: string
  folder: string | null
  status: string
  trigger: HlTrigger
  steps: unknown[]
  template: string | null
  ghlId: string | null
  meta: { ghlStatus?: string | null }
  deletedAt: string | null
  updatedAt: string
  createdAt: string
  runs: number
  waiting: number
  errors7d: number
}
type ListResponse = { workflows: WorkflowRow[]; folders: string[] }

export default function AutomationPage() {
  return (
    <Suspense fallback={<div className="flex justify-center py-24"><Spinner /></div>}>
      <AutomationSection />
    </Suspense>
  )
}

function AutomationSection() {
  const { accountId } = useParams<{ accountId: string }>()
  const tab = useSectionTab('automation')
  const q = useQuery<ListResponse>({ queryKey: ['hl', 'workflows', accountId], queryFn: () => hlFetch(`/api/hl/accounts/${accountId}/workflows`) })
  if (tab === 'overview') return <Overview accountId={accountId} data={q.data} />
  if (tab === 'settings') return <GlobalSettings accountId={accountId} />
  return <WorkflowsList accountId={accountId} q={q} />
}

/** Automation → Workflows, laid out like GHL's "Workflows list". */
function WorkflowsList({ accountId, q }: { accountId: string; q: UseQueryResult<ListResponse> }) {
  const router = useRouter()
  const qc = useQueryClient()
  const [view, setView] = useState<'all' | 'review' | 'deleted'>('all')
  const [folder, setFolder] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [creating, setCreating] = useState(false)
  const [newFolder, setNewFolder] = useState<string | null>(null)
  const refresh = () => qc.invalidateQueries({ queryKey: ['hl', 'workflows', accountId] })

  const act = useMutation({
    mutationFn: (v: { id: string; method: 'PATCH' | 'DELETE'; body?: Record<string, unknown>; permanent?: boolean }) =>
      hlFetch(`/api/hl/accounts/${accountId}/workflows/${v.id}${v.permanent ? '?permanent=1' : ''}`, { method: v.method, ...(v.body ? { json: v.body } : {}) }),
    onSuccess: refresh,
  })
  const makeFolder = useMutation({
    mutationFn: (name: string) => hlFetch(`/api/hl/accounts/${accountId}/workflows`, { method: 'POST', json: { createFolder: name } }),
    onSuccess: () => {
      refresh()
      setNewFolder(null)
    },
  })

  const all = q.data?.workflows ?? []
  const live = all.filter((w) => !w.deletedAt)
  const deleted = all.filter((w) => w.deletedAt)
  const review = live.filter((w) => w.errors7d > 0)
  const s = search.trim().toLowerCase()
  const pool = view === 'deleted' ? deleted : view === 'review' ? review : live
  const searching = !!s
  const rows = pool.filter((w) => (searching ? w.name.toLowerCase().includes(s) : view !== 'all' || (folder ? w.folder === folder : !w.folder)))
  const folders = view === 'all' && !folder && !searching ? (q.data?.folders ?? []) : []

  return (
    <div className="mx-auto flex max-w-7xl flex-col gap-4 px-6 py-6">
      <PageHeader
        title="Workflows list"
        actions={
          <>
            <Button icon={<FolderPlus className="h-3.5 w-3.5" />} onClick={() => setNewFolder('')}>
              Create folder
            </Button>
            <Button variant="primary" icon={<Plus className="h-3.5 w-3.5" />} onClick={() => setCreating(true)}>
              Create workflow
            </Button>
          </>
        }
      />
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border">
        <div className="flex gap-1">
          {(
            [
              ['all', 'All workflows'],
              ['review', `Needs review (${review.length})`],
              ['deleted', 'Deleted'],
            ] as const
          ).map(([k, label]) => (
            <button
              key={k}
              type="button"
              onClick={() => {
                setView(k)
                setFolder(null)
              }}
              className={cn('-mb-px border-b-2 px-3 pb-2.5 pt-1 text-[13px] transition', view === k ? 'border-primary text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground')}
            >
              {label}
            </button>
          ))}
        </div>
        <label className="mb-2 flex h-8 w-64 items-center gap-2 rounded-md border border-border bg-surface px-2.5 text-muted-foreground focus-within:border-primary/50">
          <Search className="h-3.5 w-3.5" />
          <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search" className="w-full bg-transparent text-[13px] text-foreground outline-none" />
        </label>
      </div>
      {view === 'all' && !searching && (
        <nav className="flex items-center gap-1.5 font-mono text-[12px] text-muted-foreground">
          <button type="button" onClick={() => setFolder(null)} className={cn('hover:text-foreground', !folder && 'text-foreground')}>
            Home
          </button>
          {folder && (
            <>
              <ChevronRight className="h-3 w-3" />
              <span className="text-foreground">{folder}</span>
            </>
          )}
        </nav>
      )}
      <Card>
        {q.isLoading ? (
          <div className="flex justify-center py-14">
            <Spinner />
          </div>
        ) : !rows.length && !folders.length ? (
          <Empty icon={<Workflow className="h-5 w-5" />} title={view === 'deleted' ? 'Nothing deleted' : view === 'review' ? 'Nothing needs review' : 'No workflows here'}>
            {view === 'review' ? 'Workflows with a failed step in the last 7 days show up here.' : view === 'deleted' ? 'Deleted workflows wait here until restored.' : 'Create one, or move one into this folder.'}
          </Empty>
        ) : (
          <Table head={['Name', 'Status', 'Total enrolled', 'Active enrolled', 'Last updated', 'Created on', '']}>
            {folders.map((f) => {
              const inside = live.filter((w) => w.folder === f)
              const updated = inside.map((w) => w.updatedAt).sort().at(-1)
              return (
                <tr key={`f:${f}`} onClick={() => setFolder(f)} className="cursor-pointer border-b border-border-soft hover:bg-muted/40">
                  <td className="px-4 py-3">
                    <span className="flex items-center gap-2.5 font-medium text-foreground">
                      <FolderClosed className="h-4 w-4 text-muted-foreground" /> {f}
                      <span className="font-mono text-[11px] text-muted-foreground">{inside.length}</span>
                    </span>
                  </td>
                  <td className="px-4 py-3" />
                  <td className="px-4 py-3 tabular-nums text-muted-foreground">{inside.reduce((n, w) => n + w.runs, 0) || ''}</td>
                  <td className="px-4 py-3 tabular-nums text-muted-foreground">{inside.reduce((n, w) => n + w.waiting, 0) || ''}</td>
                  <td className="whitespace-nowrap px-4 py-3 text-muted-foreground">{updated ? fmtDateTime(updated) : ''}</td>
                  <td className="px-4 py-3" />
                  <td className="px-4 py-3 text-right">
                    <ChevronRight className="ml-auto h-4 w-4 text-muted-foreground" />
                  </td>
                </tr>
              )
            })}
            {rows.map((w) => (
              <tr key={w.id} className="border-b border-border-soft last:border-0 hover:bg-muted/40">
                <td className="px-4 py-3">
                  <Link href={`/hell-level/${accountId}/automation/${w.id}`} className="font-medium text-foreground hover:text-primary">
                    {w.name}
                  </Link>
                  <p className="flex items-center gap-1.5 text-[12px] text-muted-foreground">
                    <Zap className="h-3 w-3 text-warning" /> {triggerLabel(w.trigger.type)} · {w.steps.length} action{w.steps.length === 1 ? '' : 's'}
                    {w.ghlId && <span className="font-mono text-[11px]">· from GHL{w.meta?.ghlStatus ? ` (${w.meta.ghlStatus} there)` : ''}</span>}
                  </p>
                </td>
                <td className="px-4 py-3">{w.deletedAt ? <Badge color="red">Deleted</Badge> : <Badge color={w.status === 'published' ? 'green' : 'gray'}>{w.status === 'published' ? 'Published' : 'Draft'}</Badge>}</td>
                <td className="px-4 py-3 tabular-nums text-foreground/85">{w.runs}</td>
                <td className="px-4 py-3 tabular-nums text-foreground/85">{w.waiting}</td>
                <td className="whitespace-nowrap px-4 py-3 text-muted-foreground">{fmtDateTime(w.updatedAt)}</td>
                <td className="whitespace-nowrap px-4 py-3 text-muted-foreground">{fmtDateTime(w.createdAt)}</td>
                <td className="px-4 py-3 text-right">
                  <RowMenu
                    items={
                      w.deletedAt
                        ? [
                            { label: 'Restore', run: () => act.mutate({ id: w.id, method: 'PATCH', body: { restore: true } }) },
                            { label: 'Delete forever', danger: true, run: () => window.confirm(`Delete “${w.name}” and its history for good?`) && act.mutate({ id: w.id, method: 'DELETE', permanent: true }) },
                          ]
                        : [
                            { label: 'Edit', run: () => router.push(`/hell-level/${accountId}/automation/${w.id}`) },
                            ...[null, ...(q.data?.folders ?? [])]
                              .filter((f) => f !== w.folder)
                              .map((f) => ({ label: f ? `Move to ${f}` : 'Move to Home', run: () => act.mutate({ id: w.id, method: 'PATCH', body: { folder: f ?? '' } }) })),
                            { label: 'Delete', danger: true, run: () => act.mutate({ id: w.id, method: 'DELETE' }) },
                          ]
                    }
                  />
                </td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
      <ErrorNote error={q.error || act.error || makeFolder.error} />
      {creating && <CreateWorkflow accountId={accountId} folder={folder} onClose={() => setCreating(false)} />}
      <Modal
        open={newFolder !== null}
        onClose={() => setNewFolder(null)}
        title="Create folder"
        footer={
          <>
            <Button onClick={() => setNewFolder(null)}>Cancel</Button>
            <Button variant="primary" loading={makeFolder.isPending} disabled={!newFolder?.trim()} onClick={() => newFolder && makeFolder.mutate(newFolder.trim())}>
              Create
            </Button>
          </>
        }
      >
        <Field label="Folder name">
          <Input autoFocus value={newFolder ?? ''} onChange={(e) => setNewFolder(e.target.value)} />
        </Field>
      </Modal>
    </div>
  )
}

function RowMenu({ items }: { items: { label: string; run: () => void; danger?: boolean }[] }) {
  const [open, setOpen] = useState(false)
  const box = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false)
    }
    window.addEventListener('mousedown', onDown)
    return () => window.removeEventListener('mousedown', onDown)
  }, [open])
  return (
    <div ref={box} className="relative inline-block text-left">
      <button type="button" onClick={() => setOpen((o) => !o)} className="grid h-7 w-7 place-items-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground" aria-label="Actions">
        <EllipsisVertical className="h-4 w-4" />
      </button>
      {open && (
        <div className="absolute right-0 top-full z-30 mt-1 min-w-44 overflow-hidden rounded-md border border-border bg-popover py-1 shadow-pop">
          {items.map((it) => (
            <button
              key={it.label}
              type="button"
              onClick={() => {
                setOpen(false)
                it.run()
              }}
              className={cn('block w-full px-3 py-1.5 text-left text-[13px] hover:bg-muted', it.danger ? 'text-destructive' : 'text-foreground')}
            >
              {it.label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

function CreateWorkflow({ accountId, folder, onClose }: { accountId: string; folder: string | null; onClose: () => void }) {
  const router = useRouter()
  const qc = useQueryClient()
  const [name, setName] = useState('')
  const create = useMutation({
    mutationFn: (body: Record<string, unknown>) => hlFetch<{ workflow: { id: string } }>(`/api/hl/accounts/${accountId}/workflows`, { method: 'POST', json: { ...body, folder: folder ?? undefined } }),
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: ['hl', 'workflows', accountId] })
      router.push(`/hell-level/${accountId}/automation/${r.workflow.id}`)
    },
  })
  return (
    <Modal
      open
      onClose={onClose}
      title="Create workflow"
      description={folder ? `In “${folder}”.` : undefined}
      width="max-w-2xl"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
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
          <p className="eyebrow mb-2 text-muted-foreground">Or start from a recipe</p>
          <div className="grid gap-2 sm:grid-cols-2">
            {workflowTemplates().map((t) => (
              <button
                key={t.key}
                type="button"
                disabled={create.isPending}
                onClick={() => create.mutate({ template: t.key })}
                className="flex flex-col gap-1 rounded-md border border-border bg-surface p-3 text-left transition hover:border-primary/50 hover:bg-primary-soft"
              >
                <span className="text-[13px] font-medium text-foreground">{t.name}</span>
                <span className="text-[12px] text-muted-foreground">{t.description}</span>
              </button>
            ))}
          </div>
        </div>
        <ErrorNote error={create.error} />
      </div>
    </Modal>
  )
}

function Overview({ accountId, data }: { accountId: string; data: ListResponse | undefined }) {
  const live = (data?.workflows ?? []).filter((w) => !w.deletedAt)
  const stats = [
    ['Published', live.filter((w) => w.status === 'published').length],
    ['Drafts', live.filter((w) => w.status !== 'published').length],
    ['Total enrolled', live.reduce((n, w) => n + w.runs, 0)],
    ['Active enrolled', live.reduce((n, w) => n + w.waiting, 0)],
    ['Errors (7 days)', live.reduce((n, w) => n + w.errors7d, 0)],
  ] as const
  const busiest = [...live].sort((a, b) => b.runs - a.runs).slice(0, 8)
  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-5 px-6 py-6">
      <PageHeader title="Overview" description="How this sub-account’s automations are doing." />
      <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
        {stats.map(([label, n]) => (
          <Card key={label} className="p-4">
            <p className="eyebrow text-muted-foreground">{label}</p>
            <p className="mt-2 text-[26px] font-semibold tabular-nums text-foreground">{n.toLocaleString('en-US')}</p>
          </Card>
        ))}
      </div>
      <Card>
        <p className="border-b border-border px-4 py-3 text-[14px] font-medium text-foreground">Most enrolled</p>
        {busiest.length ? (
          <Table head={['Workflow', 'Status', 'Total enrolled', 'Active', 'Errors (7d)']}>
            {busiest.map((w) => (
              <tr key={w.id} className="border-b border-border-soft last:border-0">
                <td className="px-4 py-2.5">
                  <Link href={`/hell-level/${accountId}/automation/${w.id}`} className="text-foreground hover:text-primary">
                    {w.name}
                  </Link>
                </td>
                <td className="px-4 py-2.5">
                  <Badge color={w.status === 'published' ? 'green' : 'gray'}>{w.status}</Badge>
                </td>
                <td className="px-4 py-2.5 tabular-nums">{w.runs}</td>
                <td className="px-4 py-2.5 tabular-nums">{w.waiting}</td>
                <td className="px-4 py-2.5 tabular-nums">{w.errors7d ? <Badge color="red">{w.errors7d}</Badge> : 0}</td>
              </tr>
            ))}
          </Table>
        ) : (
          <p className="px-4 py-8 text-center text-[13px] text-muted-foreground">No workflows yet.</p>
        )}
      </Card>
    </div>
  )
}

function GlobalSettings({ accountId }: { accountId: string }) {
  const rules: [string, string][] = [
    ['Quiet hours', 'Texts that come after a Wait step hold between 9 PM and 8 AM in the sub-account’s timezone and go out at 9 AM. Instant replies (missed call, form, chat) go straight away.'],
    ['Opt-out', 'A contact’s first text gets “Reply STOP to opt out.” STOP and its synonyms stop all texts until they reply START.'],
    ['Texting consent', 'Automations text only contacts who ticked the consent box, or who called or texted first.'],
    ['Re-entry', 'The same trigger for the same contact within a minute is ignored (a retried webhook can’t double-send). Each workflow decides whether a contact can go through it again.'],
    ['Owner alerts', 'Internal texts come from the sub-account’s number once it is approved, from the Hub’s number until then.'],
  ]
  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-5 px-6 py-6">
      <PageHeader title="Global Workflow Settings" description="Rules every workflow in this sub-account follows." />
      <Card>
        {rules.map(([k, v]) => (
          <div key={k} className="grid gap-1 border-b border-border-soft px-5 py-4 last:border-0 md:grid-cols-[180px_1fr]">
            <p className="eyebrow pt-0.5 text-muted-foreground">{k}</p>
            <p className="text-[13px] text-foreground/90">{v}</p>
          </div>
        ))}
      </Card>
      <p className="text-[12.5px] text-muted-foreground">
        The timezone is under{' '}
        <Link href={`/hell-level/${accountId}/settings?tab=business-profile`} className="text-primary hover:underline">
          Settings → Business Profile
        </Link>
        .
      </p>
    </div>
  )
}
