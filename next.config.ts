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
    // Next starts one build worker per CPU to collect page data, each loading
    // the server code. Render's build machine has 48 CPUs, and 47 workers ran
    // past its 8 GB limit (Oct 2026: "out of memory", five failed deploys).
    // Four is plenty.
    cpus: 4,
  },
}

export default nextConfig
