'use client'

import Link from 'next/link'
import { useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowDown, ArrowLeft, ArrowUp, Plus, Trash2 } from 'lucide-react'
import type { HlField, HlFieldType, HlFormSettings } from '@/lib/hl/types'
import { Button, Card, ErrorNote, Field, Input, Select, Spinner, Tabs, Textarea, fmtDateTime, hlFetch } from '@/components/hell-level/ui'

type FormDetail = {
  form: { id: string; name: string; kind: string; fields: HlField[]; settings: HlFormSettings }
  submissions: { id: string; createdAt: string; data: Record<string, unknown>; pageUrl: string | null; contact: { id: string; firstName: string | null; lastName: string | null } | null }[]
}

const TYPES: { value: HlFieldType; label: string }[] = [
  { value: 'text', label: 'Short text' },
  { value: 'textarea', label: 'Long text' },
  { value: 'phone', label: 'Phone' },
  { value: 'email', label: 'Email' },
  { value: 'select', label: 'Dropdown' },
]

export default function FormEditorPage() {
  const { accountId, formId } = useParams<{ accountId: string; formId: string }>()
  const q = useQuery<FormDetail>({ queryKey: ['hl', 'form', accountId, formId], queryFn: () => hlFetch(`/api/hl/accounts/${accountId}/forms/${formId}`) })
  if (!q.data) {
    return <div className="flex justify-center py-24">{q.error ? <ErrorNote error={q.error} /> : <Spinner />}</div>
  }
  return <FormEditor accountId={accountId} formId={formId} data={q.data} />
}

