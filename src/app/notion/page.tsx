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

type FilterType = 'all' | 'page' | 'database'

type NotionResult = {
  id: string
  object: 'page' | 'database'
  icon?: { type: string; emoji?: string } | null
  url?: string
  last_edited_time?: string
  title?: Array<{ plain_text: string }>
  properties?: Record<string, { type: string; title?: Array<{ plain_text: string }>; [k: string]: unknown }>
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
        return prop.title.map((t: { plain_text: string }) => t.plain_text).join('') || 'Untitled'
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
    <div className="flex-1 overflow-auto p-6">
      {/* Header */}
      <div className="mb-6">
        <div className="flex items-center gap-3 mb-1">
          <BookOpen className="h-6 w-6 text-blue-500" />
          <h1 className="text-2xl font-bold text-zinc-100">Notion</h1>
        </div>
        <p className="text-sm text-zinc-400">Search and browse your Notion workspace</p>
      </div>

      {/* Search */}
      <form onSubmit={handleSubmit} className="mb-4">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-zinc-400" />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search pages and databases..."
            className="w-full rounded-lg border border-zinc-700 bg-zinc-800/50 py-2.5 pl-10 pr-4 text-sm text-zinc-100 placeholder:text-zinc-500 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
          />
        </div>
      </form>

      {/* Filter chips */}
      <div className="mb-6 flex gap-2">
        {filters.map((f) => (
          <button
            key={f.value}
            onClick={() => setFilter(f.value)}
            className={cn(
              'rounded-full px-4 py-1.5 text-xs font-medium transition-colors',
              filter === f.value
                ? 'bg-blue-600 text-white'
                : 'bg-zinc-800 text-zinc-400 hover:bg-zinc-700 hover:text-zinc-200'
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
        <div className="flex items-center gap-2 rounded-lg border border-red-800/50 bg-red-900/20 p-4 text-sm text-red-400">
          <AlertCircle className="h-4 w-4 flex-shrink-0" />
          <span>Failed to search Notion. Check your API key in Settings.</span>
        </div>
      )}

      {/* Results */}
      {searchQuery.isSuccess && (
        <>
          {/* Empty state */}
          {results.length === 0 && (
            <div className="flex flex-col items-center justify-center py-20 text-zinc-500">
              <BookOpen className="mb-3 h-10 w-10 text-zinc-600" />
              <p className="text-sm font-medium">No results found</p>
              <p className="mt-1 text-xs text-zinc-600">
                {submitted ? 'Try a different search term' : 'Search to find pages and databases'}
              </p>
            </div>
          )}

          {/* Databases section */}
          {databases.length > 0 && (
            <div className="mb-8">
              <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold text-zinc-300">
                <Database className="h-4 w-4 text-blue-400" />
                Databases
                <span className="text-xs font-normal text-zinc-500">({databases.length})</span>
              </h2>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {databases.map((db) => (
                  <div
                    key={db.id}
                    className="rounded-lg border border-zinc-700/50 bg-zinc-800/50 p-4 transition-colors hover:border-zinc-600"
                  >
                    <div className="mb-2 flex items-start justify-between">
                      <div className="flex items-center gap-2 min-w-0">
                        <span className="text-lg flex-shrink-0">
                          {db.icon?.emoji || <Database className="h-4 w-4 text-zinc-500" />}
                        </span>
                        <span className="truncate text-sm font-medium text-zinc-100">
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
                        const isTaskDb = title.includes('task') || title.includes('tracker') || title.includes('board') || title.includes('todo') || title.includes('sprint')
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
                        className="inline-flex items-center gap-1.5 rounded-md border border-zinc-600 px-3 py-1.5 text-xs font-medium text-zinc-300 transition-colors hover:bg-zinc-700 hover:text-zinc-100"
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
              <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold text-zinc-300">
                <FileText className="h-4 w-4 text-blue-400" />
                Pages
                <span className="text-xs font-normal text-zinc-500">({pages.length})</span>
              </h2>
              <div className="divide-y divide-zinc-700/50 rounded-lg border border-zinc-700/50 bg-zinc-800/30">
                {pages.map((page) => (
                  <div
                    key={page.id}
                    className="flex items-center justify-between gap-4 px-4 py-3 transition-colors hover:bg-zinc-800/60"
                  >
                    <div className="flex items-center gap-3 min-w-0">
                      <span className="text-base flex-shrink-0">
                        {page.icon?.emoji || <FileText className="h-4 w-4 text-zinc-500" />}
                      </span>
                      <div className="min-w-0">
                        <Link
                          href={`/notion/page/${stripDashes(page.id)}`}
                          className="block truncate text-sm font-medium text-zinc-100 hover:text-blue-400 transition-colors"
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
                    <div className="flex items-center gap-2 flex-shrink-0">
                      <Link
                        href={`/notion/page/${stripDashes(page.id)}`}
                        className="rounded-md px-3 py-1.5 text-xs font-medium text-zinc-300 transition-colors hover:bg-zinc-700 hover:text-zinc-100"
                      >
                        View
                      </Link>
                      {page.url && (
                        <a
                          href={page.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="rounded-md p-1.5 text-zinc-500 transition-colors hover:bg-zinc-700 hover:text-zinc-300"
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
