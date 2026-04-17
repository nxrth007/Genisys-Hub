import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { auth } from '@/auth'
import { createPage } from '@/lib/notion'

const BodySchema = z.object({
  parentId: z.string().min(1),
  isDatabase: z.boolean().optional().default(false),
  properties: z.record(z.string(), z.unknown()),
  children: z.array(z.record(z.string(), z.unknown())).optional(),
})

export async function POST(req: NextRequest) {
  const session = await auth()
  if (!session?.user?.id) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

  const body = await req.json().catch(() => null)
  const parsed = BodySchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message }, { status: 400 })
  }

  try {
    const result = await createPage(
      parsed.data.parentId,
      parsed.data.properties,
      parsed.data.isDatabase,
      parsed.data.children
    )
    return NextResponse.json(result, { status: 201 })
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 })
  }
}
