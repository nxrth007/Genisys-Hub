-- Phase 1 of the PPA bi-weekly invoicing automation.
--
-- Adds three timing fields to Client + a full Invoice table:
--
--   Client.serviceStartDate    — set when onboarding form is
--                                 completed (lifecycle → active).
--                                 Drives the first-invoice math:
--                                 first_invoice_due = startDate + 14d.
--   Client.invoicingCutoffAt   — ignore status updates with
--                                 clientStatusUpdatedAt <= this
--                                 timestamp. Lets us draw a clean
--                                 line at deploy time so the existing
--                                 (already-invoiced) status updates
--                                 don't get re-invoiced by the
--                                 automation.
--   Client.lastInvoicedAt      — most recent invoice fire time.
--                                 next_invoice_due = lastInvoicedAt + 14d.
--                                 Null until the first invoice fires.
--   Invoice                    — full audit row per fired invoice.
--                                 Stores appointment ids as JSON so
--                                 the record survives later edits/
--                                 deletes of the underlying rows.

-- ─── Client columns ──────────────────────────────────────────────
ALTER TABLE "Client"
  ADD COLUMN IF NOT EXISTS "serviceStartDate"  TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "invoicingCutoffAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "lastInvoicedAt"    TIMESTAMP(3);

-- Backfill for existing PPA clients per Alex's instruction
-- ("all of our clients have been invoiced for the current cycle —
-- want this to go into effect for NEW appointments from this point
-- on"). For every PPA client that's currently active:
--   - serviceStartDate ← Client.updatedAt as a best-proxy. Mostly
--     informational since lastInvoicedAt drives the cadence going
--     forward.
--   - invoicingCutoffAt ← NOW() so the cron ignores every status
--     update that already exists at deploy time.
--   - lastInvoicedAt ← NOW() so the first auto-invoice fires
--     ~14 days from deploy. Cycle restarts cleanly here.
UPDATE "Client"
SET
  "serviceStartDate"  = COALESCE("serviceStartDate", "updatedAt"),
  "invoicingCutoffAt" = COALESCE("invoicingCutoffAt", NOW()),
  "lastInvoicedAt"    = COALESCE("lastInvoicedAt", NOW())
WHERE "package" = 'ppa'
  AND "active" = true
  AND "lifecycle" = 'active';

-- ─── Invoice table ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "Invoice" (
  "id"               TEXT          PRIMARY KEY,
  "clientId"         TEXT          NOT NULL,
  "cycleStartAt"     TIMESTAMP(3)  NOT NULL,
  "cycleEndAt"       TIMESTAMP(3)  NOT NULL,
  "appointmentCount" INTEGER       NOT NULL,
  "appointmentIds"   JSONB         NOT NULL,
  "amountCents"      INTEGER       NOT NULL,
  "paymentLink"      TEXT          NOT NULL,
  "emailSentAt"      TIMESTAMP(3),
  "smsSentAt"        TIMESTAMP(3),
  "deliveryError"    TEXT,
  "createdAt"        TIMESTAMP(3)  NOT NULL DEFAULT NOW()
);

-- FK with cascade — deleting a client cascades to its invoice
-- history. Acceptable because clients are very rarely hard-deleted
-- (admin uses active=false instead), and when they ARE deleted the
-- invoice history is irrelevant.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'Invoice_clientId_fkey'
  ) THEN
    ALTER TABLE "Invoice"
      ADD CONSTRAINT "Invoice_clientId_fkey"
      FOREIGN KEY ("clientId") REFERENCES "Client"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END$$;

-- (clientId, cycleEndAt) covers the common admin-side report
-- query ("show me all invoices for this client over the last
-- N months") and the scheduler's last-cycle lookup. cycleEndAt
-- DESC so the newest-first scan is index-only.
CREATE INDEX IF NOT EXISTS "Invoice_clientId_cycleEndAt_idx"
  ON "Invoice" ("clientId", "cycleEndAt" DESC);
