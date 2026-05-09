-- Add an optional manual override for the cap-fulfillment due date.
-- Null = use the computed default per package (PPA 14d, Growth 21d,
-- Pro 28d, Custom = no default), set via the edit form's date picker
-- when a contract's turnaround diverges from the package default.
ALTER TABLE "Client" ADD COLUMN "dueDate" TIMESTAMP(3);
