// Re-export handlers so the catch-all route keeps a minimal footprint.
import { handlers } from '@/auth'

export const { GET, POST } = handlers
