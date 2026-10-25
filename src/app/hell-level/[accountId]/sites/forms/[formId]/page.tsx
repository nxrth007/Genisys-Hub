'use client'

import Link from 'next/link'
import { useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowDown, ArrowLeft, ArrowUp, Plus, RefreshCw, Trash2, TriangleAlert } from 'lucide-react'
import { cn } from '@/lib/utils'
import { MARKETING_CONSENT_TEXT, SMS_CONSENT_TEXT } from '@/lib/hl/templates'
import type { HlConsentBox, HlField, HlFieldType, HlFormSettings } from '@/lib/hl/types'
import { Button, Card, ErrorNote, Field, Input, Select, Spinner, Tabs, Textarea, Toggle, fmtDateTime, hlFetch } from '@/components/hell-level/ui'
import { confirmAction } from '@/components/hell-level/confirm'

type FormDetail = {
  form: { id: string; name: string; kind: string; fields: HlField[]; settings: HlFormSettings & { consents: HlConsentBox[] } }
  submissions: { id: string; createdAt: string; data: Record<string, unknown>; pageUrl: string | null; contact: { id: string; firstName: string | null; lastName: string | null } | null }[]
  /** What blank settings fall back to. */
  defaults: { business: string; privacy: string; terms: string; fromProfile: { privacy: boolean; terms: boolean }; logo: string | null }
}

const CONSENT_KINDS: { kind: HlConsentBox['kind']; label: string; text: string }[] = [
  { kind: 'sms', label: 'Texts about their request', text: SMS_CONSENT_TEXT },
  { kind: 'marketing', label: 'Promotional texts', text: MARKETING_CONSENT_TEXT },
]

