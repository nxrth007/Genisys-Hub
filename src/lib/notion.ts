/**
 * Notion API helper — vault-aware.
 *
 * Pulls the API key from vault entry "Notion API Key" (or whatever the user
 * named it — falls back to any vault entry tagged "notion").
 */
import { getSecretByName, listEntriesByTag } from './vault-service'

const NOTION_API = 'https://api.notion.com/v1'

async function getApiKey(): Promise<string> {
  // Try exact name first, then tag-based fallback
  try {
    return await getSecretByName('Notion API Key')
  } catch {
    const entries = await listEntriesByTag('notion')
    if (entries.length > 0) {
      return await getSecretByName(entries[0].name)
    }
    throw new Error(
      'No Notion API key found in the vault. Add one named "Notion API Key" (or tag any entry with "notion").'
    )
  }
}

async function notionFetch(path: string, options: RequestInit = {}): Promise<Record<string, unknown>> {
  const apiKey = await getApiKey()
  const res = await fetch(`${NOTION_API}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Notion-Version': '2022-06-28',
      'Content-Type': 'application/json',
      ...options.headers,
    },
  })

  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Notion API error ${res.status}: ${text}`)
  }

  return res.json()
}

export async function searchNotion(query: string, filter?: { property: string; value: string }) {
  const body: Record<string, unknown> = { query, page_size: 20 }
  if (filter) body.filter = { property: filter.property, value: filter.value }
  return notionFetch('/search', { method: 'POST', body: JSON.stringify(body) })
}

export async function getPage(pageId: string) {
  return notionFetch(`/pages/${pageId}`)
}

export async function getPageContent(blockId: string) {
  return notionFetch(`/blocks/${blockId}/children?page_size=100`)
}

export async function getDatabase(databaseId: string) {
  return notionFetch(`/databases/${databaseId}`)
}

export async function queryDatabase(
  databaseId: string,
  filter?: unknown,
  sorts?: unknown[],
  startCursor?: string
) {
  const body: Record<string, unknown> = { page_size: 50 }
  if (filter) body.filter = filter
  if (sorts) body.sorts = sorts
  if (startCursor) body.start_cursor = startCursor
  return notionFetch(`/databases/${databaseId}/query`, {
    method: 'POST',
    body: JSON.stringify(body),
  })
}

export async function createPage(
  parentId: string,
  properties: Record<string, unknown>,
  isDatabase = false,
  children?: unknown[]
) {
  const body: Record<string, unknown> = {
    parent: isDatabase ? { database_id: parentId } : { page_id: parentId },
    properties,
  }
  if (children) body.children = children
  return notionFetch('/pages', { method: 'POST', body: JSON.stringify(body) })
}

export async function updatePage(pageId: string, properties: Record<string, unknown>) {
  return notionFetch(`/pages/${pageId}`, {
    method: 'PATCH',
    body: JSON.stringify({ properties }),
  })
}

export async function listUsers() {
  return notionFetch('/users')
}

// ---- Helpers ----

export function richTextToPlain(richText: Array<{ plain_text?: string }> | undefined): string {
  if (!richText || !Array.isArray(richText)) return ''
  return richText.map((rt) => rt.plain_text || '').join('')
}

export function extractPropertyValue(prop: Record<string, unknown>): string {
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

export function blocksToText(blocks: Array<Record<string, unknown>>): string {
  return blocks
    .map((block) => {
      const type = block.type as string
      const content = block[type] as Record<string, unknown> | undefined
      if (!content) return ''
      if (content.rich_text) {
        return richTextToPlain(content.rich_text as Array<{ plain_text?: string }>)
      }
      if (type === 'image') return '[Image]'
      if (type === 'divider') return '---'
      return ''
    })
    .filter(Boolean)
    .join('\n')
}
