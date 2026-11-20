-- Temporary read failures must not freeze healthy calls permanently or allow
-- completion/payout while calendar verification is unresolved.
ALTER TABLE calendly_calls ADD COLUMN IF NOT EXISTS calendar_check_pending boolean NOT NULL DEFAULT false;
CREATE OR REPLACE FUNCTION protect_linked_calendly_booking() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE linked record;
BEGIN
 SELECT c.* INTO linked FROM calendly_calls c WHERE c.payment_booking_id=OLD.id
 OR EXISTS(SELECT 1 FROM calendly_call_slot_holds h WHERE h.call_id=c.id AND h.native_booking_id=OLD.id) LIMIT 1 FOR UPDATE OF c;
 IF NOT FOUND THEN RETURN NEW; END IF;
 IF NEW.provider_id IS DISTINCT FROM OLD.provider_id OR NEW.starts_at IS DISTINCT FROM OLD.starts_at OR NEW.ends_at IS DISTINCT FROM OLD.ends_at THEN
  RAISE EXCEPTION 'Calendly calls require coordinated rescheduling' USING ERRCODE='23P01';
 END IF;
 IF NEW.status IS DISTINCT FROM OLD.status AND OLD.status IN ('cancelled','completed') THEN
  RAISE EXCEPTION 'A closed Calendly booking cannot be reopened' USING ERRCODE='23P01';
 END IF;
 IF NEW.status='cancelled' AND OLD.status IS DISTINCT FROM NEW.status THEN
  IF OLD.status<>'confirmed' OR linked.state NOT IN ('cancelling','review') OR NOT EXISTS(
   SELECT 1 FROM calendly_call_cancellations x JOIN calendly_call_operations o ON o.id=x.cancel_operation_id
   WHERE x.call_id=linked.id AND x.booking_id=OLD.id AND x.external_cancelled_at IS NOT NULL
   AND x.event_uri=linked.external_event_uri AND x.invitee_uri=linked.external_invitee_uri
   AND o.call_id=linked.id AND o.kind='cancel_invitee' AND o.attempted_at IS NOT NULL AND o.completed_at IS NOT NULL
   AND o.result->>'eventUri'=x.event_uri AND o.result->>'inviteeUri'=x.invitee_uri
   AND NEW.cancelled_by=x.actor_role AND NEW.cancellation_reason=x.reason AND NEW.late_cancellation=x.late_cancellation)
  THEN RAISE EXCEPTION 'Calendly cancellation requires verified external proof' USING ERRCODE='23P01'; END IF;
 END IF;
 IF NEW.status='completed' AND OLD.status IS DISTINCT FROM NEW.status THEN
  IF linked.calendar_check_pending OR linked.state<>'confirmed' OR linked.ends_at>now() OR linked.cancel_requested_at IS NOT NULL THEN
   RAISE EXCEPTION 'A confirmed Calendly call can be completed only after its scheduled end' USING ERRCODE='23P01';
  END IF;
  UPDATE calendly_calls SET state='completed',version=version+1,updated_at=now() WHERE id=linked.id AND state='confirmed';
 END IF;
 IF NEW.payment_release_status='processing' AND OLD.payment_release_status IS DISTINCT FROM NEW.payment_release_status AND linked.calendar_check_pending THEN
  RAISE EXCEPTION 'Calendly verification is pending; payout is blocked' USING ERRCODE='23P01';
 END IF;
 RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS linked_calendly_booking_lifecycle_guard ON bookings;
CREATE TRIGGER linked_calendly_booking_lifecycle_guard BEFORE UPDATE OF status,starts_at,ends_at,provider_id,payment_release_status ON bookings FOR EACH ROW EXECUTE FUNCTION protect_linked_calendly_booking();
