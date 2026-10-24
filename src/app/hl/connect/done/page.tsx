export const dynamic = 'force-dynamic'

type Props = { searchParams: Promise<{ connected?: string; error?: string }> }

export const metadata = { title: 'Google Calendar', robots: { index: false } }

/** Where Google sends a team member back to after connecting from their link. */
export default async function ConnectDonePage({ searchParams }: Props) {
  const { connected, error } = await searchParams
  const ok = connected === '1' && !error
  return (
    <div className="min-h-screen bg-white text-[#344054]" style={{ colorScheme: 'light' }}>
      <style>{'html,body{background:#fff!important;color-scheme:light}'}</style>
      <main className="mx-auto max-w-xl px-6 py-16 text-[15px] leading-relaxed">
        {ok ? (
          <>
            <h1 className="text-[26px] font-semibold text-[#101828]">Your Google Calendar is connected</h1>
            <p className="mt-4">Your bookings will show up in it, and the times you’re busy there can’t be booked. You can close this page.</p>
          </>
        ) : (
          <>
            <h1 className="text-[26px] font-semibold text-[#101828]">That didn’t connect</h1>
            <p className="mt-4">{(error ?? '').slice(0, 300) || 'Google didn’t finish the sign-in.'}</p>
            <p className="mt-3 text-[13.5px] text-[#667085]">Open your connect link and try again, or ask whoever sent it for a new one.</p>
          </>
        )}
      </main>
    </div>
  )
}
