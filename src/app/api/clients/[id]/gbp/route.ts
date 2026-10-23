import { NextResponse } from 'next/server'
import { auth } from '@/auth'
import { requireStaff } from '@/lib/auth-helpers'
import { gbpBoard, lookupExistingListing, markVerified, publicSetupLink, saveGbpBoard, sendSetupInstructions, sendVerificationChecklist } from '@/lib/gbp-setup'

/**
 * The Google Business Profile board for a client (src/lib/gbp-setup.ts).
 *   GET  → kit prefill, saved edits, status, Maps search, texts sent
 *   PUT  → save { values?, status?, remind? }
 *   POST → { action: 'lookup' } search Google Maps for an existing listing
 *          { action: 'text' } text the owner the verification checklist
 *          { action: 'verified', profileUrl?, reviewUrl? } record it and push the links
 *          { action: 'send_instructions' } text + email the owner their setup page link
 *          { action: 'public_link' } the client's setup page link (made once)
 * Staff only, like the A2P board.
 */

async function who(): Promise<string | null> {
  const s = await auth()
  return (s?.user?.email as string | undefined) ?? null
}

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const denied = await requireStaff()
  if (denied) return denied
  const { id } = await params
  const board = await gbpBoard(id)
  if (!board) return NextResponse.json({ error: 'client not found' }, { status: 404 })
  return NextResponse.json(board)
}

export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const denied = await requireStaff()
  if (denied) return denied
  const { id } = await params
  const body = (await req.json().catch(() => ({}))) as { values?: unknown; status?: unknown; remind?: unknown }
  if (!(await gbpBoard(id))) return NextResponse.json({ error: 'client not found' }, { status: 404 })
  return NextResponse.json({ state: await saveGbpBoard(id, body, await who()) })
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const denied = await requireStaff()
  if (denied) return denied
  const { id } = await params
  const body = (await req.json().catch(() => ({}))) as { action?: unknown; profileUrl?: unknown; reviewUrl?: unknown }
  if (!(await gbpBoard(id))) return NextResponse.json({ error: 'client not found' }, { status: 404 })
  const by = await who()
  if (body.action === 'lookup') return NextResponse.json({ lookup: await lookupExistingListing(id) })
  if (body.action === 'text') return NextResponse.json(await sendVerificationChecklist(id, by))
  if (body.action === 'verified') return NextResponse.json(await markVerified(id, body, by))
  if (body.action === 'send_instructions') return NextResponse.json(await sendSetupInstructions(id, by))
  if (body.action === 'public_link') return NextResponse.json({ link: await publicSetupLink(id) })
  return NextResponse.json({ error: 'unknown action' }, { status: 400 })
}
