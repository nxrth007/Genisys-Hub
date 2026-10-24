'use client'

import { useEffect } from 'react'

/** Tells the page embedding this form how tall it is, so the iframe can fit it (see the embed code on Sites). */
export function FrameHeight({ formId }: { formId: string }) {
  useEffect(() => {
    if (window.parent === window) return
    const post = () => window.parent.postMessage({ hlForm: formId, height: document.documentElement.scrollHeight }, '*')
    post()
    const ro = new ResizeObserver(post)
    ro.observe(document.body)
    return () => ro.disconnect()
  }, [formId])
  return null
}
