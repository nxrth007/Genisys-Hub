'use client'

import Link from 'next/link'
import { Suspense, useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Check, Copy, ExternalLink, FileText, MessageCircle, Pencil, Plus } from 'lucide-react'
import { Badge, Button, Card, ErrorNote, Field, Input, Modal, PageHeader, Select, Spinner, copyText, hlFetch, timeAgo } from '@/components/hell-level/ui'
import { embedCode, lovablePrompt } from '@/components/hell-level/embed'
import { NotYet, RecordsTable, rv, useSectionTab } from '@/components/hell-level/section'

type FormRow = { id: string; name: string; kind: string; ghlId: string | null; submissions: number; lastSubmissionAt: string | null; settings: { color?: string; imported?: boolean } }

export default function SitesPage() {
  return (
    <Suspense fallback={<div className="flex justify-center py-24"><Spinner /></div>}>
      <SitesSection />
    </Suspense>
  )
}

const NOT_YET: Record<string, { title: string; what: string }> = {
  stores: { title: 'Stores', what: 'GHL’s online store pages and checkout. Genisys bills clients through Whop.' },
  webinars: { title: 'Webinars', what: 'Webinar registration and replay funnels.' },
  analytics: { title: 'Analytics', what: 'Page views and conversions for GHL-hosted funnels. Client sites are on Lovable, with their own analytics.' },
  blogs: { title: 'Blogs', what: 'GHL’s blog posts. Client blogs are written by the Hub’s SEO engine into their Lovable sites.' },
  wordpress: { title: 'WordPress', what: 'GHL’s managed WordPress hosting.' },
  'client-portal': { title: 'Client Portal', what: 'A login area for the business’s own customers.' },
  quizzes: { title: 'Quizzes', what: 'Scored quiz funnels.' },
  'qr-codes': { title: 'QR Codes', what: 'QR codes that track scans to a page.' },
}

function SitesSection() {
  const { accountId } = useParams<{ accountId: string }>()
  const tab = useSectionTab('sites')
  if (tab === 'forms') return <FormsList kind="form" />
  if (tab === 'chat-widget') return <FormsList kind="chat" />
  if (tab === 'funnels' || tab === 'websites')
    return (
      <RecordsTable
        accountId={accountId}
        kind={tab === 'funnels' ? 'funnel' : 'website'}
        title={tab === 'funnels' ? 'Funnels' : 'Websites'}
        emptyText={tab === 'funnels' ? 'Funnels from GoHighLevel show up here after the import (names and steps; GHL’s API has no export of the pages themselves).' : 'GHL-hosted websites show up here after the import. Client websites are built in Lovable.'}
        columns={[
          { label: 'Name', render: (r) => <span className="font-medium text-foreground">{r.name}</span> },
          { label: 'Steps', render: (r) => <span className="tabular-nums">{Array.isArray(r.data.steps) ? r.data.steps.length : '—'}</span> },
          { label: 'Domain', render: (r) => <span className="break-all text-muted-foreground">{rv(r, 'domainName', 'url') || '—'}</span> },
        ]}
      />
    )
  if (tab === 'surveys')
    return (
      <RecordsTable
        accountId={accountId}
        kind="survey"
        title="Surveys"
        emptyText="Surveys from GoHighLevel show up here after the import."
        columns={[{ label: 'Name', render: (r) => <span className="font-medium text-foreground">{r.name}</span> }]}
      />
    )
  const n = NOT_YET[tab]
  return <NotYet title={n?.title ?? 'Sites'} what={n?.what ?? 'Not in Hell-level yet.'} />
}

function FormsList({ kind }: { kind: 'form' | 'chat' }) {
  const { accountId } = useParams<{ accountId: string }>()
  const router = useRouter()
  const qc = useQueryClient()
  const q = useQuery<{ forms: FormRow[] }>({ queryKey: ['hl', 'forms', accountId], queryFn: () => hlFetch(`/api/hl/accounts/${accountId}/forms`) })
  const [creating, setCreating] = useState(false)
  const [form, setForm] = useState<{ name: string; kind: string }>({ name: '', kind })
  const create = useMutation({
    mutationFn: () => hlFetch<{ form: { id: string } }>(`/api/hl/accounts/${accountId}/forms`, { method: 'POST', json: form }),
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: ['hl', 'forms', accountId] })
      router.push(`/hell-level/${accountId}/sites/forms/${r.form.id}`)
    },
  })
  const origin = typeof window === 'undefined' ? '' : window.location.origin

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-5 px-6 py-7">
      <PageHeader
        title={kind === 'chat' ? 'Chat Widget' : 'Forms'}
        description={
          kind === 'chat'
            ? 'The chat bubble on the client’s website: messages land in Conversations and start the chat automation.'
            : 'Forms for the client’s Lovable site: submissions land in Contacts and start the form automations.'
        }
        actions={
          <Button variant="primary" icon={<Plus className="h-4 w-4" />} onClick={() => setCreating(true)}>
            {kind === 'chat' ? 'New chat widget' : 'New form'}
          </Button>
        }
      />
      {q.isLoading ? (
        <div className="flex justify-center py-20">
          <Spinner />
        </div>
      ) : (
        (q.data?.forms ?? []).filter((f) => f.kind === kind).map((f) => <FormCard key={f.id} accountId={accountId} f={f} origin={origin} />)
      )}
      <ErrorNote error={q.error} />
      <Modal
        open={creating}
        onClose={() => setCreating(false)}
        title="New form"
        footer={
          <>
            <Button onClick={() => setCreating(false)}>Cancel</Button>
            <Button variant="primary" loading={create.isPending} disabled={!form.name.trim()} onClick={() => create.mutate()}>
              Create
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-4">
          <Field label="Name">
            <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Estimate request" />
          </Field>
          <Field label="Kind">
            <Select value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value })}>
              <option value="form">Form (embedded on a page)</option>
              <option value="chat">Chat widget (bubble in the corner)</option>
            </Select>
          </Field>
          <ErrorNote error={create.error} />
        </div>
      </Modal>
    </div>
  )
}

