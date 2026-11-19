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

## Stripe dispute defense

When a client disputes a Stripe charge, the Hub builds an evidence packet and keeps it on the dispute record. The default mode is **dry-run**: the packet is compiled and stored, and Stripe's dispute update endpoint is never called.

Payments → Disputes (Alex and Ethan) lists disputes, the win/loss rate by reason, the packet, the narrative, and pause / submit. Submit stays disabled in dry-run and in stage. Only live mode can set `submit=true`.

The packet leads with the **service delivery timeline** from the Sites "Report for the client" checklist: website live (with an HTTP status), domain, toll-free number, texting approval, call routing, Genisys OS form and chat, lead automations, Google review requests, and a complete business profile. Sending that report is logged with an open pixel, a snapshot of the email (the set-password link is stripped), and a dashboard-login invite that does not store the password. Later dashboard sign-ins are logged the same way. Leads and appointments are included after the timeline, as support.

### Webhook

The endpoint already exists. In Stripe → Developers → Webhooks, open the endpoint that posts to:

`https://genisys-hub.onrender.com/api/webhooks/stripe`

Add these events (the signup events already on it can stay):

- `charge.dispute.created`
- `charge.dispute.updated`
- `charge.dispute.closed`
- `charge.dispute.funds_withdrawn`
- `charge.dispute.funds_reinstated`
- `radar.early_fraud_warning.created`
- `radar.early_fraud_warning.updated`
- `invoice.paid`

The signing secret is the Vault entry **Stripe Official Webhook Secret**. The key the defense calls Stripe with is **Stripe Official Restricted**. **Stripe API Key** is the old dead account and is not read.

### Restricted key permissions

Read (the Disputes tab can probe these): Disputes, Charges, PaymentIntents, Customers, Invoices, Checkout Sessions, Files, Radar early fraud warnings, Webhook endpoints.

Write, which a read-only probe cannot check: Disputes, Files (purpose `dispute_evidence`), Customers, Charges, and PaymentIntents (the last three stamp `hub_client_id` and `hub_intake_id` on future charges). Refunds write is only needed if early-fraud auto-refund is turned on. It ships off. The Hub does not create the webhook endpoint, so Webhook endpoints write is not required.

### Going live

Environment, or the switches on Payments → Disputes (a saved setting overrides the env, except the kill switch):

| Variable | Default | Meaning |
| --- | --- | --- |
| `DISPUTE_DEFENSE_MODE` | `dry_run` | `dry_run` builds only and does not write to Stripe (no metadata stamps, no file upload, no dispute update). `stage` saves evidence with `submit=false`. `live` also auto-submits inside the lead window. A manual Submit is refused unless the mode is live. |
| `DISPUTE_SUBMIT_LEAD_HOURS` | `48` | How long before `due_by` live mode submits. |
| `DISPUTE_DEFENSE_FORCE_DRY_RUN` | off | Set to `1` to force dry-run no matter what was saved. |
| `DISPUTE_EFW_REFUND` | off | Refund an actionable early-fraud warning. Only runs in live mode. |
| `DISPUTE_ALERT_SMS` | on | Text Alex and Ethan for a live dispute. Slack uses the existing hub alert channel. |
| `DISPUTE_CLIENT_NOTICES` | off | Email a client when onboarding is stored. |
| `DISPUTE_OPEN_TRACKING` | on | Add an open pixel to invoices and reports the Hub sends. |
| `DISPUTE_MILESTONE_ACK` | off | Include a one-click "confirm service started" link. The link opens a page; the button confirms, so a mail scanner does not. |
| `DISPUTE_STAMP_METADATA` | on | Write `hub_client_id` / `hub_intake_id` onto the Stripe customer and charge. |
| `DISPUTE_INQUIRY_POLICY` | `flag` | `flag` compiles an inquiry and does not auto-submit it, so someone can refund. `fight` treats `warning_needs_response` like a chargeback. |
| `DISPUTE_DEFENSE_CRON` | off outside production | Set to `1` to reconcile disputes from a non-production process. |

