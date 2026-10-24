'use client'

import { forwardRef, useEffect, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from 'react'
import { Loader2, X } from 'lucide-react'
import { cn } from '@/lib/utils'

/**
 * Hell-level's UI kit: GoHighLevel's look (white cards on a light canvas,
 * #155EEF blue, 8px radii, soft shadows), self-contained so it doesn't
 * depend on the Hub's dark tokens.
 */

export const HL = {
  blue: '#155EEF',
  text: '#101828',
  muted: '#667085',
  border: '#EAECF0',
}

/** fetch → JSON, throwing the API's error message. */
export async function hlFetch<T>(url: string, init?: RequestInit & { json?: unknown }): Promise<T> {
  const { json, ...rest } = init ?? {}
  const res = await fetch(url, {
    ...rest,
    ...(json !== undefined ? { body: JSON.stringify(json), headers: { 'content-type': 'application/json', ...(rest.headers ?? {}) } } : {}),
  })
  const data = (await res.json().catch(() => ({}))) as T & { error?: string; detail?: string }
  if (!res.ok) throw new Error(data.error || data.detail || `Request failed (${res.status})`)
  return data
}

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger' | 'success'
  size?: 'sm' | 'md'
  loading?: boolean
  icon?: ReactNode
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'secondary', size = 'md', loading, icon, className, children, disabled, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      disabled={disabled || loading}
      className={cn(
        'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-lg font-semibold transition disabled:cursor-not-allowed disabled:opacity-50',
        size === 'sm' ? 'h-8 px-3 text-[13px]' : 'h-10 px-4 text-[14px]',
        variant === 'primary' && 'bg-[#155EEF] text-white shadow-[0_1px_2px_rgba(16,24,40,0.05)] hover:bg-[#004EEB]',
        variant === 'secondary' && 'border border-[#D0D5DD] bg-white text-[#344054] shadow-[0_1px_2px_rgba(16,24,40,0.05)] hover:bg-[#F9FAFB]',
        variant === 'ghost' && 'text-[#475467] hover:bg-[#F2F4F7] hover:text-[#101828]',
        variant === 'danger' && 'bg-[#D92D20] text-white hover:bg-[#B42318]',
        variant === 'success' && 'bg-[#079455] text-white hover:bg-[#067647]',
        className,
      )}
      {...rest}
    >
      {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : icon}
      {children}
    </button>
  )
})

export function Card({ className, children, ...rest }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={cn('rounded-xl border border-[#EAECF0] bg-white shadow-[0_1px_2px_rgba(16,24,40,0.05)]', className)} {...rest}>
      {children}
    </div>
  )
}

const field =
  'w-full rounded-lg border border-[#D0D5DD] bg-white px-3 text-[14px] text-[#101828] shadow-[0_1px_2px_rgba(16,24,40,0.05)] outline-none transition placeholder:text-[#98A2B3] focus:border-[#84ADFF] focus:ring-4 focus:ring-[#155EEF]/10 disabled:bg-[#F9FAFB] disabled:text-[#667085]'

export function Label({ children, hint }: { children: ReactNode; hint?: ReactNode }) {
  return (
    <span className="flex flex-col gap-0.5">
      <span className="text-[13px] font-medium text-[#344054]">{children}</span>
      {hint && <span className="text-[12px] font-normal text-[#667085]">{hint}</span>}
    </span>
  )
}

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function Input({ className, ...rest }, ref) {
  return <input ref={ref} className={cn(field, 'h-10', className)} {...rest} />
})

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(function Textarea({ className, ...rest }, ref) {
  return <textarea ref={ref} className={cn(field, 'py-2.5 leading-relaxed', className)} {...rest} />
})

export function Select({ className, children, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select className={cn(field, 'h-10 cursor-pointer pr-8', className)} {...rest}>
      {children}
    </select>
  )
}

export function Field({ label, hint, children, className }: { label: ReactNode; hint?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <label className={cn('flex flex-col gap-1.5', className)}>
      <Label hint={hint}>{label}</Label>
      {children}
    </label>
  )
}

const BADGE = {
  gray: 'bg-[#F2F4F7] text-[#344054] ring-[#EAECF0]',
  blue: 'bg-[#EFF4FF] text-[#004EEB] ring-[#D1E0FF]',
  green: 'bg-[#ECFDF3] text-[#067647] ring-[#ABEFC6]',
  amber: 'bg-[#FFFAEB] text-[#B54708] ring-[#FEDF89]',
  red: 'bg-[#FEF3F2] text-[#B42318] ring-[#FECDCA]',
  purple: 'bg-[#F4F3FF] text-[#5925DC] ring-[#D9D6FE]',
}

export function Badge({ color = 'gray', children, className, dot }: { color?: keyof typeof BADGE; children: ReactNode; className?: string; dot?: boolean }) {
  return (
    <span className={cn('inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2 py-0.5 text-[12px] font-medium ring-1 ring-inset', BADGE[color], className)}>
      {dot && <span className="h-1.5 w-1.5 rounded-full bg-current" />}
      {children}
    </span>
  )
}

