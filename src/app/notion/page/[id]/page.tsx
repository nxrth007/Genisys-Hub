'use client'

import { use } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  ArrowLeft,
  FileText,
  ExternalLink,
  Loader2,
  AlertCircle,
  Image as ImageIcon,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import Link from 'next/link'

// --- Types ---

type Annotation = {
  bold: boolean
  italic: boolean
  strikethrough: boolean
  underline: boolean
  code: boolean
  color: string
}

type RichTextItem = {
  plain_text: string
  href?: string | null
  annotations: Annotation
}

type Block = {
  id: string
  type: string
  [key: string]: unknown
}

type NotionPageResponse = {
  page: {
    id: string
    url?: string
    icon?: { type: string; emoji?: string } | null
    properties?: Record<string, {
      type: string
      title?: Array<{ plain_text: string }>
      [k: string]: unknown
    }>
  }
  blocks: Block[]
}

// --- Helpers ---

function extractTitle(page: NotionPageResponse['page']): string {
  if (!page.properties) return 'Untitled'
  for (const prop of Object.values(page.properties)) {
    if (prop.type === 'title' && prop.title) {
      return prop.title.map((t) => t.plain_text).join('') || 'Untitled'
    }
  }
  return 'Untitled'
}

function RichText({ items }: { items: RichTextItem[] }) {
  if (!items || items.length === 0) return null
  return (
    <>
      {items.map((item, i) => {
        let node: React.ReactNode = item.plain_text
        const a = item.annotations

        if (a.code) {
          node = (
            <code className="rounded bg-zinc-700/50 px-1.5 py-0.5 text-xs font-mono text-blue-300">
              {node}
            </code>
          )
        }
        if (a.bold) node = <strong className="font-semibold">{node}</strong>
        if (a.italic) node = <em>{node}</em>
        if (a.strikethrough) node = <s>{node}</s>
        if (a.underline) node = <u>{node}</u>

        if (item.href) {
          node = (
            <a
              href={item.href}
              target="_blank"
              rel="noopener noreferrer"
              className="text-blue-400 underline decoration-blue-400/30 hover:decoration-blue-400"
            >
              {node}
            </a>
          )
        }

        return <span key={i}>{node}</span>
      })}
    </>
  )
}

function BlockRenderer({ block }: { block: Block }) {
  const type = block.type
  const content = block[type] as Record<string, unknown> | undefined
  if (!content) return null

  const richText = content.rich_text as RichTextItem[] | undefined

  switch (type) {
    case 'paragraph':
      return (
        <p className="text-sm leading-relaxed text-zinc-300">
          {richText && richText.length > 0 ? (
            <RichText items={richText} />
          ) : (
            <span className="block h-4" />
          )}
        </p>
      )

    case 'heading_1':
      return (
        <h1 className="mt-6 mb-2 text-xl font-bold text-zinc-100">
          <RichText items={richText || []} />
        </h1>
      )

    case 'heading_2':
      return (
        <h2 className="mt-5 mb-2 text-lg font-bold text-zinc-100">
          <RichText items={richText || []} />
        </h2>
      )

    case 'heading_3':
      return (
        <h3 className="mt-4 mb-1.5 text-base font-semibold text-zinc-100">
          <RichText items={richText || []} />
        </h3>
      )

    case 'bulleted_list_item':
      return (
        <li className="ml-5 list-disc text-sm text-zinc-300">
          <RichText items={richText || []} />
        </li>
      )

    case 'numbered_list_item':
      return (
        <li className="ml-5 list-decimal text-sm text-zinc-300">
          <RichText items={richText || []} />
        </li>
      )

    case 'to_do': {
      const checked = content.checked as boolean
      return (
        <div className="flex items-start gap-2 text-sm text-zinc-300">
          <input
            type="checkbox"
            checked={checked}
            readOnly
            className="mt-1 accent-blue-600"
          />
          <span className={cn(checked && 'line-through text-zinc-500')}>
            <RichText items={richText || []} />
          </span>
        </div>
      )
    }

    case 'toggle':
      return (
        <details className="text-sm text-zinc-300">
          <summary className="cursor-pointer font-medium text-zinc-200 hover:text-zinc-100">
            <RichText items={richText || []} />
          </summary>
        </details>
      )

    case 'quote':
      return (
        <blockquote className="border-l-2 border-blue-500 pl-4 text-sm italic text-zinc-400">
          <RichText items={richText || []} />
        </blockquote>
      )

    case 'callout': {
      const icon = (content.icon as { emoji?: string })?.emoji
      return (
        <div className="flex gap-3 rounded-lg border border-zinc-700/50 bg-zinc-800/50 p-4 text-sm text-zinc-300">
          {icon && <span className="text-lg flex-shrink-0">{icon}</span>}
          <div>
            <RichText items={richText || []} />
          </div>
        </div>
      )
    }

    case 'code': {
      const language = (content.language as string) || ''
      const codeText = richText?.map((r) => r.plain_text).join('') || ''
      return (
        <div className="rounded-lg border border-zinc-700/50 bg-zinc-900 overflow-hidden">
          {language && (
            <div className="border-b border-zinc-700/50 px-4 py-1.5 text-xs text-zinc-500">
              {language}
            </div>
          )}
          <pre className="overflow-x-auto p-4 text-xs leading-relaxed text-zinc-300">
            <code>{codeText}</code>
          </pre>
        </div>
      )
    }

    case 'divider':
      return <hr className="my-4 border-zinc-700/50" />

    case 'image': {
      const imageType = content.type as string
      const src =
        imageType === 'external'
          ? (content.external as { url: string })?.url
          : (content.file as { url: string })?.url
      const caption = content.caption as RichTextItem[] | undefined
      return (
        <figure className="my-4">
          {src ? (
            <img
              src={src}
              alt={caption?.map((c) => c.plain_text).join('') || 'Image'}
              className="max-w-full rounded-lg border border-zinc-700/50"
            />
          ) : (
            <div className="flex items-center gap-2 rounded-lg border border-zinc-700/50 bg-zinc-800/50 p-6 text-sm text-zinc-500">
              <ImageIcon className="h-4 w-4" />
              Image unavailable
            </div>
          )}
          {caption && caption.length > 0 && (
            <figcaption className="mt-2 text-center text-xs text-zinc-500">
              <RichText items={caption} />
            </figcaption>
          )}
        </figure>
      )
    }

    case 'bookmark': {
      const url = content.url as string | undefined
      return url ? (
        <a
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          className="block rounded-lg border border-zinc-700/50 bg-zinc-800/50 p-3 text-sm text-blue-400 hover:bg-zinc-800 transition-colors truncate"
        >
          {url}
        </a>
      ) : null
    }

    case 'embed': {
      const url = content.url as string | undefined
      return url ? (
        <a
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          className="block rounded-lg border border-zinc-700/50 bg-zinc-800/50 p-3 text-sm text-blue-400 hover:bg-zinc-800 transition-colors truncate"
        >
          {url}
        </a>
      ) : null
    }

    case 'table_of_contents':
      return (
        <div className="rounded-lg border border-zinc-700/50 bg-zinc-800/30 p-3 text-xs text-zinc-500 italic">
          Table of contents
        </div>
      )

    default:
      return null
  }
}

