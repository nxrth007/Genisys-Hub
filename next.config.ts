import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  // Playwright is launched from the worker only, and it ships native
  // code the bundler must not try to pack.
  serverExternalPackages: ['playwright', 'playwright-core', 'imapflow'],
  // Removed `output: 'standalone'` — it conflicts with `next start` on Render
  // (Next.js 16 warns that standalone requires `node .next/standalone/server.js`
  // instead, which complicates env var passthrough). Standard mode works fine
  // on Render's Node runtime.
  // Hell-level became Genisys OS on 2026-11-16 (/hell-level → /genisys-os): old links, bookmarks and
  // texts already sent still open, query strings and all.
  async redirects() {
    return [
      { source: '/hell-level', destination: '/genisys-os', permanent: false },
      { source: '/hell-level/:path*', destination: '/genisys-os/:path*', permanent: false },
    ]
  },
  typescript: {
    ignoreBuildErrors: true,
  },
  experimental: {
    serverActions: {
      bodySizeLimit: '2mb',
    },
    // Next starts one build worker per CPU to collect page data, each loading
    // the server code. Render's build machine has 48 CPUs, and 47 workers ran
    // past its 8 GB limit (Oct 2026: "out of memory", five failed deploys).
    // Four is plenty.
    cpus: 4,
  },
}

export default nextConfig
