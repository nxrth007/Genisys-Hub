import type { CSSProperties } from 'react'
import { inkOn } from './color'
import type { HlFormSettings } from './types'

/**
 * A form's colours as CSS variables, for the public form (a client
 * component) and the pages around it (server components) alike. Anything
 * unset keeps the plain light look.
 */

const HEX = /^#[0-9a-f]{6}$/i

export function formStyle(s: HlFormSettings): CSSProperties {
  const pick = (v: string | undefined, fallback: string) => (v && HEX.test(v) ? v : fallback)
  return {
    ['--hl-c' as string]: pick(s.color, '#155EEF'),
    // Unset: white, or dark where white wouldn't read on the colour (a gold brand colour, say).
    ['--hl-btn-text' as string]: pick(s.buttonText, inkOn(pick(s.color, '#155EEF'))),
    ['--hl-text' as string]: pick(s.textColor, '#101828'),
    ['--hl-input-bg' as string]: pick(s.inputBackground, '#FFFFFF'),
    ['--hl-input-text' as string]: pick(s.inputText, '#101828'),
    ['--hl-input-border' as string]: pick(s.inputBorder, '#D0D5DD'),
  }
}

/** The page behind the form: its colour, or none so the website shows through the iframe. Only ever a hex or "transparent", so it's safe in a <style> tag. */
export const formBackground = (s: HlFormSettings) => (s.background === 'transparent' ? 'transparent' : s.background && HEX.test(s.background) ? s.background : '#FFFFFF')