/** The editor proper: starts from the saved form and keeps its own working copy until Save. */
function FormEditor({ accountId, formId, data }: { accountId: string; formId: string; data: FormDetail }) {
  const router = useRouter()
  const qc = useQueryClient()
  const [name, setName] = useState(data.form.name)
  const [fields, setFields] = useState<HlField[]>(data.form.fields)
  const [settings, setSettings] = useState<HlFormSettings>(data.form.settings)
  const [tab, setTab] = useState<'build' | 'submissions'>('build')
  const [version, setVersion] = useState(0)

  const save = useMutation({
    mutationFn: () => hlFetch(`/api/hl/accounts/${accountId}/forms/${formId}`, { method: 'PATCH', json: { name, fields, settings } }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['hl', 'forms', accountId] })
      setVersion((v) => v + 1)
    },
  })
  const archive = useMutation({
    mutationFn: () => hlFetch(`/api/hl/accounts/${accountId}/forms/${formId}`, { method: 'DELETE' }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['hl', 'forms', accountId] })
      router.push(`/hell-level/${accountId}/sites`)
    },
  })

  const chat = data.form.kind === 'chat'
  const setField = (i: number, patch: Partial<HlField>) => setFields((fs) => fs.map((f, j) => (j === i ? { ...f, ...patch } : f)))
  const moveField = (i: number, d: -1 | 1) =>
    setFields((fs) => {
      const next = [...fs]
      const j = i + d
      if (j < 0 || j >= next.length) return fs
      ;[next[i], next[j]] = [next[j], next[i]]
      return next
    })

  return (
    <div className="mx-auto flex max-w-7xl flex-col gap-5 px-6 py-7">
      <div className="flex flex-wrap items-center gap-3">
        <Link href={`/hell-level/${accountId}/sites`} className="grid h-9 w-9 place-items-center rounded-lg text-[#475467] hover:bg-[#F2F4F7]">
          <ArrowLeft className="h-5 w-5" />
        </Link>
        <Input value={name} onChange={(e) => setName(e.target.value)} className="max-w-sm text-[16px] font-semibold" />
        <div className="ml-auto flex gap-2">
          <Button variant="ghost" className="text-[#D92D20]" loading={archive.isPending} onClick={() => window.confirm('Delete this form? Where it’s embedded it stops working. Submissions and contacts stay.') && archive.mutate()}>
            Delete
          </Button>
          <Button variant="primary" loading={save.isPending} onClick={() => save.mutate()}>
            Save
          </Button>
        </div>
      </div>
      <ErrorNote error={save.error || archive.error} />
      <Tabs tabs={[{ key: 'build', label: 'Build' }, { key: 'submissions', label: `Submissions (${data.submissions.length})` }]} value={tab} onChange={setTab} />

      {tab === 'build' ? (
        <div className="grid gap-5 lg:grid-cols-[1fr_420px]">
          <div className="flex flex-col gap-5">
            <Card className="p-5">
              <p className="mb-3 text-[15px] font-semibold text-[#101828]">Fields</p>
              <div className="flex flex-col gap-3">
                {fields.map((f, i) => (
                  <div key={i} className="rounded-lg border border-[#EAECF0] p-3">
                    <div className="grid gap-2 sm:grid-cols-[1fr_150px]">
                      <Input value={f.label} onChange={(e) => setField(i, { label: e.target.value })} placeholder="Label" />
                      <Select value={f.type} onChange={(e) => setField(i, { type: e.target.value as HlFieldType })}>
                        {TYPES.map((t) => (
                          <option key={t.value} value={t.value}>
                            {t.label}
                          </option>
                        ))}
                      </Select>
                    </div>
                    {f.type === 'select' && (
                      <Input
                        className="mt-2"
                        value={(f.options ?? []).join(', ')}
                        onChange={(e) => setField(i, { options: e.target.value.split(',').map((o) => o.trim()) })}
                        placeholder="Options, separated by commas"
                      />
                    )}
                    <div className="mt-2 flex flex-wrap items-center gap-3 text-[13px] text-[#475467]">
                      <label className="flex items-center gap-1.5">
                        <input type="checkbox" checked={!!f.required} onChange={(e) => setField(i, { required: e.target.checked })} /> Required
                      </label>
                      <Input value={f.placeholder ?? ''} onChange={(e) => setField(i, { placeholder: e.target.value })} placeholder="Placeholder (optional)" className="h-8 max-w-xs text-[13px]" />
                      <span className="ml-auto flex gap-1">
                        <button type="button" onClick={() => moveField(i, -1)} className="grid h-7 w-7 place-items-center rounded-md hover:bg-[#F2F4F7]" title="Move up">
                          <ArrowUp className="h-3.5 w-3.5" />
                        </button>
                        <button type="button" onClick={() => moveField(i, 1)} className="grid h-7 w-7 place-items-center rounded-md hover:bg-[#F2F4F7]" title="Move down">
                          <ArrowDown className="h-3.5 w-3.5" />
                        </button>
                        <button type="button" onClick={() => setFields((fs) => fs.filter((_, j) => j !== i))} className="grid h-7 w-7 place-items-center rounded-md text-[#D92D20] hover:bg-[#FEF3F2]" title="Remove">
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </span>
                    </div>
                    <p className="mt-1 text-[11.5px] text-[#98A2B3]">Merge field: {`{{form.${f.key || '…'}}}`}</p>
                  </div>
                ))}
                <Button icon={<Plus className="h-4 w-4" />} onClick={() => setFields((fs) => [...fs, { key: '', label: 'New field', type: 'text' }])}>
                  Add field
                </Button>
              </div>
            </Card>
            <Card className="flex flex-col gap-4 p-5">
              <p className="text-[15px] font-semibold text-[#101828]">Wording and look</p>
              <Field label="Heading">
                <Input value={settings.heading ?? ''} onChange={(e) => setSettings({ ...settings, heading: e.target.value })} />
              </Field>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Button text">
                  <Input value={settings.submitLabel ?? ''} onChange={(e) => setSettings({ ...settings, submitLabel: e.target.value })} />
                </Field>
                <Field label="Colour">
                  <div className="flex items-center gap-2">
                    <input type="color" value={settings.color ?? '#155EEF'} onChange={(e) => setSettings({ ...settings, color: e.target.value })} className="h-10 w-12 cursor-pointer rounded-lg border border-[#D0D5DD]" />
                    <Input value={settings.color ?? ''} onChange={(e) => setSettings({ ...settings, color: e.target.value })} />
                  </div>
                </Field>
              </div>
              <Field label="Thank-you message">
                <Textarea rows={2} value={settings.thankYou ?? ''} onChange={(e) => setSettings({ ...settings, thankYou: e.target.value })} />
              </Field>
              <Field label="Texting consent wording" hint="Shown next to the consent checkbox. Carriers check this when they verify the number, so keep the STOP/HELP and rates wording. {{business}} becomes the business name.">
                <Textarea rows={3} value={settings.consentText ?? ''} onChange={(e) => setSettings({ ...settings, consentText: e.target.value })} />
              </Field>
            </Card>
          </div>
          <div className="flex flex-col gap-2">
            <p className="text-[13px] font-medium text-[#344054]">Live preview {save.isSuccess ? '' : '(after you save)'}</p>
            <div className="overflow-hidden rounded-xl border border-[#EAECF0] bg-white shadow-sm">
              <iframe key={version} src={`/hl/${chat ? 'c' : 'f'}/${formId}`} title="Preview" className="h-[680px] w-full border-0" />
            </div>
          </div>
        </div>
      ) : (
        <Card>
          {!data.submissions.length ? (
            <p className="px-5 py-12 text-center text-[14px] text-[#667085]">No submissions yet.</p>
          ) : (
            <ul>
              {data.submissions.map((s) => (
                <li key={s.id} className="border-b border-[#EAECF0] px-5 py-3 last:border-0">
                  <div className="flex items-center justify-between gap-3">
                    {s.contact ? (
                      <Link href={`/hell-level/${accountId}/conversations?contact=${s.contact.id}`} className="text-[14px] font-semibold text-[#155EEF] hover:underline">
                        {[s.contact.firstName, s.contact.lastName].filter(Boolean).join(' ') || 'Contact'}
                      </Link>
                    ) : (
                      <span className="text-[14px] font-semibold text-[#101828]">Deleted contact</span>
                    )}
                    <span className="text-[12px] text-[#667085]">{fmtDateTime(s.createdAt)}</span>
                  </div>
                  <dl className="mt-1.5 grid gap-x-4 gap-y-0.5 text-[13px] sm:grid-cols-[160px_1fr]">
                    {Object.entries(s.data).map(([k, v]) => (
                      <div key={k} className="contents">
                        <dt className="text-[#667085]">{data.form.fields.find((f) => f.key === k)?.label ?? (k === 'sms_consent' ? 'Agreed to texts' : k)}</dt>
                        <dd className="whitespace-pre-wrap text-[#344054]">{typeof v === 'boolean' ? (v ? 'Yes' : 'No') : String(v)}</dd>
                      </div>
                    ))}
                  </dl>
                  {s.pageUrl && <p className="mt-1 truncate text-[12px] text-[#98A2B3]">From {s.pageUrl}</p>}
                </li>
              ))}
            </ul>
          )}
        </Card>
      )}
    </div>
  )
}
