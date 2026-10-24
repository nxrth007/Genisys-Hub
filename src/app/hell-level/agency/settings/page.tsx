'use client'

import { useQuery } from '@tanstack/react-query'
import { CheckCircle2, Globe, Phone, ShieldCheck, TriangleAlert } from 'lucide-react'
import { ImportPanel } from '@/components/hell-level/import-panel'
import { Card, PageHeader, Spinner, hlFetch } from '@/components/hell-level/ui'

type Twilio = { ok: boolean; error: string | null; accountName: string | null; profiles: { status: string }[]; hubNumber: string | null }
type Porkbun = { connected: boolean; sandbox: boolean; account: string | null; error: string | null; spendLimitCents: number | null; monthlySpendCents: number | null }

function Row({ icon, title, ok, detail }: { icon: React.ReactNode; title: string; ok: boolean | null; detail: string }) {
  return (
    <div className="flex items-center gap-4 border-b border-border-soft px-5 py-4 last:border-0">
      <span className="grid h-10 w-10 place-items-center rounded-full bg-muted text-muted-foreground">{icon}</span>
      <div className="min-w-0 flex-1">
        <p className="text-[14px] font-semibold text-foreground">{title}</p>
        <p className="text-[12.5px] text-muted-foreground">{detail}</p>
      </div>
      {ok === null ? <Spinner /> : ok ? <CheckCircle2 className="h-5 w-5 text-success" /> : <TriangleAlert className="h-5 w-5 text-warning" />}
    </div>
  )
}

/** Agency view → Settings: the agency-wide connections (Twilio, Porkbun), who can get in, and the GoHighLevel import. */
export default function AgencySettingsPage() {
  const twilio = useQuery<Twilio>({ queryKey: ['hl', 'twilio'], queryFn: () => hlFetch('/api/hl/settings/twilio') })
  const porkbun = useQuery<Porkbun>({ queryKey: ['hl', 'porkbun'], queryFn: () => hlFetch('/api/hl/settings/porkbun') })
  const approved = twilio.data?.profiles.some((p) => p.status === 'twilio-approved')
  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-5 px-6 py-6">
      <PageHeader title="Agency Settings" description="Connections every sub-account uses. Keys live in the Hub’s Vault." />
      <Card>
        <Row
          icon={<Phone className="h-5 w-5" />}
          title="Phone system: Twilio"
          ok={twilio.isLoading ? null : !!twilio.data?.ok}
          detail={twilio.data?.ok ? `Connected${twilio.data.accountName ? `: ${twilio.data.accountName}` : ''}${twilio.data.hubNumber ? ` · Hub number ${twilio.data.hubNumber}` : ''}` : (twilio.data?.error ?? 'Add “Twilio Account SID” and “Twilio Auth Token” to the Vault.')}
        />
        <Row
          icon={<ShieldCheck className="h-5 w-5" />}
          title="Texting verification: Twilio business profile"
          ok={twilio.isLoading ? null : !!approved}
          detail={approved ? 'Approved: toll-free verification can be filed for clients.' : 'Needs Genisys’s Trust Hub business profile approved in Twilio.'}
        />
        <Row
          icon={<Globe className="h-5 w-5" />}
          title="Domains: Porkbun"
          ok={porkbun.isLoading ? null : !!porkbun.data?.connected}
          detail={
            porkbun.data?.connected
              ? `Connected: ${porkbun.data.account ?? 'account'}${porkbun.data.sandbox ? ' (sandbox)' : ''}${porkbun.data.monthlySpendCents !== null ? ` · $${(porkbun.data.monthlySpendCents / 100).toFixed(2)} spent this month` : ''}`
              : (porkbun.data?.error ?? 'Add “Porkbun API Key” and “Porkbun Secret API Key” to the Vault.')
          }
        />
      </Card>
      <Card className="px-5 py-4">
        <p className="text-[14px] font-semibold text-foreground">Who can open Hell-level</p>
        <p className="text-[12.5px] text-muted-foreground">alex@leadgenisys.com and ethan@leadgenisys.com, signed in to the Hub. Nobody else sees it.</p>
      </Card>
      <ImportPanel compact />
    </div>
  )
}
