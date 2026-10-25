import Image from 'next/image'
import Link from 'next/link'

/**
 * The public pages Google's OAuth review reads for Hell Level Calendar (the
 * Google app calendar connections sign in through; src/lib/hl/google-calendar.ts):
 * its home page and its privacy policy, on the Hub's own domain, which is
 * verified in Search Console. Light, plain, readable without a sign-in.
 */

export const APP_NAME = 'Hell Level Calendar'
export const CONTACT_EMAIL = 'ethan@leadgenisys.com'
export const CONTACT_PHONE = '603-502-6226'
export const HOME_PATH = '/hl/google-calendar'
export const PRIVACY_PATH = '/hl/google-calendar/privacy'

export function DocFrame({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-white text-[#344054]" style={{ colorScheme: 'light' }}>
      <style>{'html,body{background:#fff!important;color-scheme:light}'}</style>
      <header className="border-b border-[#EAECF0]">
        <div className="mx-auto flex max-w-3xl items-center gap-3 px-6 py-4">
          <Image src="/genisys-logo.png" alt="Lead Genisys" width={32} height={32} className="h-8 w-8 rounded-md object-contain" />
          <Link href={HOME_PATH} className="text-[15px] font-semibold text-[#101828]">
            {APP_NAME}
          </Link>
          <span className="text-[13px] text-[#667085]">by Lead Genisys</span>
        </div>
      </header>
      <main className="mx-auto max-w-3xl px-6 py-12 text-[15.5px] leading-relaxed [&_h2]:mt-10 [&_h2]:text-[19px] [&_h2]:font-semibold [&_h2]:text-[#101828] [&_li]:mt-1.5 [&_p]:mt-3 [&_ul]:mt-3 [&_ul]:list-disc [&_ul]:pl-5">
        {children}
      </main>
      <footer className="border-t border-[#EAECF0]">
        <div className="mx-auto flex max-w-3xl flex-wrap items-center gap-x-5 gap-y-2 px-6 py-6 text-[13.5px] text-[#667085]">
          <Link href={HOME_PATH} className="hover:text-[#101828]">
            {APP_NAME}
          </Link>
          <Link href={PRIVACY_PATH} className="hover:text-[#101828]">
            Privacy policy
          </Link>
          <a href={`mailto:${CONTACT_EMAIL}`} className="hover:text-[#101828]">
            {CONTACT_EMAIL}
          </a>
          <span className="ml-auto">© 2026 Lead Genisys LLC</span>
        </div>
      </footer>
    </div>
  )
}
