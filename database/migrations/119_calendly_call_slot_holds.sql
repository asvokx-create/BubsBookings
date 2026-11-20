-- Additive reservation backstop. No rows/behavior are enabled by this migration.
-- Only the disabled-by-default call flow acquires holds. Unknown external
-- outcomes have no TTL: releasing them requires explicit reconciliation.
CREATE TABLE IF NOT EXISTS calendly_call_slot_holds (
 call_id uuid PRIMARY KEY REFERENCES calendly_calls(id) ON DELETE RESTRICT,
 provider_id uuid NOT NULL REFERENCES provider_profiles(id) ON DELETE RESTRICT,
 starts_at timestamptz NOT NULL,
 ends_at timestamptz NOT NULL,
 native_booking_id uuid UNIQUE REFERENCES bookings(id) DEFERRABLE INITIALLY DEFERRED,
 released_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(),
 CHECK (isfinite(starts_at) AND isfinite(ends_at) AND starts_at < ends_at)
);
CREATE INDEX IF NOT EXISTS calendly_call_slot_holds_active_idx ON calendly_call_slot_holds(provider_id,starts_at,ends_at) WHERE released_at IS NULL;

CREATE OR REPLACE FUNCTION check_calendly_call_hold() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE owner_id uuid; mapped_event text;
BEGIN
 IF TG_OP='UPDATE' AND (NEW.call_id<>OLD.call_id OR NEW.provider_id<>OLD.provider_id) THEN
  RAISE EXCEPTION 'Call reservation ownership cannot change' USING ERRCODE='23514';
 END IF;
 IF TG_OP='UPDATE' AND OLD.native_booking_id IS NOT NULL AND NEW.native_booking_id IS DISTINCT FROM OLD.native_booking_id THEN
  RAISE EXCEPTION 'Call payment booking mapping cannot change' USING ERRCODE='23514';
 END IF;
 PERFORM pg_advisory_xact_lock(hashtext(NEW.provider_id::text));
 SELECT provider_id,external_event_uri INTO owner_id,mapped_event FROM calendly_calls WHERE id=NEW.call_id;
 IF owner_id IS DISTINCT FROM NEW.provider_id THEN RAISE EXCEPTION 'Call reservation owner mismatch' USING ERRCODE='23514'; END IF;
 IF NEW.released_at IS NOT NULL THEN RETURN NEW; END IF;
 IF TG_OP='UPDATE' AND OLD.released_at IS NOT NULL THEN RAISE EXCEPTION 'Released call reservation cannot reactivate' USING ERRCODE='23514'; END IF;
 IF EXISTS(SELECT 1 FROM calendly_call_slot_holds h WHERE h.provider_id=NEW.provider_id AND h.call_id<>NEW.call_id AND h.released_at IS NULL AND h.starts_at<NEW.ends_at AND h.ends_at>NEW.starts_at)
 OR EXISTS(SELECT 1 FROM bookings b WHERE b.provider_id=NEW.provider_id AND b.status='confirmed'
   AND b.id IS DISTINCT FROM NEW.native_booking_id AND b.starts_at<NEW.ends_at AND b.ends_at>NEW.starts_at
   AND (NOT EXISTS(SELECT 1 FROM booking_assignees a WHERE a.booking_id=b.id) OR EXISTS(SELECT 1 FROM booking_assignees a WHERE a.booking_id=b.id AND a.is_owner)))
 OR EXISTS(SELECT 1 FROM provider_time_off t WHERE t.provider_id=NEW.provider_id AND t.team_member_id IS NULL AND t.starts_at<NEW.ends_at AND t.ends_at>NEW.starts_at)
 OR EXISTS(SELECT 1 FROM provider_calendly_events e JOIN provider_calendly_connections c ON c.id=e.connection_id
   WHERE c.provider_id=NEW.provider_id AND c.disconnected_at IS NULL AND c.block_conflicting_bookings AND e.status='active'
   AND e.external_event_uri IS DISTINCT FROM mapped_event AND e.starts_at<NEW.ends_at AND e.ends_at>NEW.starts_at)
 THEN RAISE EXCEPTION 'Call slot conflicts with another reservation' USING ERRCODE='23P01'; END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS calendly_call_hold_guard ON calendly_call_slot_holds;
CREATE TRIGGER calendly_call_hold_guard BEFORE INSERT OR UPDATE ON calendly_call_slot_holds FOR EACH ROW EXECUTE FUNCTION check_calendly_call_hold();

CREATE OR REPLACE FUNCTION check_native_booking_call_hold() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.status<>'confirmed' THEN RETURN NEW; END IF;
 PERFORM pg_advisory_xact_lock(hashtext(NEW.provider_id::text));
 IF (NOT EXISTS(SELECT 1 FROM booking_assignees a WHERE a.booking_id=NEW.id) OR EXISTS(SELECT 1 FROM booking_assignees a WHERE a.booking_id=NEW.id AND a.is_owner))
 AND EXISTS(SELECT 1 FROM calendly_call_slot_holds h WHERE h.provider_id=NEW.provider_id AND h.released_at IS NULL
  AND h.native_booking_id IS DISTINCT FROM NEW.id AND h.starts_at<NEW.ends_at AND h.ends_at>NEW.starts_at)
 THEN RAISE EXCEPTION 'Booking conflicts with a reserved call' USING ERRCODE='23P01'; END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS native_booking_call_hold_guard ON bookings;
