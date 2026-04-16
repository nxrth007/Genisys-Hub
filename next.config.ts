import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  output: 'standalone',
  // Skip TypeScript checking during `next build` — we already run `tsc --noEmit`
  // locally before every push. This saves ~2GB of RAM on Render's build machine
  // (the TS checker is the phase that OOMs, not the compilation itself).
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
