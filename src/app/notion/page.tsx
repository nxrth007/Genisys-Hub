'use client'

import { useState, FormEvent } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  Search,
  Database,
  FileText,
  ExternalLink,
  Table,
  LayoutGrid,
  Loader2,
  BookOpen,
  AlertCircle,
} from 'lucide-react'
import { cn, formatDate } from '@/lib/utils'
import Link from 'next/link'
import { PageHeader } from '@/components/ui/page-header'

type FilterType = 'all' | 'page' | 'database'

type NotionResult = {
  id: string
  object: 'page' | 'database'
  icon?: { type: string; emoji?: string } | null
  url?: string
  last_edited_time?: string
  title?: Array<{ plain_text: string }>
  properties?: Record<
    string,
    { type: string; title?: Array<{ plain_text: string }>; [k: string]: unknown }
  >
}

function extractTitle(item: NotionResult): string {
  // Databases expose title at top level
  if (item.object === 'database' && item.title) {
    return item.title.map((t) => t.plain_text).join('') || 'Untitled'
  }
  // Pages keep it in properties
  if (item.properties) {
    for (const prop of Object.values(item.properties)) {
      if (prop.type === 'title' && prop.title) {
        return (
          prop.title.map((t: { plain_text: string }) => t.plain_text).join('') ||
          'Untitled'
        )
      }
    }
  }
  return 'Untitled'
}

function stripDashes(id: string): string {
  return id.replace(/-/g, '')
}

