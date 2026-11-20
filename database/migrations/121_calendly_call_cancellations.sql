-- Durable authenticated native-policy cancellation, never inferred from a webhook.
CREATE TABLE IF NOT EXISTS calendly_call_cancellations (
 call_id uuid PRIMARY KEY REFERENCES calendly_calls(id),
 booking_id uuid NOT NULL UNIQUE REFERENCES bookings(id),
 actor_user_id text NOT NULL REFERENCES "user"(id),
 actor_role text NOT NULL CHECK(actor_role IN ('provider','customer')),
 reason text NOT NULL CHECK(length(reason) BETWEEN 3 AND 500),
 requested_at timestamptz NOT NULL,
 window_hours integer NOT NULL,
 late_cancellation boolean NOT NULL,
 refund_required boolean NOT NULL,
 event_uri text NOT NULL,invitee_uri text NOT NULL,
 cancel_operation_id uuid REFERENCES calendly_call_operations(id),
 external_cancelled_at timestamptz,native_cancelled_at timestamptz,completed_at timestamptz,last_error text,
 CHECK(refund_required=(actor_role='provider' OR NOT late_cancellation)),
 CHECK(actor_role='customer' OR NOT late_cancellation)
);
CREATE OR REPLACE FUNCTION immutable_calendly_cancellation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF ROW(NEW.call_id,NEW.booking_id,NEW.actor_user_id,NEW.actor_role,NEW.reason,NEW.requested_at,NEW.window_hours,NEW.late_cancellation,NEW.refund_required,NEW.event_uri,NEW.invitee_uri)
 IS DISTINCT FROM ROW(OLD.call_id,OLD.booking_id,OLD.actor_user_id,OLD.actor_role,OLD.reason,OLD.requested_at,OLD.window_hours,OLD.late_cancellation,OLD.refund_required,OLD.event_uri,OLD.invitee_uri)
 THEN RAISE EXCEPTION 'Cancellation policy snapshot cannot change' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS calendly_cancellation_immutable ON calendly_call_cancellations;
CREATE TRIGGER calendly_cancellation_immutable BEFORE UPDATE ON calendly_call_cancellations FOR EACH ROW EXECUTE FUNCTION immutable_calendly_cancellation();

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
  IF linked.state<>'confirmed' OR linked.ends_at>now() OR linked.cancel_requested_at IS NOT NULL THEN
   RAISE EXCEPTION 'A confirmed Calendly call can be completed only after its scheduled end' USING ERRCODE='23P01';
  END IF;
  UPDATE calendly_calls SET state='completed',version=version+1,updated_at=now() WHERE id=linked.id AND state='confirmed';
 END IF;
 RETURN NEW;
END $$;
