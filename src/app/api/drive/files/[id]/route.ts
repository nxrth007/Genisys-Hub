import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/auth'
import { renameFile, setStarred, trashFile } from '@/lib/drive'

/**
 * PATCH /api/drive/files/{id}
 * Body: { account: string, name?: string, starred?: boolean, trashed?: boolean }
 *
 * Supports partial updates — only the supplied fields are applied. `account`
 * is the connected mailbox whose OAuth token will perform the operation
 * (must have edit permission on the file).
 */
export async function PATCH(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> }
) {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  const { id } = await ctx.params
  const body = (await req.json().catch(() => ({}))) as {
    account?: string
    name?: string
    starred?: boolean
    trashed?: boolean
  }

  if (!body.account) {
    return NextResponse.json({ error: 'account required' }, { status: 400 })
  }

  try {
    let lastResult: unknown = null
    if (typeof body.name === 'string') {
      lastResult = await renameFile(body.account, id, body.name)
    }
    if (typeof body.starred === 'boolean') {
      lastResult = await setStarred(body.account, id, body.starred)
    }
    if (body.trashed === true) {
      lastResult = await trashFile(body.account, id)
    }
    return NextResponse.json({ ok: true, data: lastResult })
  } catch (err) {
    console.error('[drive/files PATCH] failed:', err)
    const googleMsg =
      (err as { response?: { data?: { error?: { message?: string } } } })?.response?.data?.error
        ?.message
    const message = googleMsg || (err instanceof Error ? err.message : 'Update failed')
    return NextResponse.json(
      { error: message },
      { status: message.includes('insufficient') || message.includes('Permission') ? 403 : 500 }
    )
  }
}
