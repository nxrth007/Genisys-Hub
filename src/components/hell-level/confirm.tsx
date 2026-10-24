'use client'

import { useEffect, useState } from 'react'
import { Button, Modal } from './ui'

/**
 * "Are you sure?" inside the page. window.confirm is silently blocked in
 * some browsers (the Claude app's own browser among them), which left
 * buttons like Release number doing nothing. ConfirmHost sits in the
 * Hell-level shell; confirmAction asks through it.
 */

type Ask = { message: string; label: string; danger: boolean; resolve: (ok: boolean) => void }

let open: ((a: Ask) => void) | null = null

/** Resolves true when they confirm. The message's first question becomes the title, the rest the detail. */
export function confirmAction(message: string, label = 'Yes', o: { danger?: boolean } = {}): Promise<boolean> {
  return new Promise((resolve) => {
    if (!open) return resolve(window.confirm(message))
    open({ message, label, danger: o.danger ?? true, resolve })
  })
}

export function ConfirmHost() {
  const [ask, setAsk] = useState<Ask | null>(null)
  useEffect(() => {
    open = setAsk
    return () => {
      if (open === setAsk) open = null
    }
  }, [])
  if (!ask) return null
  const done = (ok: boolean) => {
    ask.resolve(ok)
    setAsk(null)
  }
  const q = ask.message.indexOf('?')
  const title = q > 0 ? ask.message.slice(0, q + 1) : ask.message
  const detail = q > 0 ? ask.message.slice(q + 1).trim() : ''
  return (
    <Modal
      open
      onClose={() => done(false)}
      title={title}
      footer={
        <>
          <Button onClick={() => done(false)}>Cancel</Button>
          <Button variant={ask.danger ? 'danger' : 'primary'} onClick={() => done(true)} autoFocus>
            {ask.label}
          </Button>
        </>
      }
    >
      {detail ? <p className="whitespace-pre-wrap text-[13.5px] text-muted-foreground">{detail}</p> : <span />}
    </Modal>
  )
}
