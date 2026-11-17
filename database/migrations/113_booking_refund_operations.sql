-- Immutable authorization snapshots. Never manufacture executable operations
-- from historical booking totals: old/unbound refunds require operator review.
CREATE TABLE IF NOT EXISTS booking_refund_operations (
  id uuid PRIMARY KEY,
  booking_id uuid NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  stripe_mode text NOT NULL CHECK (stripe_mode IN ('test', 'live')),
  origin text NOT NULL CHECK (origin IN ('provider', 'automatic', 'dispute_partial')),
  actor_user_id text,
  dispute_id text,
  payment_intent_id text NOT NULL,
  charge_id text,
  currency text NOT NULL DEFAULT 'usd' CHECK (currency = 'usd'),
  payment_flow text,
  refund_application_fee boolean NOT NULL DEFAULT false,
  service_amount_cents integer NOT NULL CHECK (service_amount_cents >= 0),
  fee_amount_cents integer NOT NULL CHECK (fee_amount_cents >= 0),
  baseline_service_cents integer NOT NULL CHECK (baseline_service_cents >= 0),
  baseline_fee_cents integer NOT NULL CHECK (baseline_fee_cents >= 0),
  price_cents integer NOT NULL CHECK (price_cents > 0),
  service_fee_cents integer NOT NULL CHECK (service_fee_cents >= 0),
  provider_share_cents integer NOT NULL CHECK (provider_share_cents >= 0),
  adjusted_share_cents integer NOT NULL CHECK (adjusted_share_cents >= 0),
  transfer_id text,
  connected_account_id text,
  baseline_reversed_cents integer NOT NULL CHECK (baseline_reversed_cents >= 0),
  reversal_target_cents integer NOT NULL CHECK (reversal_target_cents >= 0),
  refund_attempted_at timestamptz,
  stripe_refund_id text,
  stripe_refund_status text,
  refund_confirmed_at timestamptz,
  effects_completed_at timestamptz,
  reversal_attempted_at timestamptz,
  reversal_amount_cents integer CHECK (reversal_amount_cents > 0),
  stripe_reversal_id text,
  recovery_completed_at timestamptz,
  last_checked_at timestamptz,
  decision_snapshot jsonb,
  decision_completed_at timestamptz,
  settlement_issue_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (service_amount_cents + fee_amount_cents > 0),
  CHECK (baseline_service_cents + service_amount_cents <= price_cents),
  CHECK (baseline_fee_cents + fee_amount_cents <= service_fee_cents),
  CHECK (reversal_target_cents <= provider_share_cents),
  UNIQUE (stripe_mode, stripe_refund_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS booking_refund_operations_active_idx
  ON booking_refund_operations (booking_id)
  WHERE effects_completed_at IS NULL OR recovery_completed_at IS NULL OR (dispute_id IS NOT NULL AND decision_completed_at IS NULL);
CREATE INDEX IF NOT EXISTS booking_refund_operations_pending_idx
  ON booking_refund_operations (created_at)
  WHERE effects_completed_at IS NULL OR recovery_completed_at IS NULL OR (dispute_id IS NOT NULL AND decision_completed_at IS NULL);
CREATE UNIQUE INDEX IF NOT EXISTS booking_refund_operations_dispute_idx
  ON booking_refund_operations (stripe_mode,dispute_id) WHERE dispute_id IS NOT NULL;
ALTER TABLE booking_disputes ADD COLUMN IF NOT EXISTS refund_operation_id uuid REFERENCES booking_refund_operations(id);
