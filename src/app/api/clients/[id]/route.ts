import { NextResponse } from 'next/server'
import { auth } from '@/auth'
import { prisma } from '@/lib/prisma'
import { normalizeClientPatch } from '@/lib/clients'
import { backfillClientDeliveries } from '@/lib/client-delivery'
import { backfillClientAlerts } from '@/lib/client-alert'
import { getSecretByName } from '@/lib/vault-service'

/**
 * Email allowed to perform destructive operations on the Client
 * table. Hardcoded because Alex is the only person Alex authorized,
 * and "admin" role isn't strict enough — Ethan is also admin but
 * shouldn't be able to delete clients without Alex's say-so. If
 * that calculus changes, lift this to a per-action permission table.
 */
const CLIENT_DELETE_AUTHORIZED_EMAIL = 'alex@leadgenisys.com'

/**
 * Vault entry name holding the password Alex must type to confirm
 * a client deletion. Stored in the existing vault so it can be
 * rotated without code changes and never enters the bundle.
 * Pre-deploy step: Alex creates this vault entry via /vault with
 * a password of his choosing.
 */
const CLIENT_DELETE_PASSWORD_VAULT_ENTRY = 'Client Delete Password'

/**
 * PATCH /api/clients/:id
 *   Partial update — any subset of name, state, color, lifecycle,
 *   contact*, address, notes, intakeFormUrl, ghlSubaccountUrl. Used
 *   by both the row-level status select on /clients and the full
 *   edit dialog.
 *
 * Admin-only: route is reachable by any signed-in user (the agent
 * allow-list includes /api/clients) but middleware doesn't gate by
 * HTTP method, so we enforce role here.
 */
export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }
  // Staff-only: both admin and member roles are staff and need to
  // manage clients. Agents (+ pending/denied) are blocked — earlier
  // this was `role !== 'admin'`, which blocked Ethan (role=member)
  // from saving edits with a misleading 403.
  const role = (session.user as { role?: string } | undefined)?.role
  if (role !== 'admin' && role !== 'member') {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }

  const { id } = await params

  let body: unknown
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'invalid JSON body' }, { status: 400 })
  }

  const parsed = normalizeClientPatch(body)
  if (!parsed.ok) {
    return NextResponse.json({ error: parsed.error }, { status: 400 })
  }
  if (Object.keys(parsed.data).length === 0) {
    return NextResponse.json({ error: 'no fields to update' }, { status: 400 })
  }

  // If the admin is renaming the client, pre-check uniqueness so the
  // error stays human-readable.
  if (parsed.data.name) {
    const conflict = await prisma.client.findFirst({
      where: { name: parsed.data.name, id: { not: id } },
    })
    if (conflict) {
      return NextResponse.json(
        { error: `A client named "${parsed.data.name}" already exists.` },
        { status: 409 }
      )
    }
  }

  // Detect a newly-set Slack channel — when it transitions from
  // null/different to a real value, we need to backfill the delivery
  // ledger so the next cron tick doesn't blast every existing sheet
  // row into the freshly-configured channel.
  let priorChannelId: string | null = null
  let priorContactPhone: string | null = null
  if ('slackChannelId' in parsed.data || 'contactPhone' in parsed.data) {
    const prior = await prisma.client.findUnique({
      where: { id },
      select: { slackChannelId: true, contactPhone: true },
    })
    priorChannelId = prior?.slackChannelId ?? null
    priorContactPhone = prior?.contactPhone ?? null
  }

  try {
    const client = await prisma.client.update({
      where: { id },
      data: parsed.data,
      select: {
        id: true,
        name: true,
        state: true,
        color: true,
        lifecycle: true,
        package: true,
        apptCap: true,
        contactName: true,
        contactRole: true,
        contactEmail: true,
        contactPhone: true,
        address: true,
        notes: true,
        intakeFormUrl: true,
        ghlSubaccountUrl: true,
        active: true,
        slackChannelId: true,
        slackChannelName: true,
      },
    })

    // Backfill runs synchronously: when an admin first sets (or
    // re-routes) a channel, we MUST mark every current sheet row as
    // already-delivered before the next cron tick fires. The trade-off
    // is up to ~5s of blocking on the sheet read; acceptable since
    // admins only do this once per client per channel change.
    if (
      client.slackChannelId &&
      client.slackChannelId !== priorChannelId
    ) {
      try {
        const result = await backfillClientDeliveries({
          clientId: client.id,
          channelId: client.slackChannelId,
        })
        console.log(
          `[clients] backfilled ${result.recorded} historical rows for ${client.name} → ${client.slackChannelName ?? client.slackChannelId} (${result.alreadyTracked} were already tracked)`
        )
      } catch (err) {
        // Don't fail the PATCH if backfill blows up — the channel is
        // already saved, and the admin can retry from Settings. But
        // *do* warn so they know to verify before the next sync.
        console.error('[clients] backfill failed:', err)
      }
    }

    // Same backfill story for the Client Alerts SMS path: if the
    // master toggle is on AND contactPhone just transitioned from
    // null/different to a real value, mark every current sheet row
    // as 'backfilled' so the next cron tick doesn't blast the new
    // recipient with every historical appointment for this client.
    // No-op when ClientAlertsConfig.enabled is false (cron itself
    // would be a no-op anyway, so backfill would be wasted I/O).
    if (
      client.contactPhone &&
      client.contactPhone !== priorContactPhone
    ) {
      const alertsConfig = await prisma.clientAlertsConfig
        .findUnique({ where: { id: 'singleton' } })
        .catch(() => null)
      if (alertsConfig?.enabled) {
        try {
          const result = await backfillClientAlerts({
            clientId: client.id,
            recipientPhone: client.contactPhone,
          })
          console.log(
            `[clients] alert-backfilled ${result.recorded} historical rows for ${client.name} → ${client.contactPhone} (${result.alreadyTracked} were already tracked)`,
          )
        } catch (err) {
          console.error('[clients] alert-backfill failed:', err)
        }
      }
    }

    return NextResponse.json({ client })
  } catch (err) {
    // Most likely cause: client not found. Prisma throws P2025 in that
    // case; surfacing as 404 is the friendlier API contract.
    if (
      err instanceof Error &&
      'code' in err &&
      (err as { code?: string }).code === 'P2025'
    ) {
      return NextResponse.json({ error: 'client not found' }, { status: 404 })
    }
    throw err
  }
}

