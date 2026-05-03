import { NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireAdmin } from '@/lib/auth-helpers'
import { readMasterTableRows } from '@/lib/drive'
import { timezoneForAddress, formatInTimezone } from '@/lib/timezone'

/**
 * GET /api/admin/audit/timezone
 *
 * One-off audit endpoint to surface appointments whose stored UTC
 * instant disagrees with the master sheet's text. Built to clean up
 * the fallout from the pre-2026-05-02 timezone bug, where Mary's
 * "9 AM" inputs were being interpreted as 9 AM Manila instead of
 * 9 AM at the customer's location — silently shifting every
 * Hub-form booking by ~12-16 hours.
 *
 * Strategy
 * --------
 * The master sheet stores times as raw text ("5/4/2026" + "9:00 AM"),
 * which we re-parse on every read using the corrected tz-aware
 * helper. So the sheet rows are the *source of truth* for what Mary
 * actually meant, while DB rows that were written pre-fix have a
 * permanently bad UTC instant baked in.
 *
 * The audit compares:
 *   - For each Appointment with a masterSheetRowNumber → look up the
 *     matching sheet row, re-parse its text, compare to DB instant.
 *   - If they differ by ≥1 hour, flag it as a mismatch.
 *   - Pre-fix DB rows without a sheet match are listed separately
 *     ("orphan pre-fix") so admins can spot-check them manually.
 *
 * Output is JSON. Admin-only.
 */

// Approximate moment the timezone fix went live (commit 2ef4859).
// Anything created strictly before this is a candidate for a stale
// Manila-interpreted instant.
const FIX_DEPLOYED_AT = new Date('2026-05-02T00:00:00Z')

