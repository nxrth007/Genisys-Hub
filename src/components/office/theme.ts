import type { OfficeStatus } from '@/lib/office/mapping'

export type OfficeTheme = 'day' | 'evening' | 'night'
export const OFFICE_THEMES: OfficeTheme[] = ['day', 'evening', 'night']

export const STATUS_META: Record<OfficeStatus, { label: string; color: string }> = {
  coding: { label: 'Coding', color: '#3b82f6' },
  browsing: { label: 'Browsing', color: '#f97316' },
  terminal: { label: 'In terminal', color: '#a855f7' },
  thinking: { label: 'Thinking', color: '#f43f5e' },
  needs_you: { label: 'Needs you', color: '#eab308' },
  error: { label: 'Error', color: '#dc2626' },
  idle: { label: 'Idle', color: '#6b7280' },
}

export type Palette = {
  bg: string
  floorA: string
  floorB: string
  floorLine: string
  wallLeft: string
  wallRight: string
  wallTop: string
  window: string
  glass: string
  glassEdge: string
  woodTop: string
  woodLeft: string
  woodRight: string
  ambient: string
  ambientOpacity: number
  glow: number
}

export const PALETTES: Record<OfficeTheme, Palette> = {
  night: {
    bg: '#07090d',
    floorA: '#3a2a1f',
    floorB: '#33251b',
    floorLine: 'rgba(0,0,0,0.35)',
    wallLeft: '#22252b',
    wallRight: '#1b1e23',
    wallTop: '#2c3037',
    window: '#0f2238',
    glass: 'rgba(150,200,235,0.10)',
    glassEdge: 'rgba(170,215,245,0.45)',
    woodTop: '#3b2a20',
    woodLeft: '#2a1d16',
    woodRight: '#22170f',
    ambient: '#0a1430',
    ambientOpacity: 0.38,
    glow: 1,
  },
  evening: {
    bg: '#14100f',
    floorA: '#5a3f2b',
    floorB: '#523826',
    floorLine: 'rgba(0,0,0,0.28)',
    wallLeft: '#34363c',
    wallRight: '#2b2d33',
    wallTop: '#3e4148',
    window: '#a8573a',
    glass: 'rgba(255,210,170,0.10)',
    glassEdge: 'rgba(255,220,190,0.45)',
    woodTop: '#4a3428',
    woodLeft: '#35241b',
    woodRight: '#2c1d15',
    ambient: '#ff8a3d',
    ambientOpacity: 0.12,
    glow: 0.75,
  },
  day: {
    bg: '#1d2127',
    floorA: '#8a6446',
    floorB: '#7f5b3f',
    floorLine: 'rgba(0,0,0,0.18)',
    wallLeft: '#4a4e56',
    wallRight: '#41454c',
    wallTop: '#575c65',
    window: '#9cc9ef',
    glass: 'rgba(200,230,255,0.16)',
    glassEdge: 'rgba(230,245,255,0.6)',
    woodTop: '#5a4030',
    woodLeft: '#443023',
    woodRight: '#38271c',
    ambient: '#ffffff',
    ambientOpacity: 0,
    glow: 0.45,
  },
}
