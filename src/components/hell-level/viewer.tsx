'use client'

import { createContext, useContext } from 'react'

/**
 * Who's in Hell-level: Genisys (admin: everything), or a sub-account's own
 * login (a contractor or their staff: their sub-account's day-to-day screens,
 * src/lib/hl/member-access.ts). The shell provides it; pages hide what only
 * Genisys can do (the API refuses it anyway).
 */
export type HlViewer = { admin: boolean; name: string | null; email: string }

export const ViewerContext = createContext<HlViewer>({ admin: false, name: null, email: '' })

export const useHlViewer = () => useContext(ViewerContext)
