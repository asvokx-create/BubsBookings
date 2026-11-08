CREATE TABLE IF NOT EXISTS booking_reschedule_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id uuid NOT NULL REFERENCES bookings(id) ON DELETE RESTRICT,
  requested_by text NOT NULL REFERENCES "user"(id) ON DELETE RESTRICT,
  requester_role text NOT NULL CHECK (requester_role IN ('customer', 'provider')),
  original_starts_at timestamptz NOT NULL,
  original_ends_at timestamptz NOT NULL,
  proposed_starts_at timestamptz NOT NULL,
  proposed_ends_at timestamptz NOT NULL,
  reason text NOT NULL DEFAULT '' CHECK (char_length(reason) <= 500),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN (
    'pending', 'approved', 'declined', 'withdrawn', 'expired', 'time_unavailable'
  )),
  response_reason text NOT NULL DEFAULT '' CHECK (char_length(response_reason) <= 500),
  responded_by text REFERENCES "user"(id) ON DELETE SET NULL,
  responded_at timestamptz,
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '72 hours'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (original_ends_at > original_starts_at),
  CHECK (proposed_ends_at > proposed_starts_at)
);

CREATE UNIQUE INDEX IF NOT EXISTS booking_reschedule_requests_pending_key
  ON booking_reschedule_requests(booking_id) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS booking_reschedule_requests_booking_idx
  ON booking_reschedule_requests(booking_id, created_at DESC);
CREATE INDEX IF NOT EXISTS booking_reschedule_requests_expiry_idx
  ON booking_reschedule_requests(expires_at) WHERE status = 'pending';

DROP TRIGGER IF EXISTS booking_reschedule_requests_set_updated_at ON booking_reschedule_requests;
CREATE TRIGGER booking_reschedule_requests_set_updated_at BEFORE UPDATE ON booking_reschedule_requests
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Preserve any customer requests created by the earlier one-sided implementation.
INSERT INTO booking_reschedule_requests (
  booking_id, requested_by, requester_role, original_starts_at, original_ends_at,
  proposed_starts_at, proposed_ends_at, reason, expires_at, created_at
)
SELECT booking.id, booking.customer_id, 'customer', booking.starts_at, booking.ends_at,
       booking.reschedule_starts_at, booking.reschedule_ends_at,
       COALESCE(booking.reschedule_reason, ''),
       GREATEST(COALESCE(booking.reschedule_requested_at, now()) + interval '72 hours', now() + interval '1 hour'),
       COALESCE(booking.reschedule_requested_at, now())
FROM bookings booking
WHERE booking.reschedule_starts_at IS NOT NULL
  AND booking.reschedule_ends_at IS NOT NULL
  AND booking.status = 'confirmed'
  AND NOT EXISTS (
    SELECT 1 FROM booking_reschedule_requests request
    WHERE request.booking_id = booking.id AND request.status = 'pending'
  )
ON CONFLICT DO NOTHING;

COMMENT ON TABLE booking_reschedule_requests IS
  'Two-sided schedule proposals. A pending row never changes the confirmed booking or creates a calendar hold.';
