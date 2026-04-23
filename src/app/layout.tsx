import type { Metadata } from 'next'
import { Geist, Geist_Mono } from 'next/font/google'
import './globals.css'
import { RootShell } from '@/components/layout/root-shell'
import { QueryProvider } from '@/providers/query-provider'

const geistSans = Geist({
  variable: '--font-geist-sans',
  subsets: ['latin'],
})

const geistMono = Geist_Mono({
  variable: '--font-geist-mono',
  subsets: ['latin'],
})

export const metadata: Metadata = {
  title: 'Genisys Hub',
  description: 'Internal ops dashboard for the GENISYS agency',
}

/**
 * Apply the persisted (or system-preferred) theme BEFORE React hydrates so
 * the page doesn't flash light-then-dark on first paint. Reads localStorage
 * and prefers-color-scheme synchronously and toggles the `.dark` class on
 * <html> accordingly. The sidebar's ThemeToggle writes to the same key.
 */
const THEME_INIT_SCRIPT = `
(function() {
  try {
    var saved = localStorage.getItem('theme');
    var isDark = saved === 'dark' || (!saved && window.matchMedia('(prefers-color-scheme: dark)').matches);
    if (isDark) document.documentElement.classList.add('dark');
  } catch (_) {}
})();
`

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    <html
      lang="en"
      suppressHydrationWarning
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
      </head>
      <body className="h-full">
        <QueryProvider>
          <RootShell>{children}</RootShell>
        </QueryProvider>
      </body>
    </html>
  )
}
