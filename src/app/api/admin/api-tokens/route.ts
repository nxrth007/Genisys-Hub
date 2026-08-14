import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/auth'
import { prisma } from '@/lib/prisma'
import { requireAdmin } from '@/lib/auth-helpers'
import { createApiToken } from '@/lib/external-api'

/**
 * Admin management of API tokens for externally-hosted frontends
 * (the Lovable Vite SPA).
 *
 * Admin-only: a token reads real client + appointment data, so minting
 * one is a privileged act. The plaintext is returned exactly once by
 * POST and is unrecoverable afterwards — only its hash is stored.
 */

export async function GET() {
  const denial = await requireAdmin()
  if (denial) return denial

  const tokens = await prisma.apiToken.findMany({
    orderBy: { createdAt: 'desc' },
    include: { createdBy: { select: { name: true, email: true } } },
  })

  return NextResponse.json({
    ok: true,
    tokens: tokens.map((t) => ({
      id: t.id,
      name: t.name,
      prefix: t.prefix,
      scope: t.scope,
      createdBy: t.createdBy?.name ?? t.createdBy?.email ?? null,
      lastUsedAt: t.lastUsedAt,
      revokedAt: t.revokedAt,
      createdAt: t.createdAt,
    })),
  })
}

export async function POST(req: NextRequest) {
  const denial = await requireAdmin()
  if (denial) return denial

  let body: Record<string, unknown>
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const name = String(body.name ?? '').trim()
  if (!name) {
    return NextResponse.json(
      { error: 'Give the token a name so you can tell them apart later.' },
      { status: 400 },
    )
  }

  const session = await auth()
  const { token, plaintext } = await createApiToken(
    name,
    (session?.user as { id?: string } | undefined)?.id,
  )

  return NextResponse.json({
    ok: true,
    // Shown once. Never retrievable again.
    plaintext,
    token: { id: token.id, name: token.name, prefix: token.prefix },
    message: 'Copy this token now — it cannot be shown again.',
  })
}

export async function DELETE(req: NextRequest) {
  const denial = await requireAdmin()
  if (denial) return denial

  const id = req.nextUrl.searchParams.get('id')
  if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 })

  // Revoke rather than delete, so the audit trail of what existed survives.
  await prisma.apiToken.update({
    where: { id },
    data: { revokedAt: new Date() },
  })

  return NextResponse.json({ ok: true, message: 'Token revoked.' })
}
