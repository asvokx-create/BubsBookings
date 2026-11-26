-- Optional estimate, not a minimum, maximum, or historical booking duration.
-- No default/backfill: existing providers have not supplied an estimate.
BEGIN;
ALTER TABLE services
  ADD COLUMN IF NOT EXISTS estimated_min_minutes integer,
  ADD COLUMN IF NOT EXISTS estimated_max_minutes integer;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'services_hourly_estimate_range_check' AND conrelid = 'services'::regclass) THEN
    ALTER TABLE services ADD CONSTRAINT services_hourly_estimate_range_check CHECK (
      (estimated_min_minutes IS NULL AND estimated_max_minutes IS NULL)
      OR (pricing_type = 'HOURLY' AND estimated_min_minutes IS NOT NULL AND estimated_max_minutes IS NOT NULL
          AND estimated_min_minutes >= 1 AND estimated_max_minutes >= estimated_min_minutes AND estimated_max_minutes <= 60000)
    );
  END IF;
END $$;
COMMIT;
