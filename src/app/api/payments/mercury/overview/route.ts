import { NextResponse } from 'next/server'
import { auth } from '@/auth'
import { canAccessPayments } from '@/lib/payments-access'
import { getSecretByName } from '@/lib/vault-service'

/**
 * GET /api/payments/mercury/overview
 *
 * Server-side proxy for the Mercury dashboard. Reads the "Mercury API
 * key" from the Vault and calls the Mercury REST API directly. The key
 * never reaches the client. Gated to the Payments email allowlist.
 */

const MERCURY_BASE = 'https://api.mercury.com/api/v1'

async function mercuryGet(
  path: string,
  key: string,
): Promise<{ ok: boolean; status: number; data: unknown }> {
  const res = await fetch(`${MERCURY_BASE}${path}`, {
    headers: { Authorization: `Bearer ${key}` },
    cache: 'no-store',
  })
  const data = await res.json().catch(() => ({}))
  return { ok: res.ok, status: res.status, data }
}

type MercuryTxn = {
  id: string
  amount: number
  counterpartyName: string | null
  createdAt: string | null
  status: string | null
  kind: string | null
  note: string | null
  bankDescription: string | null
  accountName: string
}

export async function GET() {
  const session = await auth()
  if (!canAccessPayments(session?.user?.email)) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }

  let key: string
  try {
    key = await getSecretByName('Mercury API key')
  } catch {
    return NextResponse.json(
      { error: 'no-key', message: 'No "Mercury API key" found in the Vault.' },
      { status: 400 },
    )
  }

  const accountsRes = await mercuryGet('/accounts', key)
  if (!accountsRes.ok) {
    const d = accountsRes.data as { errors?: unknown; message?: string }
    return NextResponse.json(
      {
        error: 'mercury-error',
        status: accountsRes.status,
        message:
          d?.message ||
          `Mercury returned ${accountsRes.status} — check the "Mercury API key" in the Vault (and its IP whitelist).`,
      },
      { status: 502 },
    )
  }

  const rawAccounts =
    (accountsRes.data as { accounts?: Array<Record<string, unknown>> })
      ?.accounts ?? []

  const accounts = rawAccounts.map((a) => ({
    id: String(a.id),
    name:
      (a.nickname as string) ||
      (a.name as string) ||
      `Account ${String(a.accountNumber ?? '').slice(-4)}`,
    last4: String(a.accountNumber ?? '').slice(-4),
    kind: (a.kind as string) ?? (a.type as string) ?? null,
    status: (a.status as string) ?? null,
    currentBalance: Number(a.currentBalance ?? 0),
    availableBalance: Number(a.availableBalance ?? 0),
  }))

  // Recent transactions across accounts (cap accounts scanned + per-acct
  // pulls so one call can't fan out unbounded), merged + newest first.
  const txnLists = await Promise.all(
    accounts.slice(0, 5).map(async (acct) => {
      const res = await mercuryGet(
        `/account/${acct.id}/transactions?limit=10`,
        key,
      )
      if (!res.ok) return [] as MercuryTxn[]
      const list =
        (res.data as { transactions?: Array<Record<string, unknown>> })
          ?.transactions ?? []
      return list.map(
        (t): MercuryTxn => ({
          id: String(t.id),
          amount: Number(t.amount ?? 0),
          counterpartyName: (t.counterpartyName as string) ?? null,
          createdAt: (t.createdAt as string) ?? (t.postedAt as string) ?? null,
          status: (t.status as string) ?? null,
          kind: (t.kind as string) ?? null,
          note: (t.note as string) ?? null,
          bankDescription: (t.bankDescription as string) ?? null,
          accountName: acct.name,
        }),
      )
    }),
  )

  const transactions = txnLists
    .flat()
    .sort(
      (a, b) =>
        new Date(b.createdAt ?? 0).getTime() -
        new Date(a.createdAt ?? 0).getTime(),
    )
    .slice(0, 15)

  const totalBalance = accounts.reduce((s, a) => s + a.availableBalance, 0)

  return NextResponse.json({
    ok: true,
    accounts,
    transactions,
    totalBalance,
  })
}
