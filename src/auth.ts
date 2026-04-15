/**
 * Auth.js (NextAuth v5) configuration.
 *
 * Strategy:
 * - Google OAuth provider for team SSO.
 * - Domain allowlist — only @leadgenisys.com (plus @trustware.io for Ethan)
 *   can sign in. Configured via AUTH_ALLOWED_DOMAINS env.
 * - Prisma adapter so Users + Accounts + Sessions live in Postgres.
 * - First signup is auto-promoted to "admin" so Alex can set up the workspace.
 */
import NextAuth, { type DefaultSession } from 'next-auth'
import Google from 'next-auth/providers/google'
import { PrismaAdapter } from '@auth/prisma-adapter'
import { prisma } from '@/lib/prisma'

declare module 'next-auth' {
  interface Session {
    user: {
      id: string
      role: string
    } & DefaultSession['user']
  }

  interface User {
    role?: string
  }
}

function allowedDomains(): string[] {
  const raw = process.env.AUTH_ALLOWED_DOMAINS || 'leadgenisys.com'
  return raw
    .split(',')
    .map((d) => d.trim().toLowerCase())
    .filter(Boolean)
}

export const { handlers, auth, signIn, signOut } = NextAuth({
  adapter: PrismaAdapter(prisma) as never,
  session: { strategy: 'database' },
  providers: [
    Google({
      clientId: process.env.AUTH_GOOGLE_ID,
      clientSecret: process.env.AUTH_GOOGLE_SECRET,
      // These are the base scopes needed for SSO.
      // Gmail/Calendar scopes are requested separately per-account when the
      // user connects those integrations, so we don't force them at login.
      authorization: {
        params: {
          scope: 'openid email profile',
          prompt: 'select_account',
        },
      },
    }),
  ],
  callbacks: {
    async signIn({ user }) {
      const email = user.email?.toLowerCase()
      if (!email) return false
      const domain = email.split('@')[1]
      if (!domain || !allowedDomains().includes(domain)) {
        console.warn(`[auth] rejected sign-in for ${email} (domain not allowed)`)
        return false
      }
      return true
    },
    async session({ session, user }) {
      if (session.user) {
        session.user.id = user.id
        session.user.role = (user as { role?: string }).role || 'member'
      }
      return session
    },
  },
  events: {
    async createUser({ user }) {
      // Promote the first user to admin automatically — this is the workspace
      // founder (Alex). Subsequent users default to "member".
      const count = await prisma.user.count()
      if (count === 1 && user.id) {
        await prisma.user.update({
          where: { id: user.id },
          data: { role: 'admin' },
        })
      }
    },
  },
  pages: {
    signIn: '/signin',
  },
})
