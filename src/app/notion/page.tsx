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
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground/70" />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search pages and databases…"
            className="w-full rounded-lg border border-border bg-card py-2.5 pl-10 pr-4 text-sm text-foreground placeholder:text-muted-foreground focus:border-primary/50 focus:outline-none focus:ring-1 focus:ring-primary/30 border-border bg-card text-foreground placeholder:text-muted-foreground"
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
              'rounded-lg px-4 py-1.5 text-xs font-medium transition-colors',
              filter === f.value
                ? 'bg-foreground text-background'
                : 'bg-muted text-muted-foreground hover:bg-muted hover:text-foreground bg-surface-muted text-muted-foreground hover:bg-muted hover:text-foreground'
            )}
          >
            {f.label}
          </button>
        ))}
      </div>

      {/* Loading */}
      {searchQuery.isLoading && (
        <div className="flex items-center justify-center py-20">
          <Loader2 className="h-6 w-6 animate-spin text-primary" />
        </div>
      )}

      {/* Error */}
      {searchQuery.isError && (
        <div className="flex items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/10 p-4 text-sm text-destructive border-destructive/30 bg-destructive/10 text-destructive">
          <AlertCircle className="h-4 w-4 flex-shrink-0" />
          <span>Failed to search Notion. Check your API key in Settings.</span>
        </div>
      )}

      {/* Results */}
      {searchQuery.isSuccess && (
        <>
          {/* Empty state */}
          {results.length === 0 && (
            <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-border py-16 text-center text-muted-foreground border-border">
              <BookOpen className="mb-3 h-10 w-10 text-muted-foreground/50" />
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
              <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold text-foreground/85">
                <Database className="h-4 w-4 text-primary" />
                Databases
                <span className="text-xs font-normal text-muted-foreground">
                  ({databases.length})
                </span>
              </h2>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {databases.map((db) => (
                  <div
                    key={db.id}
                    className="rounded-xl border border-border bg-card p-4 transition-colors hover:border-foreground/30 border-border bg-card hover:border-foreground/30"
                  >
                    <div className="mb-2 flex items-start justify-between">
                      <div className="flex min-w-0 items-center gap-2">
                        <span className="flex-shrink-0 text-lg">
                          {db.icon?.emoji || (
                            <Database className="h-4 w-4 text-muted-foreground/70" />
                          )}
                        </span>
                        <span className="truncate text-sm font-medium text-foreground">
                          {extractTitle(db)}
                        </span>
                      </div>
                    </div>
                    {db.last_edited_time && (
                      <p className="mb-3 text-xs text-muted-foreground">
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
                            className="inline-flex items-center gap-1.5 rounded-md bg-foreground px-3 py-1.5 text-xs font-medium text-background transition-colors hover:bg-foreground/90"
                          >
                            <LayoutGrid className="h-3 w-3" />
                            Board View
                          </Link>
                        ) : null
                      })()}
                      <Link
                        href={`/notion/db/${stripDashes(db.id)}`}
                        className="inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-xs font-medium text-foreground/85 transition-colors hover:bg-muted hover:text-foreground border-border text-foreground/85 hover:bg-muted hover:text-foreground"
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
              <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold text-foreground/85">
                <FileText className="h-4 w-4 text-primary" />
                Pages
                <span className="text-xs font-normal text-muted-foreground">
                  ({pages.length})
                </span>
              </h2>
              <div className="divide-y divide-border-soft rounded-xl border border-border bg-card divide-border-soft border-border bg-card">
                {pages.map((page) => (
                  <div
                    key={page.id}
                    className="flex items-center justify-between gap-4 px-4 py-3 transition-colors hover:bg-muted hover:bg-muted/60"
                  >
                    <div className="flex min-w-0 items-center gap-3">
                      <span className="flex-shrink-0 text-base">
                        {page.icon?.emoji || (
                          <FileText className="h-4 w-4 text-muted-foreground/70" />
                        )}
                      </span>
                      <div className="min-w-0">
                        <Link
                          href={`/notion/page/${stripDashes(page.id)}`}
                          className="block truncate text-sm font-medium text-foreground transition-colors hover:text-primary text-foreground hover:text-primary"
                        >
                          {extractTitle(page)}
                        </Link>
                        {page.last_edited_time && (
                          <p className="text-xs text-muted-foreground">
                            Edited {formatDate(page.last_edited_time)}
                          </p>
                        )}
                      </div>
                    </div>
                    <div className="flex flex-shrink-0 items-center gap-2">
                      <Link
                        href={`/notion/page/${stripDashes(page.id)}`}
                        className="rounded-md px-3 py-1.5 text-xs font-medium text-foreground/85 transition-colors hover:bg-muted hover:text-foreground text-foreground/85 hover:bg-muted hover:text-foreground"
                      >
                        View
                      </Link>
                      {page.url && (
                        <a
                          href={page.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="rounded-md p-1.5 text-muted-foreground/70 transition-colors hover:bg-muted hover:text-foreground hover:bg-muted hover:text-foreground"
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
