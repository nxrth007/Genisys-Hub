# Genisys Hub

Internal ops dashboard for the GENISYS agency. Replaces scattered tools (Gmail tabs, GHL tabs across sub-accounts, Notion, Slack, .txt files of API keys) with a single cloud app the team can log into.

Design-referenced on Pf Hub (Peakfinity's Electron desktop tool) but re-architected as a cloud-hosted web app so:
- The whole team shares one source of truth (not per-laptop SQLite)
- Scheduled SMS reminders and polling run on a server, not someone's laptop
- API keys live in an encrypted vault, not in text files

## Stack

- Next.js 16 (App Router) + React 19 + TypeScript
- Tailwind v4
- Prisma + Postgres
- Auth.js v5 (Google SSO, restricted to `@leadgenisys.com` + `@trustware.io`)
- Twilio for outbound SMS (morning briefs)
- `node-cron` running inside the Next.js server process for scheduled jobs
- XChaCha20-Poly1305 (via `@noble/ciphers`) for vault encryption

## Modules

- `/` — Dashboard
- `/today` — Daily brief: tasks + meetings + check-offs (with morning SMS)
- `/inbox` and `/outbox` — Gmail (alex@, ethan@leadgenisys.com)
- `/crm` — GoHighLevel conversations, grouped by sub-account
- `/calendar` — Google + GHL + Trustware merged view
- `/notion` — Notion databases + tasks board
- `/slack` — Client channel view
- `/vault` — Encrypted API key store
- `/settings`

## Local development

1. Install dependencies:
   ```
   npm install
   ```
2. Copy the env template and fill it in:
   ```
   cp .env.example .env.local
   ```
   At minimum, set `DATABASE_URL`, `AUTH_SECRET`, `VAULT_MASTER_KEY`, `AUTH_GOOGLE_ID`, `AUTH_GOOGLE_SECRET`.
3. Create the database schema:
   ```
   npm run prisma:migrate
   ```
4. Run the dev server:
   ```
   npm run dev
   ```
   Open http://localhost:3000.

### Generating secrets locally

```
# AUTH_SECRET and VAULT_MASTER_KEY — both want 32 random bytes base64 encoded:
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

## Deploy to Render

1. Push to `main` on GitHub.
2. In Render, click **New** → **Blueprint** and select this repo.
3. Render reads `render.yaml`, provisions a web service + Postgres, and deploys.
4. After first deploy, set these env vars in Render (web service → Environment):
   - `AUTH_URL` — e.g. `https://genisys-hub.onrender.com` (or your custom domain)
   - `AUTH_GOOGLE_ID` / `AUTH_GOOGLE_SECRET` — from Google Cloud Console
   - `TWILIO_ACCOUNT_SID` / `TWILIO_AUTH_TOKEN`
   - `ANTHROPIC_API_KEY`
5. Update your Google OAuth client's authorized redirect URI to `${AUTH_URL}/api/auth/callback/google`.

### Custom domain

Point a CNAME `hub.leadgenisys.com` at Render's provided hostname. Then update `AUTH_URL` and the Google OAuth redirect URI accordingly.

## Team access

Only Google accounts ending in `leadgenisys.com` or `trustware.io` can log in (configurable via `AUTH_ALLOWED_DOMAINS`). The first user to log in is auto-assigned `admin` role.

## Security notes

- `VAULT_MASTER_KEY` is the master key for the encrypted vault. **Back it up separately.** If the Render env var is lost or rotated, all existing vault entries become unreadable.
- `.env.local` is gitignored. Never commit real credentials. Paste them into Render's dashboard instead.
- Vault access is logged — every reveal/edit/delete action writes to `VaultAccessLog`.

## Related projects

- **Pf Hub** (Peakfinity's internal tool) — the design reference for this project. Located at `C:\Users\Alexx\Desktop\Pf HUB\pf-hub\`. Do not modify.
