-- Written with the durable payout claim, before Stripe can move money. Do not
-- backfill historic transfers: their notifications may already have been sent.
CREATE TABLE IF NOT EXISTS booking_payout_finalizations (
  booking_id uuid PRIMARY KEY REFERENCES bookings(id) ON DELETE CASCADE,
  release_trigger text NOT NULL CHECK (release_trigger IN ('customer', 'automatic', 'admin')),
  amount_cents integer NOT NULL CHECK (amount_cents > 0),
  refunded_cents integer NOT NULL DEFAULT 0 CHECK (refunded_cents >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);

CREATE INDEX IF NOT EXISTS booking_payout_finalizations_pending_idx
  ON booking_payout_finalizations (created_at) WHERE completed_at IS NULL;
