import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  output: 'standalone',
  // Render plays well with standalone output for smaller images + faster boot.
  experimental: {
    serverActions: {
      bodySizeLimit: '2mb',
    },
  },
}

export default nextConfig
