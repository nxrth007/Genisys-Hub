-- Two more onboarding intake fields, both optional + long-form:
--   qualificationCriteria — the client's own description of what
--                            makes a good lead (eventually replaces
--                            Mary's manual reference sheet entry).
--   onboardingNotes       — catch-all "anything else admin should
--                            know" at signup time. Distinct from
--                            Client.notes which is admin's internal
--                            notes ABOUT the client.
-- Stored as TEXT so length is unbounded; nullable so existing rows
-- aren't touched.
ALTER TABLE "Client" ADD COLUMN "qualificationCriteria" TEXT;
ALTER TABLE "Client" ADD COLUMN "onboardingNotes" TEXT;