Auto-submit does not run when a dispute is paused, when an admin edited the narrative, when the client match is weak or missing, after `due_by`, or for an inquiry while `DISPUTE_INQUIRY_POLICY` is `flag` (the default). A weak match (a business name, a person name, or metadata whose email does not belong to that client) is compiled locally and not uploaded. Rebuilding or linking a client does not submit. Submitting evidence is final, and Stripe's default for `submit` is true, so the Hub refuses a dispute update that does not set the flag explicitly. `has_evidence` means the evidence was staged, not submitted.

The narrative follows the card network reason code when Stripe sends one (Visa 10.4, 13.1, 13.2, 13.3, 13.7, and the Mastercard and American Express codes in the dispute plan), and otherwise the Stripe reason. Not-received and not-as-described packets lead with the setup timeline. Fraud packets lead with the purchase IP. Visa Compelling Evidence 3.0 is added only for Visa 10.4 when two older undisputed charges on the same card share the same qualifying pair with this charge: purchase IP and device id, or one of those plus the email.

### What to set in the Stripe Dashboard (not code)

- Statement descriptor: something the client recognizes, such as `LEAD GENISYS`, not a processor name.
- Radar: keep the default block-lists, and review early fraud warnings. The Hub records them; it does not refund unless `DISPUTE_EFW_REFUND` is on.
- Turn on Stripe's dispute prevention tools that fit the account: Visa Rapid Dispute Resolution and Mastercard dispute alerts, if Stripe offers them on this account.
- Receipt emails: Stripe can email a receipt for every successful charge. That is independent of the Hub's invoice emails.
- Customer portal: if it is on, clients can cancel there, which is the cancellation path the packet describes.

### What the onboarding form must send

The form lives in `nxrth007/genisysclientonboarding`. The Hub reads two blocks on the intake JSON (the same body already posted to the onboarding webhook). It also reads the same values from Stripe charge metadata when the Checkout Session copies them onto the charge. Dry-run stores them and does not write them back to Stripe.

#### Checkout purchase (`purchase`, and Stripe metadata)

Put this on the intake body. Also set the same three keys on the Checkout Session metadata that Stripe copies onto the Charge (`payment_intent_data.metadata` for a one-time charge, `subscription_data.metadata` for the subscription). Stripe metadata values are limited to 500 characters, so the full user agent belongs on the intake; the metadata copy can be the first 500 characters.

| Name | Where | Meaning |
| --- | --- | --- |
| `purchase.ip` | intake JSON | Customer IP at checkout. Also accepted as `hub_purchase_ip`. |
| `purchase.userAgent` | intake JSON | Browser user agent. Also accepted as `hub_purchase_ua`. |
| `purchase.deviceId` | intake JSON | Optional device id, 15 to 200 letters, digits, or `. _ : + / = -`. Shorter or other values are ignored. Also accepted as `hub_device_id`. |
| `hub_purchase_ip` | Stripe charge metadata | Same IP. This is what `customer_purchase_ip` and Visa CE 3.0 use for that charge. |
| `hub_purchase_ua` | Stripe charge metadata | User agent, truncated to 500 characters. |
| `hub_device_id` | Stripe charge metadata | Same device id. |

```json
{
  "purchase": {
    "ip": "203.0.113.10",
    "userAgent": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)",
    "deviceId": "A1B2C3D4E5F60718"
  }
}
```

Stripe metadata on the charge:

```text
hub_purchase_ip=203.0.113.10
hub_purchase_ua=Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)
hub_device_id=A1B2C3D4E5F60718
```

A missing IP is left blank. The Hub does not invent one from a later login or from a different charge. Private, loopback, and malformed addresses are dropped. An IP, user agent, and device id are taken from one source together, not mixed.

#### Clickwrap (`acceptance`)

Each policy is its own object. `accepted` must be boolean `true` (or the strings `true` or `yes`). Anything else is not an acceptance. `ip` and `userAgent` on the object win; the same fields at the top of the body fill anything left blank.

