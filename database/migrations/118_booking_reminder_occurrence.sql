-- Additive phase: no previous booking is rearmed by this migration.
ALTER TABLE bookings
  ADD COLUMN IF NOT EXISTS reminder_occurrence bigint NOT NULL DEFAULT 0;
