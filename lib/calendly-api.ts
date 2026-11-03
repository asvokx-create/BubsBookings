export const CALENDLY_API_ORIGIN = "https://api.calendly.com";

export const CALENDLY_OAUTH_SCOPES = ["users:read", "scheduled_events:read", "webhooks:write"] as const;

export function calendlyApiUrl(pathOrUrl: string) {
  const url = new URL(pathOrUrl, CALENDLY_API_ORIGIN);
  if (url.origin !== CALENDLY_API_ORIGIN) throw new Error("Calendly returned an invalid API URL.");
  return url;
}

export function calendlyWebhookOwnerUris(scheduledEvent: Record<string, unknown>) {
  const memberships = Array.isArray(scheduledEvent.event_memberships) ? scheduledEvent.event_memberships : [];
  return [...new Set(memberships
    .map((membership) => (membership as Record<string, unknown> | undefined)?.user)
    .filter((user): user is string => typeof user === "string" && user.startsWith(`${CALENDLY_API_ORIGIN}/users/`)))];
}

export function calendlyScheduledEventStatus(webhookEvent: string | undefined, scheduledStatus: unknown): "active" | "canceled" {
  if (scheduledStatus === "active" || scheduledStatus === "canceled") return scheduledStatus;
  return webhookEvent === "invitee.canceled" ? "canceled" : "active";
}
