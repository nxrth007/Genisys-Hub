-- Archived clients fold into their own section on /clients and drop out
-- of every picker. Null = on the roster.
ALTER TABLE "Client" ADD COLUMN "archivedAt" TIMESTAMP(3);
