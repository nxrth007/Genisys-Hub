import { NextResponse } from 'next/server'
import { auth } from '@/auth'
import { migrateAddClientColumn } from '@/lib/drive'

/**
 * POST /api/admin/sheets/migrate-client-column
 *
 * One-off admin-only migration: appends a "Client" header column to every
 * tab in the master appointments spreadsheet that doesn't already have one.
 * Idempotent — safe to run multiple times.
 *
 * Call it once after deploy:
 *   curl -X POST https://genisys-hub.onrender.com/api/admin/sheets/migrate-client-column \
 *        -H "Cookie: <your-auth-cookie>"
 * Or just open the URL in a logged-in admin browser tab via the dev tools
 * console:
 *   fetch('/api/admin/sheets/migrate-client-column', { method: 'POST' })
 *     .then(r => r.json()).then(console.log)
 */
export async function POST() {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }
  // Middleware already gates /api/admin/* to role=admin, so we can trust the
  // session here.
  try {
    const result = await migrateAddClientColumn()
    return NextResponse.json({ ok: true, ...result })
  } catch (err) {
    console.error('[sheets migrate-client-column] failed:', err)
    const message = err instanceof Error ? err.message : 'Migration failed'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
