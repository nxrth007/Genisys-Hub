'use client'

import { use } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Loader2 } from 'lucide-react'
import { CallbackForm, type CallbackFormValues } from '@/components/agent/callback-form'

type Callback = {
  id: string
  customerName: string
  customerPhone: string
  callbackAt: string
  notes: string | null
}

/** Convert an ISO UTC string to the local "datetime-local" input format. */
function toLocalInput(iso: string): string {
  const d = new Date(iso)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(
    d.getHours()
  )}:${pad(d.getMinutes())}`
}

export default function EditCallbackPage(props: {
  params: Promise<{ id: string }>
}) {
  const { id } = use(props.params)
  const query = useQuery<{ callback: Callback }>({
    queryKey: ['agent-callback', id],
    queryFn: async () => {
      const res = await fetch(`/api/agent/callbacks/${id}`)
      if (!res.ok) throw new Error('Failed to load callback')
      return res.json()
    },
  })

  if (query.isLoading) {
    return (
      <div className="flex items-center justify-center py-16">
        <Loader2 className="h-6 w-6 animate-spin text-purple-600" />
      </div>
    )
  }

  if (query.isError || !query.data) {
    return (
      <div className="mx-auto max-w-2xl rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-200">
        Couldn&apos;t load this callback. It may have been deleted.
      </div>
    )
  }

  const c = query.data.callback
  const initial: Partial<CallbackFormValues> = {
    customerName: c.customerName,
    customerPhone: c.customerPhone,
    callbackAt: toLocalInput(c.callbackAt),
    notes: c.notes || '',
  }

  return <CallbackForm mode="edit" callbackId={id} initial={initial} />
}