| Field | Required | Meaning |
| --- | --- | --- |
| `accepted` | yes | `true` |
| `version` | yes | Version the client was shown. A short token (letters, digits, `.`, `_`, `-`, up to 64 characters) is stored as sent. Anything else is collapsed to one 64-character line. Omitted versions use `2026-11-19`. |
| `at` | no | ISO-8601 time they accepted. `acceptedAt` is also accepted. Defaults to when the Hub received the intake. |
| `ip` | no | IP at acceptance. |
| `userAgent` | no | User agent at acceptance. |
| `textHash` | no | Lowercase SHA-256 hex (64 characters) of the exact text shown. Other shapes are ignored. |
| `textUrl` | no | Public `http` or `https` URL of that text. Credentials, localhost, and private addresses are ignored. |

Keys: `terms`, `refundPolicy`, `cancellationPolicy`, `recurringBilling`. Snake-case aliases `refund_policy`, `cancellation_policy`, and `recurring_billing` are also accepted.

The Hub maps them as follows. Policy prose is sent only in the disclosure text fields. `customer_signature` is a PDF file of the clickwrap (version, time, IP, user agent, text hash, text URL), uploaded only when defense mode is stage or live.

The prose is the summary in `src/lib/disputes/policies.ts` for the edition whose SHA-256 equals `textHash`. The intake version, text hash, and text URL are cited whenever they were stored. A missing or different hash is not filled in with another policy's words. Those summaries follow the onboarding pages: $0 today, a 30-day free trial, then $297/month; cancel within 30 days and pay nothing; after the trial, 30 days written notice to ethan@leadgenisys.com. The pages still marked DRAFT stay in that module so a later final version can be added beside them.

| Acceptance key | Stripe evidence |
| --- | --- |
| `terms` | `customer_signature` file (the clickwrap PDF) and the access-activity line |
| `refundPolicy` | `refund_policy_disclosure` |
| `cancellationPolicy` | `cancellation_policy_disclosure`, and `cancellation_rebuttal` on a cancellation dispute |
| `recurringBilling` | included in `uncategorized_text` |

```json
{
  "ip": "203.0.113.10",
  "userAgent": "Mozilla/5.0",
  "purchase": {
    "ip": "203.0.113.10",
    "userAgent": "Mozilla/5.0",
    "deviceId": "A1B2C3D4E5F60718"
  },
  "acceptance": {
    "terms": {
      "accepted": true,
      "version": "2026-11-19",
      "at": "2026-11-19T18:04:00.000Z",
      "ip": "203.0.113.10",
      "userAgent": "Mozilla/5.0",
      "textHash": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "textUrl": "https://leadgenisys.com/terms"
    },
    "refundPolicy": {
      "accepted": true,
      "version": "2026-11-19",
      "at": "2026-11-19T18:04:00.000Z",
      "textHash": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      "textUrl": "https://leadgenisys.com/refunds"
    },
    "cancellationPolicy": {
      "accepted": true,
      "version": "2026-11-19",
      "at": "2026-11-19T18:04:00.000Z",
      "textHash": "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
      "textUrl": "https://leadgenisys.com/cancellation"
    },
    "recurringBilling": {
      "accepted": true,
      "version": "2026-11-19",
      "at": "2026-11-19T18:04:00.000Z",
      "textHash": "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
      "textUrl": "https://leadgenisys.com/billing"
    }
  }
}
```

Until those are sent, the packet says the clickwrap is not on file and relies on the setup timeline.

### Safe test

Use Stripe test mode and a test-mode restricted key in the Vault, or leave the mode on dry-run. Post a signed fixture to `/api/webhooks/stripe` (see `tests/disputes.test.mjs`). Do not point a test at a live dispute. `npm test` never calls Stripe.

## Security notes

- `VAULT_MASTER_KEY` is the master key for the encrypted vault. **Back it up separately.** If the Render env var is lost or rotated, all existing vault entries become unreadable.
- `.env.local` is gitignored. Never commit real credentials. Paste them into Render's dashboard instead.
- Vault access is logged — every reveal/edit/delete action writes to `VaultAccessLog`.

## Related projects

- **Pf Hub** (Peakfinity's internal tool) — the design reference for this project. Located at `C:\Users\Alexx\Desktop\Pf HUB\pf-hub\`. Do not modify.