/**
 * DELETE /api/clients/:id
 *
 * Two gates, both must pass:
 *   1. Session email matches CLIENT_DELETE_AUTHORIZED_EMAIL exactly.
 *      Even other admins (Ethan) can't delete clients — only Alex.
 *   2. Body { password } matches the value stored in the
 *      "Client Delete Password" vault entry. Compared with a
 *      timing-safe Buffer.equals so a brute-force attempt can't
 *      lean on millisecond differences.
 *
 * On success: prisma.client.delete cascades per the schema:
 *   - Appointment.clientId → SetNull (rows survive, lose link)
 *   - ReminderTemplate.clientId → Cascade (per-client overrides die)
 *   - AppointmentReminder.clientId → SetNull
 *   - SheetSlackDelivery.clientId → SetNull
 *   - ClientAlertDelivery.clientId → SetNull
 *
 * Errors:
 *   401 — not signed in
 *   403 — signed in as the wrong account, OR password mismatch.
 *         Both buckets surface the same status so the endpoint
 *         doesn't leak which gate failed (defense in depth — the
 *         response body has the human-readable reason for the UI,
 *         a probing attacker can't distinguish the two without an
 *         active session as the authorized user).
 *   404 — client doesn't exist
 *   503 — vault entry missing
 */
export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }
  const sessionEmail = (session.user.email ?? '').toLowerCase()
  if (sessionEmail !== CLIENT_DELETE_AUTHORIZED_EMAIL.toLowerCase()) {
    return NextResponse.json(
      {
        error: `Only ${CLIENT_DELETE_AUTHORIZED_EMAIL} can delete clients.`,
      },
      { status: 403 },
    )
  }

  const { id } = await params

  let body: { password?: unknown }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'invalid JSON body' }, { status: 400 })
  }
  const provided =
    typeof body.password === 'string' ? body.password : ''
  if (!provided) {
    return NextResponse.json(
      { error: 'password is required' },
      { status: 400 },
    )
  }

  let expected: string
  try {
    expected = await getSecretByName(CLIENT_DELETE_PASSWORD_VAULT_ENTRY)
  } catch {
    return NextResponse.json(
      {
        error: `Add a vault entry named "${CLIENT_DELETE_PASSWORD_VAULT_ENTRY}" before deleting clients.`,
      },
      { status: 503 },
    )
  }

  // Timing-safe compare. Buffer.from with a length mismatch would
  // throw, so equalize lengths first by checking length explicitly —
  // unequal lengths short-circuit fast (no timing leak there since
  // the attacker would need to know the length anyway, which we
  // already implicitly leak via the human-readable error message
  // shape). Equal-length comparison goes through the constant-time
  // path.
  const a = Buffer.from(provided, 'utf8')
  const b = Buffer.from(expected, 'utf8')
  const passwordOk =
    a.length === b.length &&
    (await import('node:crypto')).timingSafeEqual(a, b)
  if (!passwordOk) {
    return NextResponse.json(
      { error: 'incorrect password' },
      { status: 403 },
    )
  }

  // Verify existence before delete so we can return 404 cleanly
  // (delete on a non-existent row throws P2025 but the friendlier
  // contract is to surface it explicitly).
  const existing = await prisma.client.findUnique({
    where: { id },
    select: { id: true, name: true },
  })
  if (!existing) {
    return NextResponse.json({ error: 'client not found' }, { status: 404 })
  }

  await prisma.client.delete({ where: { id } })
  console.log(
    `[clients DELETE] ${sessionEmail} deleted client "${existing.name}" (${id})`,
  )
  return NextResponse.json({ ok: true, deleted: existing })
}
