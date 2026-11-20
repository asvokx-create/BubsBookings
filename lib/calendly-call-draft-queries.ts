export const LIST_CALENDLY_CALL_DRAFTS_QUERY = `
  SELECT service.id::text,service.title,draft.event_type_uri,draft.event_type_name,
    draft.duration_minutes,draft.billing_mode,draft.service_price_cents,draft.revision,
    draft.calendly_payment_verified_at::text,
    COALESCE(connection.id IS NOT NULL AND connection.disconnected_at IS NULL
      AND connection.provider_id=service.provider_id AND connection.calendly_user_uri=draft.calendly_user_uri
      AND connection.connected_at=draft.connection_connected_at,false) AS connection_current
  FROM services service LEFT JOIN service_calendly_call_drafts draft ON draft.service_id=service.id
  LEFT JOIN provider_calendly_connections connection ON connection.id=draft.connection_id
  WHERE service.provider_id::text=$1 AND service.provider_deleted_at IS NULL
    AND service.delivery_type IN ('REMOTE','BOTH') ORDER BY service.title`;

// Bind ownership and the exact connection generation again at write time.
// Revision prevents a stale tab from overwriting another edit or recreating a removed draft.
export const SAVE_CALENDLY_CALL_DRAFT_QUERY = `
  WITH eligible AS (
    SELECT service.id AS service_id,connection.id AS connection_id,connection.calendly_user_uri,connection.connected_at
    FROM services service JOIN provider_calendly_connections connection ON connection.provider_id=service.provider_id
    WHERE service.id::text=$1 AND service.provider_id::text=$2 AND service.provider_deleted_at IS NULL
      AND service.delivery_type IN ('REMOTE','BOTH') AND connection.id::text=$3
      AND connection.calendly_user_uri=$6 AND connection.connected_at=$7 AND connection.disconnected_at IS NULL
  ), edited AS (
    UPDATE service_calendly_call_drafts draft SET connection_id=eligible.connection_id,calendly_user_uri=eligible.calendly_user_uri,
      connection_connected_at=eligible.connected_at,event_type_uri=$4,event_type_name=$5,duration_minutes=$8,billing_mode=$9,
      service_price_cents=$10,calendly_payment_verified_at=now(),revision=gen_random_uuid(),updated_at=now()
    FROM eligible WHERE draft.service_id=eligible.service_id AND draft.revision=$11::uuid RETURNING draft.*
  ), created AS (
    INSERT INTO service_calendly_call_drafts
      (service_id,connection_id,calendly_user_uri,connection_connected_at,event_type_uri,event_type_name,
       duration_minutes,billing_mode,service_price_cents,calendly_payment_verified_at)
    SELECT service_id,connection_id,calendly_user_uri,connected_at,$4,$5,$8,$9,$10,now() FROM eligible
    WHERE $11::uuid IS NULL ON CONFLICT(service_id) DO NOTHING RETURNING *
  )
  SELECT event_type_uri,event_type_name,duration_minutes,billing_mode,service_price_cents,revision,
    calendly_payment_verified_at::text,true AS connection_current FROM edited
  UNION ALL
  SELECT event_type_uri,event_type_name,duration_minutes,billing_mode,service_price_cents,revision,
    calendly_payment_verified_at::text,true AS connection_current FROM created`;

export const DELETE_CALENDLY_CALL_DRAFT_QUERY = `
  DELETE FROM service_calendly_call_drafts draft USING services service
  WHERE draft.service_id=service.id AND service.id::text=$1 AND service.provider_id::text=$2
    AND draft.revision=$3 RETURNING draft.service_id`;
