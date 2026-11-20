-- Private, owner-chosen preferences for a future call-booking integration.
-- Deliberately separate from public availability previews and live services.
-- No activation column or booking/payment link: saving cannot enable calls.
CREATE TABLE IF NOT EXISTS service_calendly_call_drafts (
  service_id uuid PRIMARY KEY REFERENCES services(id) ON DELETE CASCADE,
  connection_id uuid NOT NULL REFERENCES provider_calendly_connections(id) ON DELETE CASCADE,
  calendly_user_uri text NOT NULL,
  connection_connected_at timestamptz NOT NULL,
  event_type_uri text NOT NULL CHECK (event_type_uri ~ '^https://api[.]calendly[.]com/event_types/[A-Za-z0-9_-]+$'),
  event_type_name text NOT NULL,
  duration_minutes integer NOT NULL CHECK (duration_minutes BETWEEN 1 AND 1440),
  billing_mode text NOT NULL CHECK (billing_mode IN ('free','paid')),
  service_price_cents integer NOT NULL,
  currency text NOT NULL DEFAULT 'usd' CHECK (currency = 'usd'),
  calendly_payment_verified_at timestamptz NOT NULL,
  revision uuid NOT NULL DEFAULT gen_random_uuid(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((billing_mode='free' AND service_price_cents=0)
    OR (billing_mode='paid' AND service_price_cents BETWEEN 50 AND 100000000))
);
COMMENT ON TABLE service_calendly_call_drafts IS
  'Private free/paid call setup only. No live service price change, public offer, booking, checkout, cancellation or Calendly configuration change. Must reverify before future activation.';
