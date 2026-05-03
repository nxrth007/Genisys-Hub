-- Store the Slack permalink for every delivered message.
--
-- The post path now does a chat.getPermalink immediately after
-- chat.postMessage to verify the message is actually visible in
-- the channel. If the lookup fails, we mark the delivery as
-- 'failed' instead of leaving a phantom 'delivered' row that
-- looks fine on /master-tracker but doesn't correspond to a real
-- Slack message.
--
-- The permalink itself is also handy in the UI — admins can click
-- "View in Slack" to jump straight to the post and visually verify
-- it landed in the right channel. Without this, the only way to
-- know a delivery row is real is to scroll the channel manually.
ALTER TABLE "SheetSlackDelivery"
    ADD COLUMN IF NOT EXISTS "permalink" TEXT;
