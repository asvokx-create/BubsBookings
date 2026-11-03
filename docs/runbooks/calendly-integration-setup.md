# Calendly integration setup

## Calendly Developer Portal

Create a Sandbox OAuth app for nonproduction testing and a separate Production OAuth app for the live site.

Use these settings for production:

- Redirect URI: `https://bubsbookings.com/api/integrations/calendly/callback`
- Webhook URL: `https://bubsbookings.com/api/webhooks/calendly`
- Scopes: `users:read`, `scheduled_events:read`, and `webhooks:write`

The authorization request explicitly asks for these scopes. Existing provider connections created before scoped permissions were enabled must reconnect once so Calendly can grant them. A successful OAuth connection is not proof that appointment import succeeded; verify the separate last-successful-sync value.

Calendly requires PKCE for OAuth. BubsBookings creates and validates PKCE values and OAuth state server-side.

## DigitalOcean secrets

Add these as encrypted runtime-only variables on the web service:

- `CALENDLY_CLIENT_ID`
- `CALENDLY_CLIENT_SECRET`
- `CALENDLY_ENCRYPTION_KEY`, a separate long random secret
- `CALENDLY_WEBHOOK_SIGNING_KEY`

Do not put any of these values in a `NEXT_PUBLIC_` variable. Redeploy after saving them.

## Database

Deployment startup applies `107_calendly_calendar_integration.sql` and `108_calendly_sync_health.sql`. The migrations create encrypted connection metadata, external appointment records, one-time OAuth state, webhook delivery records, and separate import/webhook health fields. They do not alter bookings or payment records.

## Verification

1. Connect a Calendly Sandbox account from Provider Dashboard > Calendar.
2. Confirm upcoming appointments appear with a Calendly label.
3. Use Sync now and confirm the last-successful-sync timestamp changes.
4. On a paid Calendly test plan, create and cancel an appointment and confirm the webhook updates the calendar.
5. On a Free Calendly test plan, confirm appointment import and manual sync work, and that the page explains automatic webhook updates require Standard, Teams, or Enterprise.
6. Enable conflict blocking, create a synthetic overlapping request, and confirm BubsBookings rejects the unavailable time.
7. Confirm the external appointment never creates a booking, charge, commission, refund, or payout row.

## Disconnect behavior

Disconnecting revokes the OAuth token when Calendly is reachable, deletes the webhook subscription when possible, and stops future synchronization. Imported appointments remain as historical integration records, but disconnected connections are excluded from the provider calendar and availability checks.
