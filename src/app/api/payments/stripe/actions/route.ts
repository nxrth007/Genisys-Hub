import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/auth'
import { canAccessPayments } from '@/lib/payments-access'
import { getSecretByName } from '@/lib/vault-service'

/**
 * POST /api/payments/stripe/actions
 *
 * Write actions for the Payments → Stripe tab. Uses the full-access
 * "Stripe API Key" from the Vault; the key never reaches the client.
 * Gated to the Payments email allowlist (owner + Ethan).
 *
 * Actions (body.action):
 *   refund            { chargeId, amountCents? }   — full or partial refund
 *   finalizeInvoice   { invoiceId }
 *   sendInvoice       { invoiceId }                — EMAILS the customer
 *   voidInvoice       { invoiceId }
 *   markUncollectible { invoiceId }
 *   createInvoice     { email, name?, amountCents, description?, daysUntilDue?, sendNow? }
 *
 * Every one of these moves real money / emails real customers, so the
 * UI confirms before calling.
 */

const STRIPE_BASE = 'https://api.stripe.com/v1'

async function stripeReq(
  path: string,
  key: string,
  method: 'GET' | 'POST',
  form?: Record<string, string | number | undefined>,
) {
  const body =
    method === 'POST' && form
      ? new URLSearchParams(
          Object.entries(form)
            .filter(([, v]) => v !== undefined && v !== '')
            .map(([k, v]) => [k, String(v)]),
        )
      : undefined
  const res = await fetch(`${STRIPE_BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${key}`,
      ...(body ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
    },
    body,
    cache: 'no-store',
  })
  const data = await res.json().catch(() => ({}))
  return { ok: res.ok, status: res.status, data }
}

function stripeError(data: unknown, fallback: string) {
  const d = data as { error?: { message?: string } }
  return d?.error?.message || fallback
}

export async function POST(req: NextRequest) {
  const session = await auth()
  if (!canAccessPayments(session?.user?.email)) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }

  let key: string
  try {
    key = await getSecretByName('Stripe API Key')
  } catch {
    return NextResponse.json(
      { error: 'No "Stripe API Key" found in the Vault.' },
      { status: 400 },
    )
  }

  let body: Record<string, unknown>
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }
  const action = String(body.action ?? '')

  // ---- Refund a charge (full or partial)
  if (action === 'refund') {
    const chargeId = String(body.chargeId ?? '')
    if (!chargeId) {
      return NextResponse.json({ error: 'chargeId required' }, { status: 400 })
    }
    const amountCents = Number(body.amountCents ?? 0)
    const res = await stripeReq('/refunds', key, 'POST', {
      charge: chargeId,
      ...(amountCents > 0 ? { amount: amountCents } : {}),
    })
    if (!res.ok) {
      return NextResponse.json(
        { error: stripeError(res.data, 'Refund failed.') },
        { status: 502 },
      )
    }
    return NextResponse.json({ ok: true, message: 'Refund issued.' })
  }

  // ---- Simple invoice lifecycle actions
  const invoiceOps: Record<string, { path: string; msg: string }> = {
    finalizeInvoice: { path: 'finalize', msg: 'Invoice finalized.' },
    sendInvoice: { path: 'send', msg: 'Invoice emailed to the customer.' },
    voidInvoice: { path: 'void', msg: 'Invoice voided.' },
    markUncollectible: {
      path: 'mark_uncollectible',
      msg: 'Invoice marked uncollectible.',
    },
  }
  if (invoiceOps[action]) {
    const invoiceId = String(body.invoiceId ?? '')
    if (!invoiceId) {
      return NextResponse.json({ error: 'invoiceId required' }, { status: 400 })
    }
    const op = invoiceOps[action]
    const res = await stripeReq(
      `/invoices/${invoiceId}/${op.path}`,
      key,
      'POST',
      {},
    )
    if (!res.ok) {
      return NextResponse.json(
        { error: stripeError(res.data, `${action} failed.`) },
        { status: 502 },
      )
    }
    return NextResponse.json({ ok: true, message: op.msg })
  }

  // ---- Create (and optionally send) an invoice
  if (action === 'createInvoice') {
    const email = String(body.email ?? '').trim()
    const amountCents = Math.round(Number(body.amountCents ?? 0))
    if (!email) {
      return NextResponse.json(
        { error: 'Customer email is required.' },
        { status: 400 },
      )
    }
    if (!Number.isFinite(amountCents) || amountCents <= 0) {
      return NextResponse.json(
        { error: 'Amount must be greater than 0.' },
        { status: 400 },
      )
    }
    const description = String(body.description ?? '').trim()
    const daysUntilDue = Number(body.daysUntilDue ?? 7) || 7
    const sendNow = body.sendNow === true

    // Reuse an existing customer with this email, else create one.
    const lookup = await stripeReq(
      `/customers?email=${encodeURIComponent(email)}&limit=1`,
      key,
      'GET',
    )
    let customerId =
      ((lookup.data as { data?: Array<{ id?: string }> })?.data ?? [])[0]?.id ??
      ''
    if (!customerId) {
      const created = await stripeReq('/customers', key, 'POST', {
        email,
        name: String(body.name ?? '').trim() || undefined,
      })
      if (!created.ok) {
        return NextResponse.json(
          { error: stripeError(created.data, 'Could not create customer.') },
          { status: 502 },
        )
      }
      customerId = (created.data as { id: string }).id
    }

    // Pending invoice item → invoice picks it up on create.
    const item = await stripeReq('/invoiceitems', key, 'POST', {
      customer: customerId,
      amount: amountCents,
      currency: String(body.currency ?? 'usd'),
      description: description || undefined,
    })
    if (!item.ok) {
      return NextResponse.json(
        { error: stripeError(item.data, 'Could not add the line item.') },
        { status: 502 },
      )
    }

    const invoice = await stripeReq('/invoices', key, 'POST', {
      customer: customerId,
      collection_method: 'send_invoice',
      days_until_due: daysUntilDue,
      description: description || undefined,
      auto_advance: 'false',
    })
    if (!invoice.ok) {
      return NextResponse.json(
        { error: stripeError(invoice.data, 'Could not create the invoice.') },
        { status: 502 },
      )
    }
    const invoiceId = (invoice.data as { id: string }).id

    if (!sendNow) {
      return NextResponse.json({
        ok: true,
        invoiceId,
        message: 'Draft invoice created (not sent).',
      })
    }

    const finalized = await stripeReq(
      `/invoices/${invoiceId}/finalize`,
      key,
      'POST',
      {},
    )
    if (!finalized.ok) {
      return NextResponse.json(
        {
          error: stripeError(
            finalized.data,
            'Invoice created but could not be finalized.',
          ),
        },
        { status: 502 },
      )
    }
    const sent = await stripeReq(`/invoices/${invoiceId}/send`, key, 'POST', {})
    if (!sent.ok) {
      return NextResponse.json(
        {
          error: stripeError(
            sent.data,
            'Invoice finalized but the email failed to send.',
          ),
        },
        { status: 502 },
      )
    }
    return NextResponse.json({
      ok: true,
      invoiceId,
      message: `Invoice created and emailed to ${email}.`,
    })
  }

  return NextResponse.json({ error: `Unknown action "${action}"` }, { status: 400 })
}