// --- Page Component ---

export default function NotionPageView({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params)

  const pageQuery = useQuery<NotionPageResponse>({
    queryKey: ['notion-page', id],
    queryFn: async () => {
      const res = await fetch(`/api/notion/pages/${id}`)
      if (!res.ok) throw new Error('Failed to load page')
      return res.json()
    },
  })

  const page = pageQuery.data?.page
  const blocks = pageQuery.data?.blocks || []
  const title = page ? extractTitle(page) : ''

  return (
    <div className="flex-1 overflow-auto p-6">
      {/* Back button */}
      <div className="mb-6">
        <Link
          href="/notion"
          className="mb-3 inline-flex items-center gap-1.5 text-sm text-zinc-400 transition-colors hover:text-zinc-200"
        >
          <ArrowLeft className="h-4 w-4" />
          Back to Notion
        </Link>
      </div>

      {/* Loading */}
      {pageQuery.isLoading && (
        <div className="flex items-center justify-center py-20">
          <Loader2 className="h-6 w-6 animate-spin text-blue-500" />
        </div>
      )}

      {/* Error */}
      {pageQuery.isError && (
        <div className="flex items-center gap-2 rounded-lg border border-red-800/50 bg-red-900/20 p-4 text-sm text-red-400">
          <AlertCircle className="h-4 w-4 flex-shrink-0" />
          <span>Failed to load page. Make sure the Notion integration has access.</span>
        </div>
      )}

      {/* Content */}
      {pageQuery.isSuccess && page && (
        <>
          {/* Title area */}
          <div className="mb-8">
            <div className="flex items-start gap-4">
              <div className="flex-1">
                <div className="flex items-center gap-3 mb-2">
                  {page.icon?.emoji ? (
                    <span className="text-3xl">{page.icon.emoji}</span>
                  ) : (
                    <FileText className="h-7 w-7 text-blue-500" />
                  )}
                  <h1 className="text-2xl font-bold text-zinc-100">{title}</h1>
                </div>
              </div>
              {page.url && (
                <a
                  href={page.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex-shrink-0 inline-flex items-center gap-1.5 rounded-lg border border-zinc-700 bg-zinc-800/50 px-3 py-2 text-xs font-medium text-zinc-300 transition-colors hover:border-blue-600 hover:text-blue-400"
                >
                  <ExternalLink className="h-3.5 w-3.5" />
                  Open in Notion
                </a>
              )}
            </div>
          </div>

          {/* Blocks */}
          <div className="max-w-3xl space-y-2">
            {blocks.length === 0 ? (
              <p className="py-10 text-center text-sm text-zinc-500">
                This page has no content blocks.
              </p>
            ) : (
              blocks.map((block) => (
                <BlockRenderer key={(block as { id: string }).id} block={block} />
              ))
            )}
          </div>
        </>
      )}
    </div>
  )
}