export default function NotionPage() {
  const [query, setQuery] = useState('')
  const [submitted, setSubmitted] = useState('')
  const [filter, setFilter] = useState<FilterType>('all')

  const searchQuery = useQuery<{ results: NotionResult[] }>({
    queryKey: ['notion-search', submitted, filter],
    queryFn: async () => {
      const params = new URLSearchParams()
      if (submitted) params.set('q', submitted)
      if (filter !== 'all') params.set('type', filter)
      const res = await fetch(`/api/notion/search?${params}`)
      if (!res.ok) throw new Error('Search failed')
      return res.json()
    },
    enabled: true,
  })

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault()
    setSubmitted(query)
  }

  const results = searchQuery.data?.results || []
  const databases = results.filter((r) => r.object === 'database')
  const pages = results.filter((r) => r.object === 'page')

  const filters: { label: string; value: FilterType }[] = [
    { label: 'All', value: 'all' },
    { label: 'Pages', value: 'page' },
    { label: 'Databases', value: 'database' },
  ]

  return (
    <div className="mx-auto max-w-5xl space-y-5">
      <PageHeader
        icon={BookOpen}
        title="Notion"
        subtitle="Search and browse your Notion workspace"
      />

      {/* Search */}
      <form onSubmit={handleSubmit}>
        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-400" />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search pages and databases…"
            className="w-full rounded-lg border border-zinc-200 bg-white py-2.5 pl-10 pr-4 text-sm text-zinc-900 placeholder:text-zinc-400 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100 dark:placeholder:text-zinc-500"
          />
        </div>
      </form>

      {/* Filter chips */}
      <div className="flex gap-2">
        {filters.map((f) => (
          <button
            key={f.value}
            onClick={() => setFilter(f.value)}
            className={cn(
              'rounded-full px-4 py-1.5 text-xs font-medium transition-colors',
              filter === f.value
                ? 'bg-blue-600 text-white'
                : 'bg-zinc-100 text-zinc-600 hover:bg-zinc-200 hover:text-zinc-900 dark:bg-zinc-800 dark:text-zinc-400 dark:hover:bg-zinc-700 dark:hover:text-zinc-200'
            )}
          >
            {f.label}
          </button>
        ))}
      </div>

      {/* Loading */}
      {searchQuery.isLoading && (
        <div className="flex items-center justify-center py-20">
          <Loader2 className="h-6 w-6 animate-spin text-blue-500" />
        </div>
      )}

      {/* Error */}
      {searchQuery.isError && (
        <div className="flex items-center gap-2 rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300">
          <AlertCircle className="h-4 w-4 flex-shrink-0" />
          <span>Failed to search Notion. Check your API key in Settings.</span>
        </div>
      )}

      {/* Results */}
      {searchQuery.isSuccess && (
        <>
          {/* Empty state */}
          {results.length === 0 && (
            <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-zinc-200 py-16 text-center text-zinc-500 dark:border-zinc-800">
              <BookOpen className="mb-3 h-10 w-10 text-zinc-300 dark:text-zinc-600" />
              <p className="text-sm font-medium">No results found</p>
              <p className="mt-1 text-xs">
                {submitted
                  ? 'Try a different search term'
                  : 'Search to find pages and databases'}
              </p>
            </div>
          )}

          {/* Databases section */}
          {databases.length > 0 && (
            <div>
              <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold text-zinc-700 dark:text-zinc-300">
                <Database className="h-4 w-4 text-blue-500" />
                Databases
                <span className="text-xs font-normal text-zinc-500">
                  ({databases.length})
                </span>
              </h2>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {databases.map((db) => (
                  <div
                    key={db.id}
                    className="rounded-xl border border-zinc-200 bg-white p-4 transition-colors hover:border-zinc-300 hover:shadow-sm dark:border-zinc-800 dark:bg-zinc-900 dark:hover:border-zinc-700"
                  >
                    <div className="mb-2 flex items-start justify-between">
                      <div className="flex min-w-0 items-center gap-2">
                        <span className="flex-shrink-0 text-lg">
                          {db.icon?.emoji || (
                            <Database className="h-4 w-4 text-zinc-400" />
                          )}
                        </span>
                        <span className="truncate text-sm font-medium text-zinc-900 dark:text-zinc-100">
                          {extractTitle(db)}
                        </span>
                      </div>
                    </div>
                    {db.last_edited_time && (
                      <p className="mb-3 text-xs text-zinc-500">
                        Edited {formatDate(db.last_edited_time)}
                      </p>
                    )}
                    <div className="flex gap-2">
                      {(() => {
                        const title = extractTitle(db).toLowerCase()
                        const isTaskDb =
                          title.includes('task') ||
                          title.includes('tracker') ||
                          title.includes('board') ||
                          title.includes('todo') ||
                          title.includes('sprint')
                        return isTaskDb ? (
                          <Link
                            href={`/notion/tasks/${stripDashes(db.id)}`}
                            className="inline-flex items-center gap-1.5 rounded-md bg-blue-600 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-blue-700"
                          >
                            <LayoutGrid className="h-3 w-3" />
                            Board View
                          </Link>
                        ) : null
                      })()}
                      <Link
                        href={`/notion/db/${stripDashes(db.id)}`}
                        className="inline-flex items-center gap-1.5 rounded-md border border-zinc-200 px-3 py-1.5 text-xs font-medium text-zinc-700 transition-colors hover:bg-zinc-100 hover:text-zinc-900 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800 dark:hover:text-zinc-100"
                      >
                        <Table className="h-3 w-3" />
                        Table View
                      </Link>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Pages section */}
          {pages.length > 0 && (
            <div>
              <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold text-zinc-700 dark:text-zinc-300">
                <FileText className="h-4 w-4 text-blue-500" />
                Pages
                <span className="text-xs font-normal text-zinc-500">
                  ({pages.length})
                </span>
              </h2>
              <div className="divide-y divide-zinc-100 rounded-xl border border-zinc-200 bg-white dark:divide-zinc-800 dark:border-zinc-800 dark:bg-zinc-900">
                {pages.map((page) => (
                  <div
                    key={page.id}
                    className="flex items-center justify-between gap-4 px-4 py-3 transition-colors hover:bg-zinc-50 dark:hover:bg-zinc-800/60"
                  >
                    <div className="flex min-w-0 items-center gap-3">
                      <span className="flex-shrink-0 text-base">
                        {page.icon?.emoji || (
                          <FileText className="h-4 w-4 text-zinc-400" />
                        )}
                      </span>
                      <div className="min-w-0">
                        <Link
                          href={`/notion/page/${stripDashes(page.id)}`}
                          className="block truncate text-sm font-medium text-zinc-900 transition-colors hover:text-blue-600 dark:text-zinc-100 dark:hover:text-blue-400"
                        >
                          {extractTitle(page)}
                        </Link>
                        {page.last_edited_time && (
                          <p className="text-xs text-zinc-500">
                            Edited {formatDate(page.last_edited_time)}
                          </p>
                        )}
                      </div>
                    </div>
                    <div className="flex flex-shrink-0 items-center gap-2">
                      <Link
                        href={`/notion/page/${stripDashes(page.id)}`}
                        className="rounded-md px-3 py-1.5 text-xs font-medium text-zinc-700 transition-colors hover:bg-zinc-100 hover:text-zinc-900 dark:text-zinc-300 dark:hover:bg-zinc-800 dark:hover:text-zinc-100"
                      >
                        View
                      </Link>
                      {page.url && (
                        <a
                          href={page.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="rounded-md p-1.5 text-zinc-400 transition-colors hover:bg-zinc-100 hover:text-zinc-700 dark:hover:bg-zinc-800 dark:hover:text-zinc-200"
                          title="Open in Notion"
                        >
                          <ExternalLink className="h-3.5 w-3.5" />
                        </a>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  )
}
