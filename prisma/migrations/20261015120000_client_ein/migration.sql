-- EIN as recorded by the team, and its status (on_file | none | pending).
ALTER TABLE "Client" ADD COLUMN "ein" TEXT;
ALTER TABLE "Client" ADD COLUMN "einStatus" TEXT;
