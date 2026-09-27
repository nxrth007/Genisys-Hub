-- One-time promotion of onboarding intakes that arrived before the
-- webhook started creating Clients itself (src/lib/client-from-intake.ts).
-- Same mapping as the code path: one Client per business name, taking
-- the most recent intake for that name; anything whose name already
-- exists as a Client is linked rather than duplicated.

INSERT INTO "Client" (
  "id", "name", "lifecycle", "package",
  "contactName", "contactEmail", "contactPhone", "address", "website",
  "onboardingNotes", "createdAt", "updatedAt"
)
SELECT
  'cli_' || replace(gen_random_uuid()::text, '-', ''),
  i."businessName",
  'onboarding',
  'custom',
  i."fullName",
  COALESCE(i."leadEmail", CASE WHEN i."businessContact" LIKE '%@%' THEN i."businessContact" END),
  i."customerPhone",
  i."businessAddress",
  i."website",
  concat_ws(E'\n',
    'Onboarded via clientonboarding.leadgenisys.com on ' || to_char(i."receivedAt", 'YYYY-MM-DD'),
    CASE WHEN i."mainServices" IS NOT NULL THEN 'Services: ' || i."mainServices" END,
    CASE WHEN i."cities" IS NOT NULL THEN 'Cities: ' || i."cities" END,
    CASE WHEN i."areaCode" IS NOT NULL THEN 'Area code: ' || i."areaCode" END,
    CASE WHEN i."timeZone" IS NOT NULL THEN 'Time zone: ' || i."timeZone" END,
    CASE
      WHEN i."bringingOwnDomain" ~* '^y(es)?$' THEN 'Domain: ' || COALESCE(i."domainName", '(bringing their own)')
      WHEN i."bringingOwnDomain" IS NOT NULL THEN 'Domain: none — we register one'
    END,
    CASE WHEN i."brandColors" IS NOT NULL THEN 'Brand colours: ' || i."brandColors" END,
    CASE WHEN i."promotions" IS NOT NULL THEN 'Promotions: ' || i."promotions" END,
    CASE WHEN i."socialLinks" IS NOT NULL THEN 'Social: ' || i."socialLinks" END,
    CASE WHEN i."aboutBusiness" IS NOT NULL THEN 'About: ' || i."aboutBusiness" END,
    CASE WHEN i."whyChooseYou" IS NOT NULL THEN 'Why choose them: ' || i."whyChooseYou" END,
    CASE WHEN i."faqs" IS NOT NULL THEN 'FAQs: ' || i."faqs" END
  ),
  i."receivedAt",
  NOW()
FROM "ClientIntake" i
WHERE i."clientId" IS NULL
  AND i."businessName" IS NOT NULL
  AND i."status" <> 'archived'
  AND NOT EXISTS (
    SELECT 1 FROM "Client" c WHERE lower(c."name") = lower(i."businessName")
  )
  AND i."id" = (
    SELECT i2."id" FROM "ClientIntake" i2
    WHERE lower(i2."businessName") = lower(i."businessName")
      AND i2."clientId" IS NULL AND i2."status" <> 'archived'
    ORDER BY i2."receivedAt" DESC
    LIMIT 1
  );

-- Link every unlinked intake to the Client carrying its business name
-- (covers the rows just inserted and any pre-existing name matches).
UPDATE "ClientIntake" i
SET "clientId" = c."id"
FROM "Client" c
WHERE i."clientId" IS NULL
  AND i."businessName" IS NOT NULL
  AND lower(c."name") = lower(i."businessName");
