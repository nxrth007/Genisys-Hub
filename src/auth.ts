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
      // Set for role=client_* users only — drives the /client master-
      // tracker filter and the forced password-change redirect.
      clientId?: string | null
      mustChangePassword?: boolean
    } & DefaultSession['user']
  }

  interface User {
    role?: string
    clientId?: string | null
    mustChangePassword?: boolean
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
      name: 'Credentials',
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
          select: {
            id: true,
            email: true,
            name: true,
            role: true,
            passwordHash: true,
            clientId: true,
            mustChangePassword: true,
          },
        })
        if (!user || !user.passwordHash) return null

        const ok = await bcrypt.compare(password, user.passwordHash)
        if (!ok) return null

        // Agents in pending/denied states can't session at all. Clients
        // in pending/onboarding CAN session, because the multi-step
        // signup flow (register → onboarding form → admin approval)
        // needs them logged in to fill out the next screen. Middleware
        // routes them to the right place; they can't reach /client
        // until role flips to client_active. Only client_denied is
        // hard-blocked.
        const allowedRoles = new Set([
          'agent',
          'admin',
          'member',
          'client_active',
          'client_pending',
          'client_onboarding',
          // Mary's Team #1 (and future Team #N) — approved members can
          // session and reach /team/*. Pending/denied are bounced below.
          'team_member',
        ])
        if (!allowedRoles.has(user.role)) {
          if (user.role === 'agent_pending') throw new Error('pending')
          if (user.role === 'agent_denied') throw new Error('denied')
          if (user.role === 'client_denied') throw new Error('client_denied')
          if (user.role === 'team_pending') throw new Error('team_pending')
          if (user.role === 'team_denied') throw new Error('team_denied')
          throw new Error('denied')
        }

        return {
          id: user.id,
          email: user.email,
          name: user.name,
          role: user.role,
          clientId: user.clientId,
          mustChangePassword: user.mustChangePassword,
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
      // On first sign-in, `user` is populated. Copy fields into the token.
      if (user) {
        const u = user as {
          id?: string
          role?: string
          clientId?: string | null
          mustChangePassword?: boolean
        }
        token.id = u.id || token.sub
        token.role = u.role || 'member'
        token.clientId = u.clientId ?? null
        token.mustChangePassword = u.mustChangePassword ?? false
      }
      // On subsequent requests refresh role/clientId from DB so admin
      // approvals, denials, and password-change clears take effect
      // without forcing a sign-out.
      //
      // If the User row is gone (admin manually deleted it via
      // Prisma Studio / SQL), invalidate the session — returning
      // null from this callback drops the JWT cookie. Prevents a
      // deleted User from continuing to access /client (or any
      // gated route) until the natural JWT expiry.
      if (token.id) {
        const fresh = await prisma.user.findUnique({
          where: { id: token.id as string },
          select: {
            role: true,
            clientId: true,
            mustChangePassword: true,
          },
        })
        if (!fresh) {
          // Force re-login. NextAuth treats a null return from jwt
          // as "session is invalid".
          return null
        }
        token.role = fresh.role
        token.clientId = fresh.clientId
        token.mustChangePassword = fresh.mustChangePassword
      }
      return token
    },
    async session({ session, token }) {
      if (session.user) {
        session.user.id = (token.id as string) || session.user.id
        session.user.role = (token.role as string) || 'member'
        session.user.clientId = (token.clientId as string | null) ?? null
        session.user.mustChangePassword =
          (token.mustChangePassword as boolean) ?? false
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
