/**
 * What the customize job puts into GHL, from a client's Automation Copy
 * details: one task per Incoming Lead workflow, carrying the Workflow AI
 * prompt the board shows and the exact copy each step must end up with.
 * Pure (no database, no browser) so it is unit-testable.
 */
import { automationFolders, blanksIn, siteLink, type AutomationInputs } from '@/lib/automation-copy'

export type ExpectedAction = {
  /** The step's name in the GHL workflow. */
  name: string
  /** 'SMS' | 'Internal notification (email)' | 'Internal notification (SMS)' */
  type: string
  /** The message, exactly as the Hub's copy has it. */
  text: string
  /** Internal email notifications: the address they must go to. */
  email?: string
  /** Internal SMS notifications: the number they must go to. */
  phone?: string
}

export type WorkflowTask = {
  /** The Automation Copy id ('missed-call', 'chat-widget', 'quote-form'). */
  id: string
  /** The workflow's name in GHL. */
  name: string
  prompt: string
  actions: ExpectedAction[]
}

/** Where the three workflows live in every client sub-account (the snapshot's folders). */
export const WORKFLOW_FOLDERS = ['Client Workflows', 'Incoming Lead Workflows'] as const

const EMAIL_TYPE = 'Internal notification (email)'
const SMS_TYPE = 'Internal notification (SMS)'

/** The board labels of the details a prompt still has a blank for, e.g. "WEBSITE LINK". */
export function customizeTasks(inputs: AutomationInputs): { tasks: WorkflowTask[]; blanks: string[] } {
  const folder = automationFolders(inputs).find((f) => f.id === 'incoming-leads')
  if (!folder) return { tasks: [], blanks: [] }
  const tasks = folder.automations.map((a, i) => ({
    id: a.id,
    name: a.name,
    prompt: folder.prompts[i]?.text ?? '',
    actions: a.pieces
      .filter((p) => p.action)
      .map((p) => ({
        name: p.action!.name,
        type: p.action!.type,
        text: p.text,
        ...(p.action!.type === EMAIL_TYPE ? { email: inputs.notifyEmail.trim() } : {}),
        ...(p.action!.type === SMS_TYPE ? { phone: inputs.phone.trim() } : {}),
      })),
  }))
  const blanks = new Set(tasks.flatMap((t) => [...blanksIn(t.prompt), ...t.actions.flatMap((a) => blanksIn(a.text))]))
  // Filled in but unusable counts as missing: GHL would get a number it can't text or a link that goes nowhere.
  if (inputs.phone.trim() && !fullUsNumber(inputs.phone)) blanks.add('BUSINESS PHONE')
  if (inputs.notifyEmail.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(inputs.notifyEmail.trim())) blanks.add('NOTIFICATION EMAIL')
  if (inputs.quoteLink.trim() && !/^https?:\/\/[^/\s]+\.[a-z]{2,}(?:[/?#]|$)/i.test(inputs.quoteLink.trim())) blanks.add('WEBSITE LINK')
  return { tasks, blanks: [...blanks] }
}

/** Ten digits, or eleven starting with the US country code. */
export function fullUsNumber(phone: string): boolean {
  const d = phone.replace(/\D/g, '')
  return d.length === 10 || (d.length === 11 && d.startsWith('1'))
}

/** "WEBSITE LINK" → "website link", for sentences. */
export function blankNames(blanks: string[]): string {
  const words = blanks.map((b) => b.toLowerCase())
  if (words.length <= 1) return words.join('')
  return `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`
}

function hostOf(link: string): string {
  try {
    return new URL(link).host.toLowerCase().replace(/^www\./, '')
  } catch {
    return ''
  }
}

/**
 * The free-quote link for the texts. The site we built wins once it is
 * linked, because a link typed on the board earlier is usually the client's
 * old website. A board link on the same site (a deeper page, such as a quote
 * page) is kept.
 */
export function quoteLinkFor(siteUrl: string | null | undefined, boardLink: string): string {
  const site = siteLink(siteUrl)
  if (!site) return boardLink
  const board = siteLink(boardLink)
  return board && hostOf(board) === hostOf(site) ? board : site
}

/** Two site links point at the same place (scheme, case and a trailing slash don't count). */
export function sameSiteLink(a: string | null | undefined, b: string | null | undefined): boolean {
  return siteLink(a).replace(/\/+$/, '') === siteLink(b).replace(/\/+$/, '')
}
