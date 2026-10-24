'use client'

import { Plus, Trash2, TriangleAlert } from 'lucide-react'
import { MARKETING_CONSENT_TEXT, SMS_CONSENT_TEXT } from '@/lib/hl/templates'
import type { HlConsentBox } from '@/lib/hl/types'
import { Button, Textarea } from './ui'

const KINDS: { kind: HlConsentBox['kind']; label: string; text: string }[] = [
  { kind: 'sms', label: 'Texts about their request', text: SMS_CONSENT_TEXT },
  { kind: 'marketing', label: 'Promotional texts', text: MARKETING_CONSENT_TEXT },
]

/** The consent checkboxes under a form or booking page: the two standard ones, each optional by default. */
export function ConsentBoxesEditor({ value, onChange, business }: { value: HlConsentBox[]; onChange: (v: HlConsentBox[]) => void; business: string }) {
  const set = (kind: HlConsentBox['kind'], patch: Partial<HlConsentBox>) => onChange(value.map((c) => (c.kind === kind ? { ...c, ...patch } : c)))
  return (
    <div className="flex flex-col gap-3">
      <p className="text-[12.5px] text-muted-foreground">
        {'{{business}}'} becomes “{business}”. “Privacy Policy” and “Terms” in the wording link to the policy pages. Both boxes start unchecked; carriers look for that.
      </p>
      {KINDS.map((k) => {
        const box = value.find((c) => c.kind === k.kind)
        if (!box) {
          return (
            <Button key={k.kind} icon={<Plus className="h-4 w-4" />} onClick={() => onChange([...value, { kind: k.kind, text: k.text, required: false }].sort((a) => (a.kind === 'sms' ? -1 : 1)))}>
              Add the {k.label.toLowerCase()} box
            </Button>
          )
        }
        return (
          <div key={k.kind} className="flex flex-col gap-2 rounded-lg border border-border p-3">
            <div className="flex items-center justify-between gap-2">
              <p className="text-[13px] font-medium text-foreground">{k.label}</p>
              <span className="flex items-center gap-3">
                <button type="button" className="text-[12px] text-muted-foreground hover:text-foreground" onClick={() => set(k.kind, { text: k.text })}>
                  Standard wording
                </button>
                <label className="flex items-center gap-1.5 text-[12.5px] text-foreground/85">
                  <input type="checkbox" checked={!!box.required} onChange={(e) => set(k.kind, { required: e.target.checked })} /> Required
                </label>
                <button type="button" className="text-muted-foreground hover:text-destructive" title="Remove this box" onClick={() => onChange(value.filter((c) => c.kind !== k.kind))}>
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </span>
            </div>
            <Textarea rows={4} value={box.text} onChange={(e) => set(k.kind, { text: e.target.value })} />
            {box.required && (
              <p className="flex items-start gap-1.5 text-[12px] text-warning">
                <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                Carriers reject texting verification when agreeing to texts is required to send the form. Keep it optional where a number is being verified.
              </p>
            )}
          </div>
        )
      })}
    </div>
  )
}
