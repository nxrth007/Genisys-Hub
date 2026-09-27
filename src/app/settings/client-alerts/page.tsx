'use client'

/**
 * /settings/client-alerts — focused view for the Client Alerts (SMS)
 * subsystem. Renders ONLY the ClientAlertsSection from the main
 * Settings page (master toggle, sender phone, per-client status,
 * Recent activity feed with retry/cancel, test sends) — none of the
 * other settings sections that would otherwise come along on /settings.
 *
 * Linked from the orange "Client SMS" button on /clients per Alex
 * 2026-05-11: "I don't want to see all the other settings when I
 * click that button." Quick-access surface for when something needs
 * checking on the SMS pipeline.
 */

import Link from 'next/link'
import { ArrowLeft, Phone as PhoneIcon } from 'lucide-react'
import { ClientAlertsSection } from '../page'

export default function ClientAlertsFocusedPage() {
  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div className="space-y-2">
        <div className="flex items-center gap-3">
          <Link
            href="/clients"
            className="inline-flex items-center gap-1.5 text-xs font-medium text-muted-foreground hover:text-foreground"
          >
            <ArrowLeft className="h-3.5 w-3.5" />
            Back to Clients
          </Link>
          <span className="text-xs text-muted-foreground/50">·</span>
          <Link
            href="/settings"
            className="text-xs font-medium text-muted-foreground hover:text-foreground"
          >
            All settings
          </Link>
        </div>
        <div className="flex items-center gap-3">
          <div className="rounded-lg bg-warning/15 p-2.5 bg-warning/15">
            <PhoneIcon className="h-6 w-6 text-warning" />
          </div>
          <div>
            <h1 className="text-2xl font-bold tracking-tight">Client SMS</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              Master toggle, sender number, per-client routing, and the
              live activity feed. Retry failed sends, cancel stuck
              pendings, or fire a test SMS — all in one place.
            </p>
          </div>
        </div>
      </div>

      <ClientAlertsSection />
    </div>
  )
}