function FormCard({ accountId, f, origin }: { accountId: string; f: FormRow; origin: string }) {
  const [copied, setCopied] = useState<string | null>(null)
  const copy = (what: string, text: string) => {
    copyText(text)
    setCopied(what)
    setTimeout(() => setCopied(null), 1500)
  }
  const chat = f.kind === 'chat'
  // A GHL form came over as its submissions; GHL's API doesn't give its fields, so there's nothing to embed.
  const imported = !!f.ghlId || f.settings?.imported === true
  return (
    <Card>
      <div className="flex flex-wrap items-center gap-4 border-b border-border px-5 py-4">
        <span className={`grid h-10 w-10 place-items-center rounded-lg ${chat ? 'chip-violet' : 'bg-primary-soft text-primary'}`}>
          {chat ? <MessageCircle className="h-5 w-5" /> : <FileText className="h-5 w-5" />}
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-[15px] font-semibold text-foreground">{f.name}</p>
          <p className="text-[13px] text-muted-foreground">
            {chat ? 'Chat widget' : 'Form'} · {f.submissions} submission{f.submissions === 1 ? '' : 's'}
            {f.lastSubmissionAt ? ` · last ${timeAgo(f.lastSubmissionAt)}` : ''}
          </p>
        </div>
        {imported ? <Badge color="purple">Imported from GHL</Badge> : f.submissions > 0 ? <Badge color="green" dot>Receiving leads</Badge> : <Badge color="amber" dot>Not on the site yet</Badge>}
        <a href={`/hl/${chat ? 'c' : 'f'}/${f.id}`} target="_blank" rel="noreferrer" className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-border px-3 text-[13px] font-semibold text-foreground/90 hover:bg-muted/50">
          <ExternalLink className="h-3.5 w-3.5" /> Preview
        </a>
        <Link href={`/hell-level/${accountId}/sites/forms/${f.id}`} className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-border px-3 text-[13px] font-semibold text-foreground/90 hover:bg-muted/50">
          <Pencil className="h-3.5 w-3.5" /> Edit
        </Link>
      </div>
      {imported ? (
        <p className="px-5 py-4 text-[13px] text-muted-foreground">
          Its {f.submissions} submission{f.submissions === 1 ? '' : 's'} came over from GoHighLevel and are under Edit → Submissions. To collect new ones here, make a new form and swap it into the site.
        </p>
      ) : (
      <div className="flex flex-col gap-3 px-5 py-4">
        <div>
          <div className="mb-1.5 flex items-center justify-between">
            <p className="text-[13px] font-medium text-foreground/90">{chat ? 'Embed code (paste once, before </body>)' : 'Embed code (paste where the form goes)'}</p>
            <button type="button" onClick={() => copy('code', embedCode(origin, f))} className="inline-flex items-center gap-1 text-[13px] font-semibold text-primary hover:underline">
              {copied === 'code' ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />} {copied === 'code' ? 'Copied' : 'Copy'}
            </button>
          </div>
          <pre className="overflow-x-auto whitespace-pre-wrap break-all rounded-lg bg-background px-3 py-2.5 font-mono text-[12px] leading-relaxed text-muted-foreground">{embedCode(origin, f)}</pre>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-surface-muted px-3 py-2.5">
          <p className="text-[13px] text-muted-foreground">Sites are built in Lovable: copy this ready-made prompt and paste it into the client’s Lovable project.</p>
          <Button size="sm" icon={copied === 'prompt' ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />} onClick={() => copy('prompt', lovablePrompt(origin, f))}>
            {copied === 'prompt' ? 'Copied' : 'Copy Lovable prompt'}
          </Button>
        </div>
      </div>
      )}
    </Card>
  )
}
