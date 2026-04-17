'use client'

import { use } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  ArrowLeft,
  Database,
  Loader2,
  AlertCircle,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import Link from 'next/link'

// --- Inline helpers (duplicated from lib/notion to avoid server-only imports) ---

function richTextToPlain(richText: Array<{ plain_text?: string }> | undefined): string {
  if (!richText || !Array.isArray(richText)) return ''
  return richText.map((rt) => rt.plain_text || '').join('')
}

function extractPropertyValue(prop: Record<string, unknown>): string {
  if (!prop) return ''
  const type = prop.type as string

  switch (type) {
    case 'title':
      return richTextToPlain(prop.title as Array<{ plain_text?: string }>)
    case 'rich_text':
      return richTextToPlain(prop.rich_text as Array<{ plain_text?: string }>)
    case 'number':
      return prop.number != null ? String(prop.number) : ''
    case 'select':
      return (prop.select as { name?: string })?.name || ''
    case 'multi_select':
      return ((prop.multi_select as Array<{ name: string }>) || []).map((s) => s.name).join(', ')
    case 'date':
      return (prop.date as { start?: string })?.start || ''
    case 'checkbox':
      return prop.checkbox ? 'Yes' : 'No'
    case 'url':
      return (prop.url as string) || ''
    case 'email':
      return (prop.email as string) || ''
    case 'phone_number':
      return (prop.phone_number as string) || ''
    case 'status':
      return (prop.status as { name?: string })?.name || ''
    case 'people':
      return ((prop.people as Array<{ name?: string }>) || []).map((p) => p.name || '').join(', ')
    case 'relation':
      return ((prop.relation as Array<{ id: string }>) || []).length + ' linked'
    case 'formula': {
      const formula = prop.formula as Record<string, unknown>
      if (formula?.type === 'string') return (formula.string as string) || ''
      if (formula?.type === 'number') return String(formula.number ?? '')
      if (formula?.type === 'boolean') return formula.boolean ? 'Yes' : 'No'
      return ''
    }
    case 'rollup': {
      const rollup = prop.rollup as Record<string, unknown>
      if (rollup?.type === 'number') return String(rollup.number ?? '')
      return ''
    }
    case 'created_time':
      return (prop.created_time as string) || ''
    case 'last_edited_time':
      return (prop.last_edited_time as string) || ''
    default:
      return ''
  }
}

// --- Types ---

type SchemaProperty = {
  id: string
  type: string
  name: string
  [key: string]: unknown
}

type NotionPage = {
  id: string
  properties: Record<string, Record<string, unknown>>
}

type DatabaseResponse = {
  schema: {
    title?: Array<{ plain_text: string }>
    icon?: { type: string; emoji?: string } | null
    properties: Record<string, SchemaProperty>
  }
  results: NotionPage[]
  hasMore: boolean
  nextCursor: string | null
}

// --- Component ---

export default function DatabaseTablePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params)

  const dbQuery = useQuery<DatabaseResponse>({
    queryKey: ['notion-database', id],
    queryFn: async () => {
      const res = await fetch(`/api/notion/databases/${id}`)
      if (!res.ok) throw new Error('Failed to load database')
      return res.json()
    },
  })

  const schema = dbQuery.data?.schema
  const results = dbQuery.data?.results || []

  // Build column list from schema properties, title column first
  const columns: { name: string; type: string }[] = []
  if (schema?.properties) {
    const props = Object.entries(schema.properties)
    // Title column first
    const titleCol = props.find(([, v]) => v.type === 'title')
    if (titleCol) columns.push({ name: titleCol[0], type: 'title' })
    // Remaining columns
    for (const [name, prop] of props) {
      if (prop.type !== 'title') {
        columns.push({ name, type: prop.type })
      }
    }
  }

  const dbTitle = schema?.title
    ? schema.title.map((t) => t.plain_text).join('')
    : 'Database'

  return (
    <div className="flex-1 overflow-auto p-6">
      {/* Back button + title */}
      <div className="mb-6">
        <Link
          href="/notion"
          className="mb-3 inline-flex items-center gap-1.5 text-sm text-zinc-400 transition-colors hover:text-zinc-200"
        >
          <ArrowLeft className="h-4 w-4" />
          Back to Notion
        </Link>
        <div className="flex items-center gap-3">
          {schema?.icon?.emoji ? (
            <span className="text-2xl">{schema.icon.emoji}</span>
          ) : (
            <Database className="h-6 w-6 text-purple-500" />
          )}
          <h1 className="text-2xl font-bold text-zinc-100">{dbTitle}</h1>
        </div>
      </div>

      {/* Loading */}
      {dbQuery.isLoading && (
        <div className="flex items-center justify-center py-20">
          <Loader2 className="h-6 w-6 animate-spin text-purple-500" />
        </div>
      )}

      {/* Error */}
      {dbQuery.isError && (
        <div className="flex items-center gap-2 rounded-lg border border-red-800/50 bg-red-900/20 p-4 text-sm text-red-400">
          <AlertCircle className="h-4 w-4 flex-shrink-0" />
          <span>Failed to load database. Make sure the Notion integration has access.</span>
        </div>
      )}

      {/* Table */}
      {dbQuery.isSuccess && (
        <>
          {results.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-20 text-zinc-500">
              <Database className="mb-3 h-10 w-10 text-zinc-600" />
              <p className="text-sm font-medium">No rows in this database</p>
            </div>
          ) : (
            <div className="overflow-x-auto rounded-lg border border-zinc-700/50">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-zinc-700/50 bg-zinc-800/80">
                    {columns.map((col) => (
                      <th
                        key={col.name}
                        className="whitespace-nowrap px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-zinc-400"
                      >
                        {col.name}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-zinc-700/30">
                  {results.map((row) => (
                    <tr
                      key={row.id}
                      className="transition-colors hover:bg-zinc-800/40"
                    >
                      {columns.map((col) => {
                        const prop = row.properties[col.name]
                        const value = prop ? extractPropertyValue(prop) : ''
                        const isTitle = col.type === 'title'
                        return (
                          <td
                            key={col.name}
                            className={cn(
                              'whitespace-nowrap px-4 py-3',
                              isTitle
                                ? 'font-medium text-zinc-100'
                                : 'text-zinc-300'
                            )}
                          >
                            {value || <span className="text-zinc-600">-</span>}
                          </td>
                        )
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {dbQuery.data?.hasMore && (
            <p className="mt-3 text-center text-xs text-zinc-500">
              Showing first {results.length} rows. More results available.
            </p>
          )}
        </>
      )}
    </div>
  )
}
