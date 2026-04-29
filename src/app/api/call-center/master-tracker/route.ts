import { NextResponse } from 'next/server'
import { auth } from '@/auth'
import { prisma } from '@/lib/prisma'
import { readMasterTableRows } from '@/lib/drive'

/**
 * GET /api/call-center/master-tracker
 *
 * Returns every row in the Master Table sheet, shaped like the
 * Appointment objects the rest of /call-center renders. This is the
 * source of truth for the Master Tracker page because the call center
 * is currently typing rows directly into the sheet (not through the
 * Hub's /agent portal). Pulling from the sheet means we see *all*
 * appointments — manually-entered ones AND Hub-synced ones — without
 * double-counting (the Hub's sync writes into the same sheet).
 *
 * Staff-only — middleware already blocks role=agent.
 */
export async function GET() {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  // Pull clients so we can attach the brand-correct color/state to each
  // row whose client name matches one we know about. Sheet rows whose
  // Client column is blank (or doesn't match any registered client) get
  // null — the UI shows them under "No client".
  const clients = await prisma.client.findMany({
    select: { id: true, name: true, state: true, color: true },
  })
  const clientByLower = new Map(clients.map((c) => [c.name.toLowerCase(), c]))

  // For rows where the call center forgot the Client column, infer it
  // from the address: each Genisys client serves a different state, so
  // a state-code or state-name match on the address is unambiguous.
  // Build a regex of state names + codes that map to a client.
  const STATE_CODES: Record<string, string> = {
    arizona: 'AZ',
    california: 'CA',
    utah: 'UT',
  }
  const clientByCode = new Map<string, (typeof clients)[number]>()
  for (const c of clients) {
    if (!c.state) continue
    const code = STATE_CODES[c.state.toLowerCase()]
    // Store both keys lower-cased so the regex match (which we lower-case
    // before lookup) hits regardless of how the state was written in the
    // address. Earlier this stored "AZ"/"CA"/"UT" uppercase, which only
    // matched addresses that spelled the state out ("California") and
    // missed every "Phoenix, AZ" / "Tucson, AZ".
    if (code) clientByCode.set(code.toLowerCase(), c)
    clientByCode.set(c.state.toLowerCase(), c)
  }
  // Word-boundary regex over every key — e.g. /\b(AZ|CA|UT|arizona|california|utah)\b/i
  const stateKeys = Array.from(clientByCode.keys())
  const stateRegex =
    stateKeys.length > 0
      ? new RegExp(`\\b(${stateKeys.map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})\\b`, 'i')
      : null

  function inferClientFromAddress(address: string | null) {
    if (!address || !stateRegex) return null
    const m = address.match(stateRegex)
    if (!m) return null
    return clientByCode.get(m[1].toLowerCase()) || null
  }

  let rows
  try {
    rows = await readMasterTableRows()
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to read sheet'
    return NextResponse.json({ error: message }, { status: 500 })
  }

  // Normalize sheet status values into the same lowercase-with-underscore
  // tokens the Hub UI uses for tone classes ("booked" / "showed" / etc).
  const normalizeStatus = (raw: string | null): string => {
    if (!raw) return 'booked' // sensible default — rows in the sheet
    // are usually freshly booked unless flagged otherwise.
    const s = raw.toLowerCase().trim()
    if (s === 'no show' || s === 'no-show' || s === 'noshow') return 'no_show'
    if (s === 'rescheduled' || s === 'reschedule') return 'rescheduled'
    if (s === 'showed' || s === 'show' || s === 'shown') return 'showed'
    if (s === 'cancelled' || s === 'canceled' || s === 'cancel') {
      return 'cancelled'
    }
    return 'booked'
  }

  const appointments = rows.map((r) => {
    // 1. Try the explicit Client column from the sheet first.
    let clientLookup = r.client
      ? clientByLower.get(r.client.toLowerCase())
      : null
    // 2. If that's blank or doesn't match a registered client, try to
    //    infer from the address state. Track that we did this so the UI
    //    can render a small "auto" hint for Ethan to spot which rows
    //    still need the Client column filled in upstream.
    let clientInferred = false
    if (!clientLookup) {
      const fromAddress = inferClientFromAddress(r.address)
      if (fromAddress) {
        clientLookup = fromAddress
        clientInferred = true
      }
    }
    return {
      // Synthetic id from the sheet row number — stable across reads as
      // long as the sheet's row order doesn't change. Used as React key.
      id: `sheet:${r.rowNumber}`,
      apptDateTime:
        r.apptDateTime ||
        // Fall back to today midnight so the row still renders if the
        // date column is blank/unparsable.
        new Date().toISOString(),
      customerName: r.customerName,
      customerPhone: r.customerPhone,
      address: r.address,
      email: r.email,
      monthlyBill: r.monthlyBill,
      utilityProvider: r.utilityProvider,
      roofType: r.roofType,
      roofAge: r.roofAge,
      status: normalizeStatus(r.status),
      estimatedDealValue: r.estimatedDealValue,
      notes: r.notes,
      callRecordingLink: r.callRecordingLink,
      lastSyncedAt: null,
      syncError: null,
      createdAt: r.loggedAt
        ? new Date(r.loggedAt).toISOString()
        : r.apptDateTime || new Date().toISOString(),
      // Synthetic agent so the page doesn't have to special-case sheet
      // rows. Agent links go nowhere meaningful for these rows but they
      // render correctly.
      agent: {
        id: `sheet-agent:${(r.agentEmail || r.agentName || 'unknown').toLowerCase()}`,
        name: r.agentName || null,
        email: r.agentEmail || '',
      },
      // If the client name matches a registered Client, attach the real
      // record so badge color/state show. Otherwise null so the UI
      // displays "—" / treats it as unassigned.
      client: clientLookup
        ? {
            id: clientLookup.id,
            name: clientLookup.name,
            state: clientLookup.state,
            color: clientLookup.color,
          }
        : r.client
          ? {
              // Unknown client name — preserve what's in the sheet so
              // Ethan can spot typos / new clients that haven't been
              // registered yet. Falls back to a neutral grey.
              id: `sheet-client:${r.client.toLowerCase()}`,
              name: r.client,
              state: null,
              color: '#6b7280',
            }
          : null,
      clientInferred,
    }
  })

  return NextResponse.json({ appointments })
}