export function PageHeader({ title, description, actions }: { title: ReactNode; description?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-4">
      <div className="min-w-0">
        <h1 className="text-[22px] font-semibold tracking-tight text-[#101828]">{title}</h1>
        {description && <p className="mt-1 text-[14px] text-[#475467]">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  )
}

export function Modal({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  width = 'max-w-lg',
}: {
  open: boolean
  onClose: () => void
  title: ReactNode
  description?: ReactNode
  children: ReactNode
  footer?: ReactNode
  width?: string
}) {
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])
  if (!open) return null
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-[#0C111D]/60 p-4 pt-[8vh] backdrop-blur-[2px]" onMouseDown={onClose}>
      <div className={cn('w-full rounded-xl bg-white shadow-[0_20px_24px_-4px_rgba(16,24,40,0.08),0_8px_8px_-4px_rgba(16,24,40,0.03)]', width)} onMouseDown={(e) => e.stopPropagation()}>
        <div className="flex items-start justify-between gap-4 px-6 pt-5">
          <div>
            <h2 className="text-[18px] font-semibold text-[#101828]">{title}</h2>
            {description && <p className="mt-1 text-[14px] text-[#475467]">{description}</p>}
          </div>
          <button type="button" onClick={onClose} className="grid h-8 w-8 shrink-0 place-items-center rounded-lg text-[#98A2B3] hover:bg-[#F2F4F7] hover:text-[#344054]" aria-label="Close">
            <X className="h-5 w-5" />
          </button>
        </div>
        <div className="px-6 py-5">{children}</div>
        {footer && <div className="flex justify-end gap-3 border-t border-[#EAECF0] px-6 py-4">{footer}</div>}
      </div>
    </div>
  )
}

export function Tabs<T extends string>({ tabs, value, onChange }: { tabs: { key: T; label: ReactNode }[]; value: T; onChange: (k: T) => void }) {
  return (
    <div className="flex gap-1 border-b border-[#EAECF0]">
      {tabs.map((t) => (
        <button
          key={t.key}
          type="button"
          onClick={() => onChange(t.key)}
          className={cn(
            '-mb-px border-b-2 px-3 pb-3 pt-1 text-[14px] font-semibold transition',
            value === t.key ? 'border-[#155EEF] text-[#155EEF]' : 'border-transparent text-[#667085] hover:text-[#344054]',
          )}
        >
          {t.label}
        </button>
      ))}
    </div>
  )
}

export function Toggle({ checked, onChange, disabled, label }: { checked: boolean; onChange: (v: boolean) => void; disabled?: boolean; label?: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn('relative h-6 w-11 shrink-0 rounded-full transition disabled:opacity-50', checked ? 'bg-[#155EEF]' : 'bg-[#EAECF0]')}
    >
      <span className={cn('absolute top-0.5 h-5 w-5 rounded-full bg-white shadow-sm transition-all', checked ? 'left-[22px]' : 'left-0.5')} />
    </button>
  )
}

export function Empty({ icon, title, children, action }: { icon?: ReactNode; title: ReactNode; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 px-6 py-14 text-center">
      {icon && <div className="grid h-12 w-12 place-items-center rounded-full bg-[#F2F4F7] text-[#475467]">{icon}</div>}
      <p className="text-[16px] font-semibold text-[#101828]">{title}</p>
      {children && <div className="max-w-md text-[14px] text-[#475467]">{children}</div>}
      {action}
    </div>
  )
}

export function Spinner({ className }: { className?: string }) {
  return <Loader2 className={cn('h-5 w-5 animate-spin text-[#155EEF]', className)} />
}

export function ErrorNote({ error }: { error: unknown }) {
  if (!error) return null
  return <p className="rounded-lg border border-[#FECDCA] bg-[#FEF3F2] px-3 py-2 text-[13px] text-[#B42318]">{error instanceof Error ? error.message : String(error)}</p>
}

const AVATAR = ['#F79009', '#12B76A', '#2E90FA', '#7A5AF8', '#EE46BC', '#0BA5EC', '#F04438', '#6172F3']

export function Avatar({ name, size = 36 }: { name: string; size?: number }) {
  const initials = name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase())
    .join('') || '?'
  let h = 0
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0
  return (
    <span className="grid shrink-0 place-items-center rounded-full font-semibold text-white" style={{ width: size, height: size, background: AVATAR[h % AVATAR.length], fontSize: size * 0.38 }}>
      {/^\+?\d/.test(initials) ? '#' : initials}
    </span>
  )
}

export function timeAgo(iso: string | Date | null | undefined): string {
  if (!iso) return ''
  const ms = Date.now() - new Date(iso).getTime()
  if (ms < 60_000) return 'just now'
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h ago`
  if (ms < 7 * 86_400_000) return `${Math.floor(ms / 86_400_000)}d ago`
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

export function fmtDateTime(iso: string | Date | null | undefined): string {
  if (!iso) return ''
  return new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
}

export function copyText(text: string) {
  void navigator.clipboard?.writeText(text)
}
