'use client'

import { X } from 'lucide-react'
import { Sidebar } from './sidebar'

/**
 * Drawer wrapper that renders the same Sidebar on mobile. Reusing the
 * Sidebar component keeps the nav single-source-of-truth — no duplicated
 * menu arrays.
 */
export function MobileSidebar({ onClose }: { onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-50 md:hidden">
      <div
        className="absolute inset-0 bg-black/50"
        onClick={onClose}
        aria-hidden
      />
      <div className="absolute inset-y-0 left-0 w-72 bg-white shadow-xl dark:bg-zinc-950">
        <button
          onClick={onClose}
          aria-label="Close menu"
          className="absolute right-3 top-3 z-10 rounded-md p-1.5 text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800"
        >
          <X className="h-4 w-4" />
        </button>
        {/* Reuse Sidebar directly; its `md:flex` makes it hidden on mobile
            by default — force show with a wrapper override. */}
        <div className="[&>aside]:flex [&>aside]:w-full h-full">
          <Sidebar />
        </div>
      </div>
    </div>
  )
}
