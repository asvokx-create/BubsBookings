ALTER TABLE provider_calendly_connections
  ADD COLUMN IF NOT EXISTS webhook_error text;

COMMENT ON COLUMN provider_calendly_connections.last_sync_error IS
  'Most recent appointment import error only. Webhook subscription health is stored separately.';

COMMENT ON COLUMN provider_calendly_connections.webhook_error IS
  'Provider-safe webhook subscription status detail. Never stores credentials or Calendly payloads.';
