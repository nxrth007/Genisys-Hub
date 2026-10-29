# Client Tracker (DB-backed)

This copies the Google Sheet "Client Onboarding Tracker" into Postgres (`ClientTracker`, one row per `Client`).

## Columns
| Sheet header | DB field | Values |
|---|---|---|
| Client Name | clientName | text |
| Business | business | text |
| Contact Email | contactEmail | text |
| Start Date | startDate | text (as in the sheet) |
| Sign-Up Link Completed | signupStatus | pending / done |
| Intake Form Completed | intakeStatus | pending / done |
| Automations Configuration | automationsStatus | pending / done |
| A2P Submitted | a2pStatus | pending / done |
| Toll-Free Submitted | tollFreeStatus | pending / done |

The sheet uses ✅ for done and ❌ or blank for pending. Any other cell text is kept in `extra`. Each status change is logged as a `ClientJourneyEvent` with stage `tracker.<step>`.

## Surfaces
- `/tracker`: staff page with filter, search, click-to-toggle status, sync preview/apply, and copy status link.
- `GET/POST /api/tracker`, `POST /api/tracker/sync` (`{"apply":true}` to write; dry run otherwise), `GET/POST/DELETE /api/tracker/[clientId]/link`. All are staff only.
- `GET/PATCH /api/external/v1/tracker`: bearer token. PATCH needs the owner. Body: `{clientId, step, status}`.
- `/status/<token>`: public, read-only page (noindex). Tokens are HMAC-signed with a per-client nonce. Rotate or DELETE the link to revoke it. Links are only copied by staff. Nothing is sent to clients automatically.

## Env flags
- `TRACKER_SHEET_SYNC=1` turns on a read-only sheet→DB pass every 15 minutes. Off by default.
- `TRACKER_LINK_SECRET` (min 16 chars) is optional. If not set, `AUTH_SECRET` or `NEXTAUTH_SECRET` is used. Changing it invalidates all status links.

## Backfill
1. Open `/tracker` and click **Preview sync**, or `POST /api/tracker/sync` with `{}`. This reports matched, unmatched, ambiguous and duplicate rows and changes nothing.
2. Click **Apply**, or send `{"apply":true}`. Statuses only move forward, and only blank identity fields get filled. Unmatched rows never create clients.
It is safe to re-run.

## Rollback
Revert the PR. If the migration was applied, run `DROP TABLE "ClientTracker";`. The table is additive and nothing else depends on it.
