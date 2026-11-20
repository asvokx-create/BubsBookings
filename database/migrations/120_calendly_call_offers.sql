-- Private drafts are never automatically published. Only an explicit owner action writes here.
CREATE TABLE IF NOT EXISTS calendly_call_offers (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), service_id uuid NOT NULL UNIQUE REFERENCES services(id) ON DELETE RESTRICT,
 provider_id uuid NOT NULL REFERENCES provider_profiles(id) ON DELETE RESTRICT,
 connection_id uuid NOT NULL REFERENCES provider_calendly_connections(id) ON DELETE RESTRICT,
 connection_generation text NOT NULL, owner_uri text NOT NULL, event_type_uri text NOT NULL,
 event_name text NOT NULL, duration_minutes integer NOT NULL CHECK(duration_minutes BETWEEN 1 AND 1440),
 location_kind text NOT NULL CHECK(location_kind='zoom_conference'),
 buffer_before_minutes integer NOT NULL CHECK(buffer_before_minutes BETWEEN 0 AND 1440),
 buffer_after_minutes integer NOT NULL CHECK(buffer_after_minutes BETWEEN 0 AND 1440),
 billing_mode text NOT NULL CHECK(billing_mode IN ('free','paid')), service_price_cents integer NOT NULL,
 revision uuid NOT NULL DEFAULT gen_random_uuid(), active boolean NOT NULL DEFAULT false,
 published_at timestamptz, updated_at timestamptz NOT NULL DEFAULT now(),
 CHECK((billing_mode='free' AND service_price_cents=0) OR (billing_mode='paid' AND service_price_cents BETWEEN 50 AND 100000000))
);
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conname='calendly_calls_offer_fk' AND conrelid='calendly_calls'::regclass) THEN
 ALTER TABLE calendly_calls ADD CONSTRAINT calendly_calls_offer_fk FOREIGN KEY(offer_id) REFERENCES calendly_call_offers(id) ON DELETE RESTRICT;
 END IF;
END $$;

ALTER TABLE calendly_calls ADD COLUMN IF NOT EXISTS disclosure_version text;
ALTER TABLE calendly_calls ADD COLUMN IF NOT EXISTS disclosure_accepted_at timestamptz;
