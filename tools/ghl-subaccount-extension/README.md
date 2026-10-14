# Genisys Hub — GHL sub-accounts (Chrome extension)

GHL doesn't allow "create sub-account" by API on the agency's current plan, so this
extension does it from a signed-in GHL tab, the way a person would:

1. Every few minutes it asks the Hub which **new** clients still need a sub-account
   (`GET /api/external/v1/ghl-subaccounts/queue` — same rules as the Hub's own
   automation: only clients from submissions after it went live, never one that
   already has a sub-account).
2. For the first one it opens your GHL tab, goes to Sub-Accounts → Create, fills
   the form with the same name, details and snapshot the Hub would have sent, and —
   in "create" mode — presses Create.
3. It reports back (`POST …/report`). The Hub links the new sub-account to the
   client (by id when it could read it off the page, else by the exact name) and
   posts to #genisys-alerts. A failure shows on the client card with the step that
   went wrong, and the client's **Sub-account** board is the fallback.

It only ever runs one job at a time, and nothing inside the page is retried.

## Install

1. Chrome → `chrome://extensions` → turn on **Developer mode** → **Load unpacked** →
   pick this folder.
2. Click the extension → **Settings**:
   - **Hub API token**: Hub → Settings → API tokens → New token, created while
     signed in as an admin (the queue is owner-only).
   - **GHL URL**: `https://app.gohighlevel.com`, or your white-label address.
   - **Mode**: start with **Fill it in and stop** for the first few clients, then
     switch to **Fill it in and press Create**.
   - Tick **Switched on**, Save, **Test connection**.
3. Keep Chrome open and signed in to GHL's agency view. The extension can't log in
   for you; if GHL asks for a login or 2FA, the job fails and is retried later.

## When GHL changes its page

The content script finds buttons and fields by their visible words (`LABELS` at
the top of `content.js`). If GHL renames one, put the new wording in **Form wording
overrides** in Settings — no reinstall. The run stops at the first thing it can't
find and says which, both on the page and in the Hub's alert.

## What it can't do

- Run with Chrome closed. For that, the agency needs the plan GHL's API requires.
- Get past a login or 2FA prompt.
- Create anything the Hub didn't queue: it never acts on clients already on file.
