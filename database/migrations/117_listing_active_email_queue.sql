-- Durable, once-per-listing publication notices. No historical campaign/backfill.
BEGIN;
CREATE TABLE IF NOT EXISTS listing_active_email_deliveries (
  service_id uuid PRIMARY KEY REFERENCES services(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued','sending','sent','suppressed','review_required')),
  attempt_count integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  first_attempt_at timestamptz,
  attempted_at timestamptz,
  sent_at timestamptz,
  payload jsonb,
  provider_message_id text,
  last_error text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS listing_active_email_due_idx
  ON listing_active_email_deliveries(next_attempt_at) WHERE status IN ('queued','sending');

-- Match the public service page's visibility gates, not just services.is_active.
CREATE OR REPLACE VIEW listing_active_email_eligible AS
 SELECT s.id AS service_id, s.title AS service_title, s.slug,
        p.user_id, s.business_name, account.email, account.name
 FROM services s
 JOIN provider_profiles p ON p.id=s.provider_id
 JOIN provider_companies company ON company.id=s.company_id AND company.is_active=true
 JOIN "user" account ON account.id=p.user_id
 WHERE s.is_active=true AND s.provider_deleted_at IS NULL
   AND p.is_active=true AND p.age_verification_status='verified';

CREATE TABLE IF NOT EXISTS listing_active_email_rollout (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton), initialized_at timestamptz NOT NULL DEFAULT now()
);
-- Migrations run at every startup. Only the first application may baseline.
WITH first_run AS (
 INSERT INTO listing_active_email_rollout(singleton) VALUES(true)
 ON CONFLICT DO NOTHING RETURNING singleton
)
INSERT INTO listing_active_email_deliveries(service_id,status,last_error)
 SELECT service_id,'suppressed','Already public before activation notices were introduced.'
 FROM listing_active_email_eligible WHERE EXISTS(SELECT 1 FROM first_run)
 ON CONFLICT DO NOTHING;
COMMIT;