CREATE TRIGGER native_booking_call_hold_guard BEFORE INSERT OR UPDATE OF status,starts_at,ends_at,provider_id ON bookings FOR EACH ROW EXECUTE FUNCTION check_native_booking_call_hold();

-- Deferred: assignment replacement DELETE+INSERT is checked in its final state.
CREATE OR REPLACE FUNCTION check_native_assignment_call_hold() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE b record; target_id uuid; previous_id uuid;
BEGIN
 target_id:=CASE WHEN TG_OP='DELETE' THEN OLD.booking_id ELSE NEW.booking_id END;
 previous_id:=CASE WHEN TG_OP='UPDATE' THEN OLD.booking_id ELSE target_id END;
 FOR b IN SELECT * FROM bookings WHERE id IN (target_id,previous_id) AND status='confirmed' ORDER BY provider_id,id LOOP
  PERFORM pg_advisory_xact_lock(hashtext(b.provider_id::text));
  IF (NOT EXISTS(SELECT 1 FROM booking_assignees a WHERE a.booking_id=b.id) OR EXISTS(SELECT 1 FROM booking_assignees a WHERE a.booking_id=b.id AND a.is_owner))
  AND EXISTS(SELECT 1 FROM calendly_call_slot_holds h WHERE h.provider_id=b.provider_id AND h.released_at IS NULL
   AND h.native_booking_id IS DISTINCT FROM b.id AND h.starts_at<b.ends_at AND h.ends_at>b.starts_at)
  THEN RAISE EXCEPTION 'Booking assignment conflicts with a reserved call' USING ERRCODE='23P01'; END IF;
 END LOOP;
 RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS native_assignment_call_hold_guard ON booking_assignees;
CREATE CONSTRAINT TRIGGER native_assignment_call_hold_guard AFTER INSERT OR UPDATE OR DELETE ON booking_assignees DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_native_assignment_call_hold();

CREATE OR REPLACE FUNCTION check_native_timeoff_call_hold() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.team_member_id IS NOT NULL THEN RETURN NEW; END IF;
 PERFORM pg_advisory_xact_lock(hashtext(NEW.provider_id::text));
 IF EXISTS(SELECT 1 FROM calendly_call_slot_holds h WHERE h.provider_id=NEW.provider_id AND h.released_at IS NULL AND h.starts_at<NEW.ends_at AND h.ends_at>NEW.starts_at)
 THEN RAISE EXCEPTION 'Unavailable period conflicts with a reserved call' USING ERRCODE='23P01'; END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS native_timeoff_call_hold_guard ON provider_time_off;
CREATE TRIGGER native_timeoff_call_hold_guard BEFORE INSERT OR UPDATE ON provider_time_off FOR EACH ROW EXECUTE FUNCTION check_native_timeoff_call_hold();

-- Native routes must not independently cancel/reschedule a captured Calendly call.
-- Until coordinated external cancellation + existing refund policy is implemented,
-- fail closed even when the rollout switch is disabled (recovery safety).
CREATE OR REPLACE FUNCTION protect_linked_calendly_booking() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE linked record;
BEGIN
 SELECT c.* INTO linked FROM calendly_calls c WHERE c.payment_booking_id=OLD.id
 OR EXISTS(SELECT 1 FROM calendly_call_slot_holds h WHERE h.call_id=c.id AND h.native_booking_id=OLD.id) LIMIT 1 FOR UPDATE OF c;
 IF NOT FOUND THEN RETURN NEW; END IF;
 IF NEW.provider_id IS DISTINCT FROM OLD.provider_id OR NEW.starts_at IS DISTINCT FROM OLD.starts_at OR NEW.ends_at IS DISTINCT FROM OLD.ends_at
 OR (NEW.status='cancelled' AND OLD.status IS DISTINCT FROM NEW.status) THEN
  RAISE EXCEPTION 'Calendly calls require coordinated cancellation or rescheduling; native changes are disabled' USING ERRCODE='23P01';
 END IF;
 IF NEW.status='completed' AND OLD.status IS DISTINCT FROM NEW.status THEN
  IF linked.state<>'confirmed' OR linked.ends_at>now() THEN
   RAISE EXCEPTION 'A confirmed Calendly call can be completed only after its scheduled end' USING ERRCODE='23P01';
  END IF;
  UPDATE calendly_calls SET state='completed',version=version+1,updated_at=now() WHERE id=linked.id AND state='confirmed';
 END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS linked_calendly_booking_lifecycle_guard ON bookings;
CREATE TRIGGER linked_calendly_booking_lifecycle_guard BEFORE UPDATE OF status,starts_at,ends_at,provider_id ON bookings FOR EACH ROW EXECUTE FUNCTION protect_linked_calendly_booking();
