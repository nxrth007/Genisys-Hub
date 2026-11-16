'use client'

import { useEffect } from 'react'

/**
 * Tells the page embedding this form or booking page how tall it is, so the
 * iframe can fit it (see the embed codes). It measures the page's own
 * container (data-hl-frame), not <body>: the root layout pins <body> to the
 * window's height, so content that grows later (a booking page's times
 * arriving) never resized it and phones cut the bottom off.
 */
export function FrameHeight({ formId }: { formId: string }) {
  useEffect(() => {
    if (window.parent === window) return
    const root = document.querySelector<HTMLElement>('[data-hl-frame]') ?? (document.body.firstElementChild as HTMLElement | null) ?? document.body
    let last = 0
    const post = () => {
      const height = Math.ceil(root.getBoundingClientRect().height)
      if (height === last) return
      last = height
      window.parent.postMessage({ hlForm: formId, height }, '*')
    }
    post()
    const ro = new ResizeObserver(post)
    ro.observe(root)
    return () => ro.disconnect()
  }, [formId])
  return null
}
