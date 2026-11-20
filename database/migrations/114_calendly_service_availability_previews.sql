-- Opt-in read-only previews, not bookings. No existing service is opted in.
CREATE TABLE IF NOT EXISTS service_calendly_availability_previews (
  service_id uuid PRIMARY KEY REFERENCES services(id) ON DELETE CASCADE,
  connection_id uuid NOT NULL REFERENCES provider_calendly_connections(id) ON DELETE CASCADE,
  calendly_user_uri text NOT NULL,
  connection_connected_at timestamptz NOT NULL,
  event_type_uri text NOT NULL CHECK (event_type_uri ~ '^https://api[.]calendly[.]com/event_types/[A-Za-z0-9_-]+$'),
  event_type_name text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE service_calendly_availability_previews IS
  'Owner-selected public Calendly availability previews. Does not reserve slots or create Calendly/BubsBookings bookings. Reconnection requires reselection.';
