import { APP_METADATA, APP_VIEWPORT } from '@/components/genisys-os/app-meta'
import { PhoneAppWorker } from '@/components/genisys-os/phone-app'

/**
 * /login and /login/password are where a contractor first opens Genisys OS on their phone (the link in
 * their invite text), so they already carry the app: "Add to Home Screen" from here makes the same
 * full-screen Genisys OS app as from inside it (src/components/genisys-os/app-meta.ts).
 */
export const metadata = APP_METADATA
export const viewport = APP_VIEWPORT

export default function LoginLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      {children}
      <PhoneAppWorker />
    </>
  )
}