/** Colours a form can set, with the plain look's values when it doesn't. */
const COLOURS: { key: keyof HlFormSettings; label: string; fallback: string }[] = [
  { key: 'color', label: 'Button', fallback: '#155EEF' },
  { key: 'buttonText', label: 'Button text', fallback: '#FFFFFF' },
  { key: 'textColor', label: 'Heading and labels', fallback: '#101828' },
  { key: 'inputBackground', label: 'Input background', fallback: '#FFFFFF' },
  { key: 'inputText', label: 'Input text', fallback: '#101828' },
  { key: 'inputBorder', label: 'Input border', fallback: '#D0D5DD' },
]

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

  const [defaults, setDefaults] = useState(data.defaults)
  const save = useMutation({
    mutationFn: () => hlFetch(`/api/hl/accounts/${accountId}/forms/${formId}`, { method: 'PATCH', json: { name, fields, settings } }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['hl', 'forms', accountId] })
      setVersion((v) => v + 1)
    },
  })
  const lookAgain = useMutation({
    mutationFn: () => hlFetch<FormDetail>(`/api/hl/accounts/${accountId}/forms/${formId}?lookLegal=1`),
    onSuccess: (d) => {
      setDefaults(d.defaults)
      qc.invalidateQueries({ queryKey: ['hl', 'account', accountId] })
    },
  })
  const consents = settings.consents ?? []
  const setConsent = (kind: HlConsentBox['kind'], patch: Partial<HlConsentBox>) =>
    setSettings((s) => ({ ...s, consents: (s.consents ?? []).map((c) => (c.kind === kind ? { ...c, ...patch } : c)) }))
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
        <Link href={`/hell-level/${accountId}/sites`} className="grid h-9 w-9 place-items-center rounded-lg text-muted-foreground hover:bg-muted">
          <ArrowLeft className="h-5 w-5" />
        </Link>
        <Input value={name} onChange={(e) => setName(e.target.value)} className="max-w-sm text-[16px] font-semibold" />
        <div className="ml-auto flex gap-2">
          <Button variant="ghost" className="text-destructive" loading={archive.isPending} onClick={() => void confirmAction('Delete this form? Where it’s embedded it stops working. Submissions and contacts stay.', 'Delete form').then((ok) => ok && archive.mutate())}>
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
              <p className="mb-3 text-[15px] font-semibold text-foreground">Fields</p>
              <div className="flex flex-col gap-3">
                {fields.map((f, i) => (
                  <div key={i} className="rounded-lg border border-border p-3">
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
                    <div className="mt-2 flex flex-wrap items-center gap-3 text-[13px] text-muted-foreground">
                      <label className="flex items-center gap-1.5">
                        <input type="checkbox" checked={!!f.required} onChange={(e) => setField(i, { required: e.target.checked })} /> Required
                      </label>
                      <Input value={f.placeholder ?? ''} onChange={(e) => setField(i, { placeholder: e.target.value })} placeholder="Placeholder (optional)" className="h-8 max-w-xs text-[13px]" />
                      <span className="ml-auto flex gap-1">
                        <button type="button" onClick={() => moveField(i, -1)} className="grid h-7 w-7 place-items-center rounded-md hover:bg-muted" title="Move up">
                          <ArrowUp className="h-3.5 w-3.5" />
                        </button>
                        <button type="button" onClick={() => moveField(i, 1)} className="grid h-7 w-7 place-items-center rounded-md hover:bg-muted" title="Move down">
                          <ArrowDown className="h-3.5 w-3.5" />
                        </button>
                        <button type="button" onClick={() => setFields((fs) => fs.filter((_, j) => j !== i))} className="grid h-7 w-7 place-items-center rounded-md text-destructive hover:bg-destructive/10" title="Remove">
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </span>
                    </div>
                    <p className="mt-1 text-[11.5px] text-muted-foreground/70">Merge field: {`{{form.${f.key || '…'}}}`}</p>
                  </div>
                ))}
                <Button icon={<Plus className="h-4 w-4" />} onClick={() => setFields((fs) => [...fs, { key: '', label: 'New field', type: 'text' }])}>
                  Add field
                </Button>
              </div>
            </Card>
            <Card className="flex flex-col gap-4 p-5">
              <p className="text-[15px] font-semibold text-foreground">Wording</p>
              <Field label="Heading">
                <Input value={settings.heading ?? ''} onChange={(e) => setSettings({ ...settings, heading: e.target.value })} />
              </Field>
              {chat && (
                <Field label="Pop-up greeting" hint="Pops up beside the chat button a few seconds in, with the logo. Blank: the heading. A single space: none">
                  <Input value={settings.greeting ?? ''} onChange={(e) => setSettings({ ...settings, greeting: e.target.value === '' ? undefined : e.target.value })} placeholder={settings.heading || 'Hi there! Have a question? Text us here.'} />
                </Field>
              )}
              <Field label="Button text">
                <Input value={settings.submitLabel ?? ''} onChange={(e) => setSettings({ ...settings, submitLabel: e.target.value })} />
              </Field>
              <Field label="Thank-you message">
                <Textarea rows={2} value={settings.thankYou ?? ''} onChange={(e) => setSettings({ ...settings, thankYou: e.target.value })} />
              </Field>
            </Card>

            <Card className="flex flex-col gap-4 p-5">
              <div className="flex items-center justify-between gap-3">
                <p className="text-[15px] font-semibold text-foreground">Style</p>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setSettings((s) => ({ ...s, color: '#155EEF', buttonText: undefined, background: undefined, textColor: undefined, inputBackground: undefined, inputText: undefined, inputBorder: undefined }))}
                >
                  Reset colours
                </Button>
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Background" hint={chat ? 'The chat panel' : 'Behind the whole form'}>
                  <div className="flex items-center gap-2">
                    <ColourInput value={settings.background === 'transparent' ? '#FFFFFF' : settings.background} fallback="#FFFFFF" disabled={settings.background === 'transparent'} onChange={(v) => setSettings({ ...settings, background: v })} />
                    {!chat && (
                      <label className="flex items-center gap-1.5 whitespace-nowrap text-[12.5px] text-muted-foreground">
                        <input type="checkbox" checked={settings.background === 'transparent'} onChange={(e) => setSettings({ ...settings, background: e.target.checked ? 'transparent' : undefined })} /> None
                      </label>
                    )}
                  </div>
                </Field>
                {COLOURS.map((c) => (
                  <Field key={c.key} label={c.label}>
                    <ColourInput value={settings[c.key] as string | undefined} fallback={c.fallback} onChange={(v) => setSettings({ ...settings, [c.key]: v })} />
                  </Field>
                ))}
              </div>
            </Card>

            <Card className="flex flex-col gap-4 p-5">
              <div>
                <p className="text-[15px] font-semibold text-foreground">Consent checkboxes</p>
                <p className="text-[12.5px] text-muted-foreground">
                  {'{{business}}'} becomes “{defaults.business}”. “Privacy Policy” and “Terms” in the wording link to the pages below. Both boxes start unchecked; carriers look for that.
                </p>
              </div>
              {CONSENT_KINDS.map((k) => {
                const box = consents.find((c) => c.kind === k.kind)
                if (!box) {
                  return (
                    <Button key={k.kind} icon={<Plus className="h-4 w-4" />} onClick={() => setSettings((s) => ({ ...s, consents: [...(s.consents ?? []), { kind: k.kind, text: k.text, required: false }].sort((a, b) => (a.kind === 'sms' ? -1 : b.kind === 'sms' ? 1 : 0)) }))}>
                      Add the {k.label.toLowerCase()} box
                    </Button>
                  )
                }
                return (
                  <div key={k.kind} className="flex flex-col gap-2 rounded-lg border border-border p-3">
                    <div className="flex items-center justify-between gap-2">
                      <p className="text-[13px] font-medium text-foreground">{k.label}</p>
                      <span className="flex items-center gap-3">
                        <button type="button" className="text-[12px] text-muted-foreground hover:text-foreground" onClick={() => setConsent(k.kind, { text: k.text })}>
                          Standard wording
                        </button>
                        <label className="flex items-center gap-1.5 text-[12.5px] text-foreground/85">
                          <input type="checkbox" checked={!!box.required} onChange={(e) => setConsent(k.kind, { required: e.target.checked })} /> Required
                        </label>
                        <button
                          type="button"
                          className="text-muted-foreground hover:text-destructive"
                          title="Remove this box"
                          onClick={() => setSettings((s) => ({ ...s, consents: (s.consents ?? []).filter((c) => c.kind !== k.kind) }))}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </span>
                    </div>
                    <Textarea rows={4} value={box.text} onChange={(e) => setConsent(k.kind, { text: e.target.value })} />
                    {box.required && (
                      <p className="flex items-start gap-1.5 text-[12px] text-warning">
                        <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                        Carriers reject texting verification when agreeing to texts is required to send the form. Keep it optional on forms that go with a number being verified.
                      </p>
                    )}
                  </div>
                )
              })}
            </Card>

            <Card className="flex flex-col gap-3 p-5">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="text-[15px] font-semibold text-foreground">Logo</p>
                  <p className="text-[12.5px] text-muted-foreground">The business logo at the top of the form, from Settings → Business Profile.</p>
                </div>
                <Toggle checked={settings.showLogo !== false} onChange={(v) => setSettings({ ...settings, showLogo: v })} label="Show the logo" />
              </div>
              {defaults.logo ? (
                // eslint-disable-next-line @next/next/no-img-element -- the client's own image, from their website
                <img src={defaults.logo} alt={`${defaults.business} logo`} className={cn('h-16 w-auto self-start rounded-md bg-white object-contain p-1.5', settings.showLogo === false && 'opacity-40')} />
              ) : (
                <p className="text-[12.5px] text-muted-foreground">
                  No logo yet: add one under{' '}
                  <Link className="underline" href={`/hell-level/${accountId}/settings?tab=business-profile`}>
                    Settings → Business Profile
                  </Link>{' '}
                  (it can find it on their website).
                </p>
              )}
            </Card>

            <Card className="flex flex-col gap-4 p-5">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="text-[15px] font-semibold text-foreground">Privacy policy and terms</p>
                  <p className="text-[12.5px] text-muted-foreground">Where the links in the consent wording and under the form go. Blank uses the sub-account’s.</p>
                </div>
                <Button size="sm" variant="ghost" icon={<RefreshCw className="h-3.5 w-3.5" />} loading={lookAgain.isPending} onClick={() => lookAgain.mutate()} title="Read the client's website again for its /privacy and /terms pages">
                  Check their website
                </Button>
              </div>
              <label className="flex items-center justify-between gap-3 rounded-lg border border-border p-3 text-[13.5px] text-foreground/90">
                Show “Privacy policy · Texting terms” under the form
                <Toggle checked={settings.showLegalLinks !== false} onChange={(v) => setSettings({ ...settings, showLegalLinks: v })} label="Show the links under the form" />
              </label>
              <Field label="Privacy policy link" hint={`Blank: ${defaults.privacy}${defaults.fromProfile.privacy ? '' : ' (hosted by the Hub)'}`}>
                <Input value={settings.privacyUrl ?? ''} onChange={(e) => setSettings({ ...settings, privacyUrl: e.target.value })} placeholder={defaults.privacy} />
              </Field>
              <Field label="Terms link" hint={`Blank: ${defaults.terms}${defaults.fromProfile.terms ? '' : ' (hosted by the Hub)'}`}>
                <Input value={settings.termsUrl ?? ''} onChange={(e) => setSettings({ ...settings, termsUrl: e.target.value })} placeholder={defaults.terms} />
              </Field>
              <ErrorNote error={lookAgain.error} />
            </Card>
          </div>
          <div className="flex flex-col gap-2">
            <p className="text-[13px] font-medium text-foreground/90">Live preview {save.isSuccess ? '' : '(after you save)'}</p>
            <div className="overflow-hidden rounded-xl border border-border bg-card shadow-sm">
              <iframe key={version} src={`/hl/${chat ? 'c' : 'f'}/${formId}`} title="Preview" className="h-[680px] w-full border-0" />
            </div>
          </div>
        </div>
      ) : (
        <Card>
          {!data.submissions.length ? (
            <p className="px-5 py-12 text-center text-[14px] text-muted-foreground">No submissions yet.</p>
          ) : (
            <ul>
              {data.submissions.map((s) => (
                <li key={s.id} className="border-b border-border px-5 py-3 last:border-0">
                  <div className="flex items-center justify-between gap-3">
                    {s.contact ? (
                      <Link href={`/hell-level/${accountId}/conversations?contact=${s.contact.id}`} className="text-[14px] font-semibold text-primary hover:underline">
                        {[s.contact.firstName, s.contact.lastName].filter(Boolean).join(' ') || 'Contact'}
                      </Link>
                    ) : (
                      <span className="text-[14px] font-semibold text-foreground">Deleted contact</span>
                    )}
                    <span className="text-[12px] text-muted-foreground">{fmtDateTime(s.createdAt)}</span>
                  </div>
                  <dl className="mt-1.5 grid gap-x-4 gap-y-0.5 text-[13px] sm:grid-cols-[160px_1fr]">
                    {Object.entries(s.data).map(([k, v]) => (
                      <div key={k} className="contents">
                        <dt className="text-muted-foreground">{data.form.fields.find((f) => f.key === k)?.label ?? (k === 'sms_consent' ? 'Agreed to texts' : k === 'marketing_consent' ? 'Agreed to promotional texts' : k)}</dt>
                        <dd className="whitespace-pre-wrap text-foreground/90">{typeof v === 'boolean' ? (v ? 'Yes' : 'No') : String(v)}</dd>
                      </div>
                    ))}
                  </dl>
                  {s.pageUrl && <p className="mt-1 truncate text-[12px] text-muted-foreground/70">From {s.pageUrl}</p>}
                </li>
              ))}
            </ul>
          )}
        </Card>
      )}
    </div>
  )
}

/** A colour picker with its hex beside it; blank keeps the default. */
function ColourInput({ value, fallback, onChange, disabled }: { value: string | undefined; fallback: string; onChange: (v: string | undefined) => void; disabled?: boolean }) {
  return (
    <div className="flex flex-1 items-center gap-2">
      <input type="color" disabled={disabled} value={value || fallback} onChange={(e) => onChange(e.target.value)} className="h-9 w-11 shrink-0 cursor-pointer rounded-md border border-border disabled:opacity-40" />
      <Input disabled={disabled} value={value ?? ''} onChange={(e) => onChange(e.target.value.trim() || undefined)} placeholder={fallback} className="font-mono text-[12.5px]" />
    </div>
  )
}
