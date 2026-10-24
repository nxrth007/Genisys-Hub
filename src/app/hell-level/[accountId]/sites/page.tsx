'use client'

import Link from 'next/link'
import { useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Check, Copy, ExternalLink, FileText, MessageCircle, Pencil, Plus } from 'lucide-react'
import { Badge, Button, Card, ErrorNote, Field, Input, Modal, PageHeader, Select, Spinner, copyText, hlFetch, timeAgo } from '@/components/hell-level/ui'
import { embedCode, lovablePrompt } from '@/components/hell-level/embed'

type FormRow = { id: string; name: string; kind: string; submissions: number; lastSubmissionAt: string | null; settings: { color?: string } }

export default function SitesPage() {
  const { accountId } = useParams<{ accountId: string }>()
  const router = useRouter()
  const qc = useQueryClient()
  const q = useQuery<{ forms: FormRow[] }>({ queryKey: ['hl', 'forms', accountId], queryFn: () => hlFetch(`/api/hl/accounts/${accountId}/forms`) })
  const [creating, setCreating] = useState(false)
  const [form, setForm] = useState({ name: '', kind: 'form' })
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
        title="Sites"
        description="The website stays on Lovable. These are the quote form and chat widget that go on it: leads from them land in Contacts and start the automations."
        actions={
          <Button variant="primary" icon={<Plus className="h-4 w-4" />} onClick={() => setCreating(true)}>
            New form
          </Button>
        }
      />
      {q.isLoading ? (
        <div className="flex justify-center py-20">
          <Spinner />
        </div>
      ) : (
        (q.data?.forms ?? []).map((f) => <FormCard key={f.id} accountId={accountId} f={f} origin={origin} />)
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
  return (
    <Card>
      <div className="flex flex-wrap items-center gap-4 border-b border-[#EAECF0] px-5 py-4">
        <span className={`grid h-10 w-10 place-items-center rounded-lg ${chat ? 'bg-[#F4F3FF] text-[#6938EF]' : 'bg-[#EFF4FF] text-[#155EEF]'}`}>
          {chat ? <MessageCircle className="h-5 w-5" /> : <FileText className="h-5 w-5" />}
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-[15px] font-semibold text-[#101828]">{f.name}</p>
          <p className="text-[13px] text-[#667085]">
            {chat ? 'Chat widget' : 'Form'} · {f.submissions} submission{f.submissions === 1 ? '' : 's'}
            {f.lastSubmissionAt ? ` · last ${timeAgo(f.lastSubmissionAt)}` : ''}
          </p>
        </div>
        {f.submissions > 0 ? <Badge color="green" dot>Receiving leads</Badge> : <Badge color="amber" dot>Not on the site yet</Badge>}
        <a href={`/hl/${chat ? 'c' : 'f'}/${f.id}`} target="_blank" rel="noreferrer" className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-[#D0D5DD] px-3 text-[13px] font-semibold text-[#344054] hover:bg-[#F9FAFB]">
          <ExternalLink className="h-3.5 w-3.5" /> Preview
        </a>
        <Link href={`/hell-level/${accountId}/sites/forms/${f.id}`} className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-[#D0D5DD] px-3 text-[13px] font-semibold text-[#344054] hover:bg-[#F9FAFB]">
          <Pencil className="h-3.5 w-3.5" /> Edit
        </Link>
      </div>
      <div className="flex flex-col gap-3 px-5 py-4">
        <div>
          <div className="mb-1.5 flex items-center justify-between">
            <p className="text-[13px] font-medium text-[#344054]">{chat ? 'Embed code (paste once, before </body>)' : 'Embed code (paste where the form goes)'}</p>
            <button type="button" onClick={() => copy('code', embedCode(origin, f))} className="inline-flex items-center gap-1 text-[13px] font-semibold text-[#155EEF] hover:underline">
              {copied === 'code' ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />} {copied === 'code' ? 'Copied' : 'Copy'}
            </button>
          </div>
          <pre className="overflow-x-auto whitespace-pre-wrap break-all rounded-lg bg-[#101828] px-3 py-2.5 font-mono text-[12px] leading-relaxed text-[#D0D5DD]">{embedCode(origin, f)}</pre>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-[#F9FAFB] px-3 py-2.5">
          <p className="text-[13px] text-[#475467]">Sites are built in Lovable: copy this ready-made prompt and paste it into the client’s Lovable project.</p>
          <Button size="sm" icon={copied === 'prompt' ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />} onClick={() => copy('prompt', lovablePrompt(origin, f))}>
            {copied === 'prompt' ? 'Copied' : 'Copy Lovable prompt'}
          </Button>
        </div>
      </div>
    </Card>
  )
}
