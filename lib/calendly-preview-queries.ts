export const PUBLIC_CALENDLY_PREVIEW_QUERY = `
  SELECT preview.service_id::text,preview.connection_id::text,preview.event_type_uri,
    preview.updated_at::text,connection.calendly_user_uri,connection.connected_at::text,connection.account_timezone,connection.granted_scope
  FROM service_calendly_availability_previews preview
  JOIN services service ON service.id=preview.service_id
  JOIN provider_profiles provider ON provider.id=service.provider_id
  JOIN provider_companies company ON company.id=service.company_id AND company.is_active=true
  JOIN provider_calendly_connections connection ON connection.id=preview.connection_id AND connection.provider_id=service.provider_id
  WHERE service.id::text=$1 AND service.is_active=true AND service.provider_deleted_at IS NULL
    AND service.delivery_type IN ('REMOTE','BOTH') AND provider.is_active=true AND provider.age_verification_status='verified'
    AND connection.disconnected_at IS NULL AND connection.calendly_user_uri=preview.calendly_user_uri
    AND connection.connected_at=preview.connection_connected_at`;

export const CALENDLY_PREVIEW_CONFLICTS_QUERY = `
  SELECT blocked.starts_at,blocked.ends_at FROM provider_time_off blocked
  JOIN services service ON service.provider_id=blocked.provider_id
  WHERE service.id::text=$1 AND blocked.team_member_id IS NULL AND blocked.starts_at<$3 AND blocked.ends_at>$2
  UNION ALL
  SELECT booking.starts_at,booking.ends_at FROM bookings booking
  JOIN services service ON service.provider_id=booking.provider_id
  WHERE service.id::text=$1 AND booking.status='confirmed' AND booking.starts_at<$3 AND booking.ends_at>$2
    AND EXISTS (SELECT 1 FROM booking_assignees assigned WHERE assigned.booking_id=booking.id AND assigned.is_owner=true)`;

// Timestamp text preserves PostgreSQL microseconds for the reconnect generation check.
export const SAVE_CALENDLY_PREVIEW_QUERY = `
  INSERT INTO service_calendly_availability_previews(service_id,connection_id,calendly_user_uri,connection_connected_at,event_type_uri,event_type_name)
  SELECT service.id,connection.id,connection.calendly_user_uri,connection.connected_at,$4,$5
  FROM services service JOIN provider_calendly_connections connection ON connection.provider_id=service.provider_id
  WHERE service.id::text=$1 AND service.provider_id::text=$2 AND service.provider_deleted_at IS NULL AND service.delivery_type IN ('REMOTE','BOTH')
    AND connection.id::text=$3 AND connection.calendly_user_uri=$6 AND connection.connected_at=$7 AND connection.disconnected_at IS NULL
  ON CONFLICT(service_id) DO UPDATE SET connection_id=excluded.connection_id,calendly_user_uri=excluded.calendly_user_uri,
    connection_connected_at=excluded.connection_connected_at,event_type_uri=excluded.event_type_uri,event_type_name=excluded.event_type_name,updated_at=now()
  RETURNING service_id`;