export async function GET() {
  const denial = await requireAdmin()
  if (denial) return denial

  const [appts, sheetRows] = await Promise.all([
    prisma.appointment.findMany({
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        customerName: true,
        customerPhone: true,
        address: true,
        apptDateTime: true,
        createdAt: true,
        masterSheetRowNumber: true,
        agentUserId: true,
        clientId: true,
      },
    }),
    readMasterTableRows().catch((err) => {
      console.error('[audit/timezone] sheet read failed:', err)
      return [] as Awaited<ReturnType<typeof readMasterTableRows>>
    }),
  ])

  const sheetByRowNum = new Map(sheetRows.map((r) => [r.rowNumber, r]))

  // ---- Pass 1: DB rows that have a paired sheet row -----------------
  // The sheet text is what Mary typed; the new parser interprets it
  // in the customer's tz. So comparing DB instant vs sheet-parsed
  // instant tells us whether the DB row was written pre-fix.
  type Mismatch = {
    id: string
    rowNumber: number
    customerName: string
    customerPhone: string
    address: string | null
    customerTz: string
    /** What the DB currently has (formatted in customer tz). */
    dbWallClockInTz: string
    dbApptUtc: string
    /** What the sheet text parses to (formatted in customer tz). */
    sheetWallClockInTz: string
    sheetApptUtc: string
    /** Signed delta in hours. Positive = DB ahead of sheet. ~16 is
     *  the classic Manila→PT shift. */
    deltaHours: number
    createdAt: string
  }

  const mismatches: Mismatch[] = []
  for (const a of appts) {
    if (!a.masterSheetRowNumber) continue
    const sheet = sheetByRowNum.get(a.masterSheetRowNumber)
    if (!sheet?.apptDateTime) continue

    const dbMs = a.apptDateTime.getTime()
    const sheetMs = new Date(sheet.apptDateTime).getTime()
    const deltaMs = dbMs - sheetMs
    const deltaHours = deltaMs / (60 * 60 * 1000)
    if (Math.abs(deltaHours) < 1) continue // close enough

    const tz = timezoneForAddress(a.address ?? sheet.address)
    const fmt: Intl.DateTimeFormatOptions = {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: true,
    }

    mismatches.push({
      id: a.id,
      rowNumber: a.masterSheetRowNumber,
      customerName: a.customerName,
      customerPhone: a.customerPhone,
      address: a.address,
      customerTz: tz,
      dbWallClockInTz: formatInTimezone(a.apptDateTime, tz, fmt),
      dbApptUtc: a.apptDateTime.toISOString(),
      sheetWallClockInTz: formatInTimezone(new Date(sheet.apptDateTime), tz, fmt),
      sheetApptUtc: sheet.apptDateTime,
      deltaHours: Math.round(deltaHours * 10) / 10,
      createdAt: a.createdAt.toISOString(),
    })
  }

  // ---- Pass 2: pre-fix DB rows with no sheet pairing ----------------
  // Can't verify these against ground truth, but their createdAt
  // predates the fix so they're suspect by construction. Listing them
  // so an admin can eyeball each in Master Tracker.
  const orphanPreFix = appts
    .filter(
      (a) => !a.masterSheetRowNumber && a.createdAt < FIX_DEPLOYED_AT,
    )
    .map((a) => {
      const tz = timezoneForAddress(a.address)
      return {
        id: a.id,
        customerName: a.customerName,
        customerPhone: a.customerPhone,
        address: a.address,
        customerTz: tz,
        currentWallClockInTz: formatInTimezone(a.apptDateTime, tz, {
          year: 'numeric',
          month: '2-digit',
          day: '2-digit',
          hour: '2-digit',
          minute: '2-digit',
          hour12: true,
        }),
        apptDateTime: a.apptDateTime.toISOString(),
        createdAt: a.createdAt.toISOString(),
      }
    })

  // ---- Sheet rows that look stale themselves -----------------------
  // Manually-typed sheet rows re-parse correctly on every read, so
  // they're effectively self-healing. Still surface ones with no
  // resolvable address (tz fallback to NY) so admins can see which
  // rows the brain couldn't pin to a customer-local time.
  const sheetRowsMissingTz = sheetRows
    .filter((r) => r.apptDateTime && !timezoneForAddressKnown(r.address))
    .slice(0, 100)
    .map((r) => ({
      rowNumber: r.rowNumber,
      customerName: r.customerName,
      address: r.address,
      apptDateTime: r.apptDateTime,
    }))

  return NextResponse.json({
    fixDeployedAt: FIX_DEPLOYED_AT.toISOString(),
    summary: {
      totalDbAppointments: appts.length,
      totalSheetRows: sheetRows.length,
      sheetMatchedDbAppts: appts.filter(
        (a) =>
          a.masterSheetRowNumber &&
          sheetByRowNum.has(a.masterSheetRowNumber),
      ).length,
      mismatchCount: mismatches.length,
      orphanPreFixCount: orphanPreFix.length,
      sheetRowsMissingTzCount: sheetRowsMissingTz.length,
    },
    /** Most-actionable list — DB rows whose stored time disagrees
     *  with what Mary actually typed in the sheet. Sorted by
     *  absolute delta descending so the worst offenders are first. */
    mismatches: mismatches.sort(
      (a, b) => Math.abs(b.deltaHours) - Math.abs(a.deltaHours),
    ),
    /** DB rows from before the fix that have no sheet pairing.
     *  Can't auto-verify, but createdAt is pre-fix so they're
     *  suspect. Admin should eyeball in Master Tracker. */
    orphanPreFix,
    /** Sheet rows whose address has no detectable US state, so the
     *  tz brain falls back to America/New_York. Surfaced so admins
     *  can clean up addresses if the customer is actually elsewhere. */
    sheetRowsMissingTz,
  })
}

/**
 * True when `timezoneForAddress` would resolve a real state-derived
 * timezone (i.e. NOT just the America/New_York fallback). Lets us
 * distinguish "tz known" from "tz fell back".
 */
function timezoneForAddressKnown(address: string | null | undefined): boolean {
  if (!address) return false
  // Mirror stateCodeFromAddress's behavior cheaply — we just need to
  // know whether a state was detected. Easiest is to compare against
  // a no-state baseline.
  const tz = timezoneForAddress(address)
  if (tz !== 'America/New_York') return true
  // Only "known" if the address actually says NY/eastern state.
  // Otherwise it's the fallback.
  const lc = address.toLowerCase()
  return /(new york|\bny\b|new jersey|\bnj\b|connecticut|\bct\b|massachusetts|\bma\b|maine|\bme\b|new hampshire|\bnh\b|vermont|\bvt\b|rhode island|\bri\b|pennsylvania|\bpa\b|delaware|\bde\b|maryland|\bmd\b|virginia|\bva\b|washington dc|district of columbia|\bdc\b|north carolina|\bnc\b|south carolina|\bsc\b|georgia|\bga\b|florida|\bfl\b|west virginia|\bwv\b|ohio|\boh\b)/.test(
    lc,
  )
}
