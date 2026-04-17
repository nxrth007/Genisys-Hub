/**
 * Auth.js (NextAuth v5) configuration.
 *
 * Two providers:
 * - Google OAuth: team SSO for staff (alex, ethan@leadgenisys.com).
 *   Domain-allowlisted in the signIn callback.
 * - Credentials: email/password for offshore call-center agents. Agents
 *   register via /signin/agent/register, which creates a User row with
 *   role="agent_pending" and a bcrypt passwordHash. Alex approves them
 *   from /admin/agents, flipping the role to "agent". Only agents with
 *   role="agent" can actually sign in via Credentials — pending/denied
 *   are bounced.
 *
 * Session strategy is 'jwt' because NextAuth's Credentials provider
 * cannot use the database session strategy. The JWT token embeds id +
 * role; the jwt callback refreshes role from the DB on every request
 * so approvals take effect without requiring the agent to re-login.
 *
 * First signup is auto-promoted to "admin" so Alex can set up the workspace.
 */
import NextAuth, { type DefaultSession } from 'next-auth'
import Google from 'next-auth/providers/google'
import Credentials from 'next-auth/providers/credentials'
import { PrismaAdapter } from '@auth/prisma-adapter'
import bcrypt from 'bcryptjs'
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
  // JWT required for Credentials provider. Session data is in a signed
  // cookie, not the Session table. Role is refreshed from DB on every
  // request via the jwt callback (see below).
  session: { strategy: 'jwt' },
  providers: [
    Google({
      clientId: process.env.AUTH_GOOGLE_ID,
      clientSecret: process.env.AUTH_GOOGLE_SECRET,
      authorization: {
        params: {
          scope: 'openid email profile',
          prompt: 'select_account',
        },
      },
    }),
    Credentials({
      name: 'Agent',
      credentials: {
        email: { label: 'Email', type: 'email' },
        password: { label: 'Password', type: 'password' },
      },
      async authorize(creds) {
        const email = typeof creds?.email === 'string' ? creds.email.toLowerCase().trim() : ''
        const password = typeof creds?.password === 'string' ? creds.password : ''
        if (!email || !password) return null

        const user = await prisma.user.findUnique({
          where: { email },
          select: { id: true, email: true, name: true, role: true, passwordHash: true },
        })
        if (!user || !user.passwordHash) return null

        const ok = await bcrypt.compare(password, user.passwordHash)
        if (!ok) return null

        // Block pending/denied agents from getting a session at all — they
        // see a distinct "pending approval" screen after registering.
        if (user.role !== 'agent' && user.role !== 'admin' && user.role !== 'member') {
          // Signal with a specific error code the signin page can surface.
          throw new Error(user.role === 'agent_pending' ? 'pending' : 'denied')
        }

        return {
          id: user.id,
          email: user.email,
          name: user.name,
          role: user.role,
        }
      },
    }),
  ],
  callbacks: {
    async signIn({ user, account }) {
      // Google sign-in: enforce domain allowlist so randos can't SSO in.
      if (account?.provider === 'google') {
        const email = user.email?.toLowerCase()
        if (!email) return false
        const domain = email.split('@')[1]
        if (!domain || !allowedDomains().includes(domain)) {
          console.warn(`[auth] rejected Google sign-in for ${email} (domain not allowed)`)
          return false
        }
      }
      // Credentials: authorize() already validated the user has access.
      return true
    },
    async jwt({ token, user }) {
      // On first sign-in, `user` is populated. Copy id + role into the token.
      if (user) {
        token.id = (user as { id?: string }).id || token.sub
        token.role = (user as { role?: string }).role || 'member'
      }
      // On subsequent requests refresh role from DB so approval/denial takes
      // effect without forcing a sign-out.
      if (token.id) {
        const fresh = await prisma.user.findUnique({
          where: { id: token.id as string },
          select: { role: true },
        })
        if (fresh) token.role = fresh.role
      }
      return token
    },
    async session({ session, token }) {
      if (session.user) {
        session.user.id = (token.id as string) || session.user.id
        session.user.role = (token.role as string) || 'member'
      }
      return session
    },
  },
  events: {
    async createUser({ user }) {
      // Promote the first user to admin — workspace founder (Alex). Subsequent
      // Google signups default to "member"; agents come in as "agent_pending"
      // via our /api/auth/register endpoint which sets the role directly.
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
