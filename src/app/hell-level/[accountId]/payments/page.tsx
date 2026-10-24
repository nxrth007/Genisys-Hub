'use client'

import { Suspense } from 'react'
import { useParams } from 'next/navigation'
import { NotYet, RecordsTable, money, rv, useSectionTab, type RecordColumn } from '@/components/hell-level/section'
import { Badge, Spinner, fmtDateTime } from '@/components/hell-level/ui'

const status = (r: Parameters<RecordColumn['render']>[0]) => {
  const v = rv(r, 'status').toLowerCase()
  return v ? <Badge color={/paid|succeeded|active|completed/.test(v) ? 'green' : /void|fail|cancel|refund/.test(v) ? 'red' : 'amber'}>{v}</Badge> : '—'
}
const contact = (r: Parameters<RecordColumn['render']>[0]) => rv(r, 'contactDetails.name', 'contactName', 'contactSnapshot.name', 'customer.name') || '—'
const date = (...keys: string[]) => (r: Parameters<RecordColumn['render']>[0]) => {
  const v = rv(r, ...keys)
  return v ? fmtDateTime(v) : '—'
}

const LISTS: Record<string, { kind: string; title: string; columns: RecordColumn[] }> = {
  invoices: {
    kind: 'invoice',
    title: 'Invoices & Estimates',
    columns: [
      { label: 'Invoice', render: (r) => <span className="font-medium text-foreground">{rv(r, 'invoiceNumber') ? `#${rv(r, 'invoiceNumber')} · ` : ''}{r.name}</span> },
      { label: 'Contact', render: contact },
      { label: 'Status', render: status },
      { label: 'Total', render: (r) => money(r.data.total ?? r.data.amount, rv(r, 'currency')) },
      { label: 'Due', render: date('dueDate') },
    ],
  },
  orders: {
    kind: 'order',
    title: 'Orders',
    columns: [
      { label: 'Contact', render: (r) => <span className="font-medium text-foreground">{contact(r)}</span> },
      { label: 'Status', render: status },
      { label: 'Amount', render: (r) => money(r.data.amount, rv(r, 'currency')) },
      { label: 'Placed', render: date('createdAt') },
    ],
  },
  subscriptions: {
    kind: 'subscription',
    title: 'Subscriptions',
    columns: [
      { label: 'Contact', render: (r) => <span className="font-medium text-foreground">{contact(r)}</span> },
      { label: 'Status', render: status },
      { label: 'Amount', render: (r) => money(r.data.amount, rv(r, 'currency')) },
      { label: 'Started', render: date('createdAt', 'subscriptionSnapshot.startDate') },
    ],
  },
  transactions: {
    kind: 'transaction',
    title: 'Transactions',
    columns: [
      { label: 'Contact', render: (r) => <span className="font-medium text-foreground">{contact(r)}</span> },
      { label: 'Status', render: status },
      { label: 'Amount', render: (r) => money(r.data.amount, rv(r, 'currency')) },
      { label: 'Source', render: (r) => rv(r, 'entitySourceName', 'entitySourceType') || '—' },
      { label: 'Date', render: date('createdAt') },
    ],
  },
  products: {
    kind: 'product',
    title: 'Products',
    columns: [
      { label: 'Product', render: (r) => <span className="font-medium text-foreground">{r.name}</span> },
      { label: 'Type', render: (r) => <span className="eyebrow text-muted-foreground">{rv(r, 'productType') || '—'}</span> },
      { label: 'Description', render: (r) => <span className="line-clamp-1 max-w-md text-muted-foreground">{rv(r, 'description')}</span> },
    ],
  },
  coupons: {
    kind: 'coupon',
    title: 'Coupons',
    columns: [
      { label: 'Coupon', render: (r) => <span className="font-medium text-foreground">{r.name}</span> },
      { label: 'Code', render: (r) => <span className="font-mono text-[12px]">{rv(r, 'code')}</span> },
      { label: 'Discount', render: (r) => (rv(r, 'discountType') === 'percentage' ? `${rv(r, 'discountValue')}%` : money(r.data.discountValue)) },
      { label: 'Status', render: status },
    ],
  },
}

const NOT_YET: Record<string, { title: string; what: string }> = {
  documents: { title: 'Documents & Contracts', what: 'Proposals and contracts the business’s customers sign online.' },
  'payment-links': { title: 'Payment Links', what: 'Links that take a payment for a product. Genisys bills its own clients through Whop (Hub → Payments).' },
  settings: { title: 'Payments Settings', what: 'Invoice numbering, tax, business details on invoices.' },
  integrations: { title: 'Integrations', what: 'The payment processor (Stripe, etc.) behind invoices and orders.' },
}

export default function PaymentsPage() {
  return (
    <Suspense fallback={<div className="flex justify-center py-24"><Spinner /></div>}>
      <Payments />
    </Suspense>
  )
}

function Payments() {
  const { accountId } = useParams<{ accountId: string }>()
  const tab = useSectionTab('payments')
  const list = LISTS[tab]
  if (list) return <RecordsTable key={tab} accountId={accountId} kind={list.kind} title={list.title} columns={list.columns} emptyText={`${list.title} from GoHighLevel show up here after the import (when its key is allowed to read payments).`} />
  const n = NOT_YET[tab]
  return <NotYet title={n?.title ?? 'Payments'} what={n?.what ?? 'Not in Hell-level yet.'} />
}
