-- Additive only: legacy bookings and their payment history remain unchanged.
CREATE TABLE IF NOT EXISTS hourly_projects (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 customer_id text NOT NULL REFERENCES "user"(id) ON DELETE RESTRICT,
 provider_id uuid NOT NULL REFERENCES provider_profiles(id) ON DELETE RESTRICT,
 service_id uuid NOT NULL REFERENCES services(id) ON DELETE RESTRICT,
 status text NOT NULL DEFAULT 'requested' CHECK (status IN ('requested','active','submitted','approved','cancelled')),
 title text NOT NULL, description text NOT NULL,
 hourly_rate_cents integer NOT NULL CHECK (hourly_rate_cents BETWEEN 1 AND 10000000),
 cap_minutes integer NOT NULL CHECK (cap_minutes BETWEEN 1 AND 525600),
 delivery_method text NOT NULL CHECK (delivery_method IN ('REMOTE','IN_PERSON')),
 service_address text NOT NULL, access_instructions text NOT NULL DEFAULT '',
 version integer NOT NULL DEFAULT 1 CHECK (version > 0),
 submitted_seconds integer, submitted_minutes integer, submitted_subtotal_cents integer,
 payment_booking_id uuid UNIQUE REFERENCES bookings(id) ON DELETE RESTRICT,
 submitted_at timestamptz, approved_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 CHECK (submitted_seconds IS NULL OR submitted_seconds BETWEEN 1 AND cap_minutes * 60),
 CHECK (submitted_minutes IS NULL OR submitted_minutes = (submitted_seconds + 59) / 60),
 CHECK (submitted_subtotal_cents IS NULL OR submitted_subtotal_cents >= 0),
 UNIQUE(id,provider_id)
);
CREATE INDEX IF NOT EXISTS hourly_projects_customer ON hourly_projects(customer_id,created_at DESC);
CREATE INDEX IF NOT EXISTS hourly_projects_provider ON hourly_projects(provider_id,created_at DESC);
CREATE TABLE IF NOT EXISTS hourly_time_entries (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), project_id uuid NOT NULL REFERENCES hourly_projects(id) ON DELETE RESTRICT,
 provider_id uuid NOT NULL REFERENCES provider_profiles(id) ON DELETE RESTRICT,
 started_at timestamptz NOT NULL DEFAULT now(), ended_at timestamptz,
 duration_seconds integer NOT NULL DEFAULT 0 CHECK (duration_seconds >= 0),
 description text NOT NULL DEFAULT '', source text NOT NULL CHECK (source IN ('timer','manual')),
 timer_limit_seconds integer CHECK (timer_limit_seconds > 0),
 CHECK (ended_at IS NOT NULL OR (source = 'timer' AND timer_limit_seconds IS NOT NULL)),
 CHECK (ended_at IS NULL OR ended_at >= started_at),
 FOREIGN KEY(project_id,provider_id) REFERENCES hourly_projects(id,provider_id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS hourly_time_entries_project ON hourly_time_entries(project_id);
CREATE UNIQUE INDEX IF NOT EXISTS hourly_one_running_timer_per_provider ON hourly_time_entries(provider_id) WHERE ended_at IS NULL;
CREATE TABLE IF NOT EXISTS hourly_project_audit (
 id bigserial PRIMARY KEY, project_id uuid NOT NULL REFERENCES hourly_projects(id) ON DELETE RESTRICT,
 actor_id text NOT NULL REFERENCES "user"(id) ON DELETE RESTRICT,
 action text NOT NULL, version integer NOT NULL, details jsonb NOT NULL DEFAULT '{}'::jsonb,
 created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(project_id,version)
);
CREATE TABLE IF NOT EXISTS hourly_project_checkout_attempts (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), project_id uuid NOT NULL REFERENCES hourly_projects(id) ON DELETE RESTRICT,
 stripe_mode text NOT NULL CHECK (stripe_mode IN ('test','live')), stripe_customer_id text NOT NULL,
 origin text NOT NULL, checkout_session_id text UNIQUE, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS hourly_project_checkout_attempts_project ON hourly_project_checkout_attempts(project_id,created_at DESC,id DESC);
