'use client'

import { useState } from 'react'
import { useMutation, useQuery, useQueryClient, type UseMutationResult } from '@tanstack/react-query'
import { Check, CircleDashed, Copy, Mail, RefreshCw, Send, Trash2, X } from 'lucide-react'
import { confirmAction } from './confirm'
import { Badge, Button, Card, ErrorNote, Field, Input, Select, Spinner, Toggle, copyText, hlFetch, timeAgo } from './ui'

/**
 * Settings → Email Services (GHL's LC Email): email from the client's own
 * domain through Mailgun, set up in one go (src/lib/hl/email.ts). On a
 * domain whose DNS is here the records write themselves; elsewhere they're
 * listed to add, and checked until they're there.
 */

type EmailRecord = { type: string; name: string; host: string; value: string; priority: number | null; valid: boolean | null; purpose: 'sending' | 'receiving' }
type Setup = {
  rootDomain: string
  domain: string
  fromName: string | null
  fromLocal: string
  forwardReplies: boolean
  status: 'verifying' | 'active' | 'failed'
  dnsMode: 'porkbun' | 'external'
  records: EmailRecord[]
  lastError: string | null
  checkedAt: string | null
  verifiedAt: string | null
}
type Overview = {
  mailgun: { connected: boolean; region: string | null; error: string | null }
  setup: Setup | null
  choices: { name: string; held: boolean }[]
  notifyEmail: string
  you: string
}

