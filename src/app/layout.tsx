import type { Metadata } from 'next'
import { Geist, Geist_Mono } from 'next/font/google'
import './globals.css'
import { RootShell } from '@/components/layout/root-shell'
import { QueryProvider } from '@/providers/query-provider'

// Geist for reading, Geist Mono for anything instrumented — nav, labels,
// figures, the Home HUD. One family keeps the two feeling like one system.
const geistSans = Geist({
  variable: '--font-geist-sans',
  subsets: ['latin'],
  display: 'swap',
})

const geistMono = Geist_Mono({
  variable: '--font-geist-mono',
  subsets: ['latin'],
  display: 'swap',
})

export const metadata: Metadata = {
  title: 'Genisys Hub',
  description: 'Internal ops dashboard for the GENISYS agency',
}

/**
 * Apply the persisted palette BEFORE React hydrates so the page doesn't
 * flash between palettes on first paint.
 *
 * `.dark` is always on: both palettes are dark, and every `dark:` utility
 * in the codebase must stay the active one. `.graphite` on top of it is
 * the dark-grey palette. The localStorage key keeps its old values
 * ('dark' = Obsidian, 'light' = Graphite) so nobody's saved choice is
 * lost by the rename.
 */
const THEME_INIT_SCRIPT = `
(function() {
  var root = document.documentElement;
  root.classList.add('dark');
  try {
    if (localStorage.getItem('theme') === 'light') root.classList.add('graphite');
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
      className={`${geistSans.variable} ${geistMono.variable} dark h-full antialiased`}
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
