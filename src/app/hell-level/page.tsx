'use client'

import Link from 'next/link'
import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Building2, CheckCircle2, ChevronRight, Plus, ShieldCheck, Star, TriangleAlert } from 'lucide-react'
import { useAccounts } from '@/components/hell-level/shell'
import { textingBadge } from '@/components/hell-level/bits'
import { ImportPanel } from '@/components/hell-level/import-panel'
import { Avatar, Badge, Button, Card, Empty, ErrorNote, Field, Input, Modal, PageHeader, Spinner, hlFetch, timeAgo } from '@/components/hell-level/ui'
import { prettyPhone } from '@/lib/hl/merge'

type TwilioStatus = {
  ok: boolean
  error: string | null
  accountName: string | null
  accountStatus: string | null
  profiles: { sid: string; name: string; status: string }[]
  hubNumber: string | null
}

/** The agency view: every sub-account, and the clients that don't have one yet. */
export default function AgencyView() {
  const qc = useQueryClient()
  const accounts = useAccounts()
  const twilio = useQuery<TwilioStatus>({ queryKey: ['hl', 'twilio'], queryFn: () => hlFetch('/api/hl/settings/twilio') })
  const [newOpen, setNewOpen] = useState(false)
  const [name, setName] = useState('')

  const create = useMutation({
    mutationFn: (body: Record<string, unknown>) => hlFetch<{ id?: string; created?: number }>('/api/hl/accounts', { method: 'POST', json: body }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['hl', 'accounts'] })
      setNewOpen(false)
      setName('')
    },
  })

  const makeHome = useMutation({
    mutationFn: (id: string) => hlFetch(`/api/hl/accounts/${id}`, { method: 'PATCH', json: { makeDefault: true } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['hl', 'accounts'] }),
  })

  const rows = accounts.data?.accounts ?? []
  const without = accounts.data?.clientsWithout ?? []
  const approved = twilio.data?.profiles.some((p) => p.status === 'twilio-approved')

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-6 px-6 py-7">
      <PageHeader
        title="Sub-Accounts"
        description="Every client gets their own CRM: contacts, conversations, pipeline, forms and automations, on their own phone number."
        actions={
          <Button variant="primary" icon={<Plus className="h-4 w-4" />} onClick={() => setNewOpen(true)}>
            Create sub-account
          </Button>
        }
      />

      <ImportPanel compact />

      <Card className="flex flex-wrap items-center gap-4 px-5 py-4">
        {twilio.isLoading ? (
          <Spinner />
        ) : twilio.data?.ok ? (
          <>
            <span className={`grid h-10 w-10 place-items-center rounded-full ${approved ? 'bg-success/10 text-success' : 'bg-warning/10 text-warning'}`}>
              {approved ? <ShieldCheck className="h-5 w-5" /> : <TriangleAlert className="h-5 w-5" />}
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-[14px] font-semibold text-foreground">
                Twilio connected{twilio.data.accountName ? `: ${twilio.data.accountName}` : ''}
              </p>
              <p className="text-[13px] text-muted-foreground">
                {approved
                  ? 'Genisys’s business profile is approved, so Hell-level can file toll-free verifications for clients.'
                  : 'Before texting can be verified for clients, Genisys needs an approved Trust Hub business profile in Twilio (one time). See Settings → Twilio in any sub-account.'}
              </p>
            </div>
          </>
        ) : (
          <>
            <span className="grid h-10 w-10 place-items-center rounded-full bg-destructive/10 text-destructive">
              <TriangleAlert className="h-5 w-5" />
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-[14px] font-semibold text-foreground">Twilio isn’t reachable</p>
              <p className="text-[13px] text-muted-foreground">{twilio.data?.error ?? 'Check the "Twilio Account SID" and "Twilio Auth Token" entries in the Vault.'}</p>
            </div>
          </>
        )}
      </Card>

      <Card>
        {accounts.isLoading ? (
          <div className="flex justify-center py-16">
            <Spinner />
          </div>
        ) : !rows.length ? (
          <Empty icon={<Building2 className="h-5 w-5" />} title="No sub-accounts yet" action={without.length ? <Button variant="primary" loading={create.isPending} onClick={() => create.mutate({ all: true })}>Create one for every client ({without.length})</Button> : undefined}>
            Each client gets one, set up from their onboarding answers with the lead pipeline, website forms and automations ready to go.
          </Empty>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-[14px]">
              <thead>
                <tr className="border-b border-border bg-surface-muted text-[12px] font-medium text-muted-foreground">
                  <th className="px-5 py-3">Sub-account</th>
                  <th className="px-4 py-3">Phone</th>
                  <th className="px-4 py-3">Texting</th>
                  <th className="px-4 py-3 text-right">Contacts</th>
                  <th className="px-4 py-3">Last lead</th>
                  <th className="px-4 py-3" />
                </tr>
              </thead>
              <tbody>
                {rows.map((a) => (
                  <tr key={a.id} className="border-b border-border last:border-0 hover:bg-muted/50">
                    <td className="px-5 py-3">
                      <Link href={`/hell-level/${a.id}/dashboard`} className="flex items-center gap-3">
                        <Avatar name={a.name} />
                        <span className="min-w-0">
                          <span className="block truncate font-semibold text-foreground">{a.name}</span>
                          <span className="block truncate text-[13px] text-muted-foreground">{a.owner || a.clientName || '—'}</span>
                        </span>
                        {a.id === accounts.data?.defaultAccountId && <Badge color="blue">Home</Badge>}
                        {!!a.unread && <Badge color="red">{a.unread} unread</Badge>}
                      </Link>
                    </td>
                    <td className="whitespace-nowrap px-4 py-3 text-foreground/90">{a.number ? prettyPhone(a.number.number) : '—'}</td>
                    <td className="px-4 py-3">{textingBadge(a.number)}</td>
                    <td className="px-4 py-3 text-right tabular-nums text-foreground/90">{a.contacts}</td>
                    <td className="whitespace-nowrap px-4 py-3 text-muted-foreground">{a.lastLeadAt ? timeAgo(a.lastLeadAt) : '—'}</td>
                    <td className="px-4 py-3 text-right">
                      <Link href={`/hell-level/${a.id}/dashboard`} className="inline-flex items-center gap-1 text-[13px] font-semibold text-primary hover:underline">
                        Open <ChevronRight className="h-4 w-4" />
                      </Link>
                      {a.id !== accounts.data?.defaultAccountId && (
                        <button
                          type="button"
                          onClick={() => makeHome.mutate(a.id)}
                          className="ml-3 inline-flex items-center gap-1 font-mono text-[11.5px] text-muted-foreground hover:text-foreground"
                          title="Open Hell-level on this sub-account"
                        >
                          <Star className="h-3 w-3" /> Make home
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {without.length > 0 && rows.length > 0 && (
        <Card className="px-5 py-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="text-[15px] font-semibold text-foreground">Clients without a sub-account</p>
              <p className="text-[13px] text-muted-foreground">New clients get one automatically when their onboarding form comes in.</p>
            </div>
            <Button variant="secondary" loading={create.isPending && !!create.variables?.all} onClick={() => create.mutate({ all: true })}>
              Create for all ({without.length})
            </Button>
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            {without.map((c) => (
              <button
                key={c.id}
                type="button"
                disabled={create.isPending}
                onClick={() => create.mutate({ clientId: c.id })}
                className="inline-flex items-center gap-1.5 rounded-full border border-border bg-card px-3 py-1.5 text-[13px] font-medium text-foreground/90 transition hover:border-primary hover:text-primary disabled:opacity-50"
              >
                <Plus className="h-3.5 w-3.5" /> {c.name}
              </button>
            ))}
          </div>
        </Card>
      )}
      <ErrorNote error={create.error} />

      <Modal
        open={newOpen}
        onClose={() => setNewOpen(false)}
        title="Create sub-account"
        description="Pick a client to set it up from their onboarding answers, or make a blank one (for Genisys itself or testing)."
        footer={
          <>
            <Button onClick={() => setNewOpen(false)}>Cancel</Button>
            <Button variant="primary" loading={create.isPending} disabled={!name.trim()} onClick={() => create.mutate({ name })}>
              Create blank sub-account
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-4">
          {without.length > 0 && (
            <div className="flex flex-col gap-2">
              <p className="text-[13px] font-medium text-foreground/90">From a client</p>
              <div className="flex max-h-56 flex-col overflow-y-auto rounded-lg border border-border">
                {without.map((c) => (
                  <button
                    key={c.id}
                    type="button"
                    disabled={create.isPending}
                    onClick={() => create.mutate({ clientId: c.id })}
                    className="flex items-center gap-3 border-b border-border px-3 py-2.5 text-left text-[14px] last:border-0 hover:bg-muted/50"
                  >
                    <Avatar name={c.name} size={28} />
                    <span className="flex-1">
                      <span className="block font-medium text-foreground">{c.name}</span>
                      <span className="block text-[12px] text-muted-foreground">{c.contactName ?? c.lifecycle}</span>
                    </span>
                    <CheckCircle2 className="h-4 w-4 text-muted-foreground" />
                  </button>
                ))}
              </div>
            </div>
          )}
          <Field label="Blank sub-account name">
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Genisys (agency)" />
          </Field>
          <ErrorNote error={create.error} />
        </div>
      </Modal>
    </div>
  )
}
