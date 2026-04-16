import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  // Removed `output: 'standalone'` — it conflicts with `next start` on Render
  // (Next.js 16 warns that standalone requires `node .next/standalone/server.js`
  // instead, which complicates env var passthrough). Standard mode works fine
  // on Render's Node runtime.
  typescript: {
    ignoreBuildErrors: true,
  },
  experimental: {
    serverActions: {
      bodySizeLimit: '2mb',
    },
  },
}

export default nextConfig
