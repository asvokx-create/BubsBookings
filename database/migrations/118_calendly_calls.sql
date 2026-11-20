-- Additive, gated call booking ledger. No historic financial/event backfill.
CREATE TABLE IF NOT EXISTS calendly_calls (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 request_key uuid NOT NULL,
 customer_id text NOT NULL REFERENCES "user"(id) ON DELETE RESTRICT,
 provider_id uuid NOT NULL REFERENCES provider_profiles(id) ON DELETE RESTRICT,
 provider_user_id text NOT NULL REFERENCES "user"(id) ON DELETE RESTRICT,
 service_id uuid NOT NULL REFERENCES services(id) ON DELETE RESTRICT,
 offer_id uuid NOT NULL, offer_revision uuid NOT NULL,
 connection_id uuid NOT NULL REFERENCES provider_calendly_connections(id) ON DELETE RESTRICT,
 connection_generation text NOT NULL, owner_uri text NOT NULL, event_type_uri text NOT NULL, event_name text NOT NULL,
 location_kind text NOT NULL DEFAULT 'zoom_conference' CHECK(location_kind='zoom_conference'),
 starts_at timestamptz NOT NULL, ends_at timestamptz NOT NULL CHECK(ends_at>starts_at),
 buffer_before_minutes integer NOT NULL DEFAULT 0 CHECK(buffer_before_minutes BETWEEN 0 AND 1440),
 buffer_after_minutes integer NOT NULL DEFAULT 0 CHECK(buffer_after_minutes BETWEEN 0 AND 1440),
 billing_mode text NOT NULL CHECK(billing_mode IN ('free','paid')),
 stripe_mode text NOT NULL CHECK(stripe_mode IN ('test','live')),
 financial_snapshot jsonb NOT NULL, attendee_snapshot jsonb NOT NULL,
 state text NOT NULL DEFAULT 'requested' CHECK(state IN ('requested','accepted','authorizing','scheduling','confirming','confirmed','cancelling','cancelled','review','failed','completed')),
 version integer NOT NULL DEFAULT 1 CHECK(version>0), provider_accepted_at timestamptz, cancel_requested_at timestamptz,
 stripe_customer_id text, checkout_session_id text UNIQUE, payment_intent_id text UNIQUE, checkout_origin text,
 external_event_uri text UNIQUE, external_invitee_uri text UNIQUE, meeting_url text,
 payment_booking_id uuid UNIQUE REFERENCES bookings(id) DEFERRABLE INITIALLY DEFERRED,
 last_error text, last_checked_at timestamptz, next_check_at timestamptz NOT NULL DEFAULT now(), created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(customer_id,request_key),
 CHECK (billing_mode <> 'free' OR (stripe_customer_id IS NULL AND checkout_session_id IS NULL AND payment_intent_id IS NULL AND payment_booking_id IS NULL))
);
CREATE INDEX IF NOT EXISTS calendly_calls_customer ON calendly_calls(customer_id,created_at DESC);
CREATE INDEX IF NOT EXISTS calendly_calls_provider ON calendly_calls(provider_id,created_at DESC);
CREATE INDEX IF NOT EXISTS calendly_calls_recovery ON calendly_calls(next_check_at,created_at) WHERE state NOT IN ('cancelled','failed','completed');
CREATE TABLE IF NOT EXISTS calendly_call_operations (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), call_id uuid NOT NULL REFERENCES calendly_calls(id) ON DELETE RESTRICT,
 kind text NOT NULL CHECK(kind IN ('create_checkout','create_invitee','capture','cancel_invitee','cancel_authorization','refund')),
 attempted_at timestamptz, completed_at timestamptz, result jsonb, last_error text, created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(call_id,kind)
);
CREATE TABLE IF NOT EXISTS calendly_call_notifications (
 id bigserial PRIMARY KEY, call_id uuid NOT NULL REFERENCES calendly_calls(id) ON DELETE RESTRICT,
 user_id text NOT NULL REFERENCES "user"(id) ON DELETE RESTRICT,
 kind text NOT NULL, message text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), delivered_at timestamptz,
 UNIQUE(call_id,user_id,kind)
);