export function EmailPanel({ accountId }: { accountId: string }) {
  const qc = useQueryClient()
  const key = ['hl', 'email', accountId]
  const q = useQuery<Overview>({ queryKey: key, queryFn: () => hlFetch(`/api/hl/accounts/${accountId}/email`) })
  const refresh = () => qc.invalidateQueries({ queryKey: key })
  const act = useMutation({
    mutationFn: (body: Record<string, unknown>) => hlFetch<{ detail?: string }>(`/api/hl/accounts/${accountId}/email`, { method: 'POST', json: body }),
    onSuccess: refresh,
  })
  const remove = useMutation({ mutationFn: () => hlFetch(`/api/hl/accounts/${accountId}/email`, { method: 'DELETE' }), onSuccess: refresh })

  if (q.isLoading) return <Spinner />
  if (!q.data) return <ErrorNote error={q.error} />
  const { mailgun, setup, choices, notifyEmail, you } = q.data

  if (!mailgun.connected) {
    return (
      <Card className="flex flex-col gap-3 p-6">
        <p className="flex items-center gap-2 text-[15px] font-semibold text-foreground">
          <Mail className="h-4 w-4" /> Connect Mailgun to send email
        </p>
        <p className="text-[13px] text-muted-foreground">
          Hell-level sends and receives client email through Mailgun, as GoHighLevel’s does. Add a Vault entry named <b className="text-foreground">Mailgun API Key</b> (Mailgun → Settings → API Keys, a private key). That’s the only setting: the region and the webhook signing are read from it.
        </p>
        {mailgun.error && !/add .Mailgun API Key/i.test(mailgun.error) && <p className="text-[12.5px] text-warning">{mailgun.error}</p>}
        <div>
          <Button size="sm" icon={<RefreshCw className="h-3.5 w-3.5" />} loading={q.isFetching} onClick={refresh}>
            Check again
          </Button>
        </div>
      </Card>
    )
  }

  if (!setup) return <SetUp choices={choices} notifyEmail={notifyEmail} act={act} />

  return (
    <div className="flex flex-col gap-4">
      <Card className="flex flex-col gap-3 p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="flex items-center gap-2 text-[15px] font-semibold text-foreground">
              {setup.fromLocal}@{setup.rootDomain}
              {setup.status === 'active' ? (
                <Badge color="green" dot>
                  Active
                </Badge>
              ) : (
                <Badge color="amber" dot>
                  Verifying
                </Badge>
              )}
            </p>
            <p className="text-[12.5px] text-muted-foreground">
              Sent through {setup.domain}. Replies come back into Conversations
              {setup.forwardReplies && notifyEmail ? ` and are copied to ${notifyEmail}` : ''}.{setup.checkedAt ? ` Checked ${timeAgo(setup.checkedAt)}.` : ''}
            </p>
          </div>
          <div className="flex gap-2">
            <Button size="sm" icon={<RefreshCw className="h-3.5 w-3.5" />} loading={act.isPending && act.variables?.action === 'check'} onClick={() => act.mutate({ action: 'check' })}>
              Check again
            </Button>
            <Button
              size="sm"
              variant="ghost"
              icon={<Trash2 className="h-3.5 w-3.5" />}
              loading={remove.isPending}
              onClick={() => void confirmAction(`Remove email from ${setup.rootDomain}? Automations stop emailing, and replies stop coming in.`, 'Remove', { danger: true }).then((ok) => ok && remove.mutate())}
            >
              Remove
            </Button>
          </div>
        </div>
        {setup.status !== 'active' && (
          <p className="rounded-lg bg-warning/10 px-3 py-2 text-[12.5px] text-warning">
            {setup.dnsMode === 'porkbun'
              ? 'The records were added to the domain’s DNS here. Mailgun usually passes them within a few minutes; Hell-level checks every 5.'
              : `Add the records below where ${setup.rootDomain}’s DNS is managed. Hell-level checks every 5 minutes and switches email on when they pass.`}
          </p>
        )}
        {setup.lastError && <p className="rounded-lg bg-warning/10 px-3 py-2 text-[12.5px] text-warning">{setup.lastError}</p>}
      </Card>

      <Sender key={JSON.stringify([setup.fromName, setup.fromLocal, setup.forwardReplies])} setup={setup} notifyEmail={notifyEmail} act={act} />

      <Card className="flex flex-col gap-3 p-5">
        <div>
          <p className="text-[14px] font-semibold text-foreground">DNS records</p>
          <p className="text-[12.5px] text-muted-foreground">
            {setup.dnsMode === 'porkbun' ? 'Added for you to the domain’s DNS here.' : `Add these where ${setup.rootDomain}’s DNS is managed, exactly as shown.`} The ticks are Mailgun’s own check.
          </p>
        </div>
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full text-left text-[12.5px]">
            <thead className="border-b border-border font-mono text-[10.5px] uppercase tracking-wider text-muted-foreground">
              <tr>
                <th className="px-3 py-2">Type</th>
                <th className="px-3 py-2">Name</th>
                <th className="px-3 py-2">Value</th>
                <th className="px-3 py-2">For</th>
                <th className="px-3 py-2 text-right">Check</th>
              </tr>
            </thead>
            <tbody>
              {setup.records.map((r, i) => (
                <tr key={i} className="border-b border-border-soft last:border-0">
                  <td className="px-3 py-2 font-mono">{r.type}</td>
                  <td className="max-w-[200px] px-3 py-2 font-mono">
                    <CopyCell text={r.host || '@'} />
                  </td>
                  <td className="max-w-[320px] px-3 py-2 font-mono">
                    <CopyCell text={r.priority !== null && r.type === 'MX' ? `${r.priority} ${r.value}` : r.value} />
                  </td>
                  <td className="px-3 py-2 text-muted-foreground">{r.purpose === 'sending' ? 'Sending' : 'Replies'}</td>
                  <td className="px-3 py-2 text-right">
                    {r.valid === true ? <Check className="ml-auto h-4 w-4 text-success" /> : r.valid === false ? <X className="ml-auto h-4 w-4 text-warning" /> : <CircleDashed className="ml-auto h-4 w-4 text-muted-foreground" />}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      {setup.status === 'active' && <TestEmail you={you} act={act} />}
      <ErrorNote error={act.error || remove.error} />
    </div>
  )
}

type Act = UseMutationResult<{ detail?: string }, Error, Record<string, unknown>>

function SetUp({ choices, notifyEmail, act }: { choices: Overview['choices']; notifyEmail: string; act: Act }) {
  const [domain, setDomain] = useState(choices.find((c) => c.held)?.name ?? choices[0]?.name ?? '')
  const [typed, setTyped] = useState('')
  const chosen = (domain === '__other' ? typed : domain).trim()
  const held = choices.find((c) => c.name === chosen)?.held ?? false
  return (
    <Card className="flex flex-col gap-4 p-6">
      <div>
        <p className="flex items-center gap-2 text-[15px] font-semibold text-foreground">
          <Mail className="h-4 w-4" /> Send email from the client’s own domain
        </p>
        <p className="mt-1 text-[13px] text-muted-foreground">
          Automations’ “Send email” steps and Conversations send from <b className="text-foreground">hello@{chosen || 'theirdomain.com'}</b>. Replies come back into Conversations
          {notifyEmail ? ` and are copied to ${notifyEmail}` : ''}. Their own mailbox, if they have one, isn’t touched: Mailgun uses a subdomain.
        </p>
      </div>
      <div className="flex flex-wrap items-end gap-3">
        <Field label="Domain" className="w-72">
          <Select value={domain} onChange={(e) => setDomain(e.target.value)}>
            {choices.map((c) => (
              <option key={c.name} value={c.name}>
                {c.name}
                {c.held ? ' (held here)' : ''}
              </option>
            ))}
            <option value="__other">Another domain…</option>
          </Select>
        </Field>
        {domain === '__other' && (
          <Field label="Their domain" className="w-64">
            <Input value={typed} onChange={(e) => setTyped(e.target.value)} placeholder="theirdomain.com" />
          </Field>
        )}
        <Button variant="primary" disabled={!chosen} loading={act.isPending} onClick={() => act.mutate({ action: 'setup', domain: chosen })}>
          Set up email
        </Button>
      </div>
      <p className="text-[12.5px] text-muted-foreground">
        {held ? 'Its DNS is here, so the records are added for you: usually working within minutes.' : 'If its DNS is with Porkbun here, the records are added for you; otherwise you get 4 or 5 records to add where its DNS is managed.'}
      </p>
      <ErrorNote error={act.error} />
    </Card>
  )
}

function Sender({ setup, notifyEmail, act }: { setup: Setup; notifyEmail: string; act: Act }) {
  const [fromName, setFromName] = useState(setup.fromName ?? '')
  const [fromLocal, setFromLocal] = useState(setup.fromLocal)
  const [forward, setForward] = useState(setup.forwardReplies)
  const changed = fromName !== (setup.fromName ?? '') || fromLocal !== setup.fromLocal || forward !== setup.forwardReplies
  return (
    <Card className="flex flex-col gap-4 p-5">
      <p className="text-[14px] font-semibold text-foreground">Sender</p>
      <div className="flex flex-wrap items-end gap-3">
        <Field label="From name" className="w-64">
          <Input value={fromName} onChange={(e) => setFromName(e.target.value)} placeholder="Forte Brick and Concrete" />
        </Field>
        <Field label="From address" className="w-80">
          <div className="flex items-center gap-1.5">
            <Input value={fromLocal} onChange={(e) => setFromLocal(e.target.value.toLowerCase())} className="w-32" />
            <span className="truncate text-[13px] text-muted-foreground">@{setup.rootDomain}</span>
          </div>
        </Field>
      </div>
      <label className="flex items-center gap-3 text-[13px] text-foreground/90">
        <Toggle checked={forward} onChange={setForward} label="Copy replies to the owner" />
        Copy replies to the owner{notifyEmail ? ` (${notifyEmail})` : ''}
      </label>
      {forward && !notifyEmail && <p className="text-[12.5px] text-warning">There’s no notification email in Business Profile, so no copies go out until there is.</p>}
      <div>
        <Button size="sm" variant="primary" disabled={!changed} loading={act.isPending && act.variables?.action === 'settings'} onClick={() => act.mutate({ action: 'settings', fromName, fromLocal, forwardReplies: forward })}>
          Save
        </Button>
      </div>
    </Card>
  )
}

function TestEmail({ you, act }: { you: string; act: Act }) {
  const [to, setTo] = useState(you)
  const sent = act.data?.detail && act.variables?.action === 'test' ? act.data.detail : null
  return (
    <Card className="flex flex-wrap items-end gap-3 p-5">
      <Field label="Send a test email to" className="w-72">
        <Input value={to} onChange={(e) => setTo(e.target.value)} placeholder="you@example.com" />
      </Field>
      <Button icon={<Send className="h-3.5 w-3.5" />} loading={act.isPending && act.variables?.action === 'test'} onClick={() => act.mutate({ action: 'test', to })}>
        Send test
      </Button>
      {sent && <p className="text-[12.5px] text-success">{sent}. Reply to it to see the reply land in Conversations.</p>}
    </Card>
  )
}

function CopyCell({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <button
      type="button"
      title="Copy"
      onClick={() => {
        copyText(text)
        setCopied(true)
      }}
      className="group flex max-w-full items-center gap-1.5 text-left text-foreground/90 hover:text-foreground"
    >
      <span className="truncate">{text}</span>
      {copied ? <Check className="h-3 w-3 shrink-0 text-success" /> : <Copy className="h-3 w-3 shrink-0 opacity-0 group-hover:opacity-60" />}
    </button>
  )
}
