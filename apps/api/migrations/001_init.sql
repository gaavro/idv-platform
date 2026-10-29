-- Row-level security reads the tenant from a transaction-local setting
-- (see Db.withContext). Platform staff (analysts) get cross-tenant access.
CREATE FUNCTION app_current_tenant() RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT nullif(current_setting('app.tenant_id', true), '')::uuid
$$;

CREATE FUNCTION app_platform_access() RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT coalesce(current_setting('app.platform_access', true), '') = 'on'
$$;

CREATE TABLE tenants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  webhook_url text,
  webhook_secret text NOT NULL,
  auto_approve_threshold int NOT NULL DEFAULT 80 CHECK (auto_approve_threshold BETWEEN 0 AND 100),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE api_keys (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  key_hash text NOT NULL UNIQUE,
  key_prefix text NOT NULL,
  environment text NOT NULL CHECK (environment IN ('sandbox', 'live')),
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE analysts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  email text NOT NULL UNIQUE,
  token_hash text NOT NULL UNIQUE,
  role text NOT NULL CHECK (role IN ('analyst', 'supervisor')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE verifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  environment text NOT NULL CHECK (environment IN ('sandbox', 'live')),
  external_user_id text NOT NULL,
  journey text NOT NULL CHECK (journey IN ('signup', 'login', 'deposit', 'withdrawal')),
  cpf text,
  status text NOT NULL CHECK (status IN (
    'created', 'capturing', 'analyzing', 'in_review', 'approved', 'rejected',
    'resubmission_requested', 'technical_error', 'expired', 'cancelled')),
  score int CHECK (score BETWEEN 0 AND 100),
  metadata jsonb NOT NULL DEFAULT '{}',
  idempotency_key text,
  capture_round int NOT NULL DEFAULT 1,
  current_analysis_run uuid,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, idempotency_key)
);
CREATE INDEX verifications_review_queue ON verifications (created_at) WHERE status = 'in_review';
CREATE INDEX verifications_external_user ON verifications (tenant_id, external_user_id);

-- Looked up before the tenant is known, so it has no RLS; holds only hashes.
CREATE TABLE verification_sessions (
  token_hash text PRIMARY KEY,
  verification_id uuid NOT NULL REFERENCES verifications(id),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE captures (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  verification_id uuid NOT NULL REFERENCES verifications(id),
  round int NOT NULL,
  kind text NOT NULL CHECK (kind IN ('selfie', 'document_front', 'document_back')),
  storage_key text NOT NULL,
  mime_type text NOT NULL,
  size_bytes int NOT NULL,
  sha256 text NOT NULL,
  liveness_session_id text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX captures_verification ON captures (verification_id, round, kind, created_at DESC);
CREATE INDEX captures_sha256 ON captures (tenant_id, sha256);

CREATE TABLE check_results (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  verification_id uuid NOT NULL REFERENCES verifications(id),
  analysis_run uuid NOT NULL,
  type text NOT NULL,
  outcome text NOT NULL CHECK (outcome IN ('pass', 'fail', 'inconclusive', 'technical_error')),
  critical boolean NOT NULL DEFAULT false,
  score int CHECK (score BETWEEN 0 AND 100),
  provider text NOT NULL,
  details jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX check_results_run ON check_results (verification_id, analysis_run);

CREATE TABLE extracted_data (
  verification_id uuid PRIMARY KEY REFERENCES verifications(id),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  document_type text,
  fields jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Every decision, automatic routing or analyst, with its reason.
CREATE TABLE decisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  verification_id uuid NOT NULL REFERENCES verifications(id),
  outcome text NOT NULL CHECK (outcome IN (
    'approved', 'rejected', 'resubmission_requested', 'manual_review', 'technical_error')),
  origin text NOT NULL CHECK (origin IN ('automatic', 'manual')),
  reason text NOT NULL,
  analyst_id uuid REFERENCES analysts(id),
  score int,
  rules_version text,
  details jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((origin = 'manual') = (analyst_id IS NOT NULL))
);
CREATE INDEX decisions_verification ON decisions (verification_id, created_at DESC);

CREATE TABLE audit_events (
  id bigserial PRIMARY KEY,
  tenant_id uuid REFERENCES tenants(id),
  verification_id uuid,
  actor_type text NOT NULL CHECK (actor_type IN ('api_key', 'end_user', 'analyst', 'system')),
  actor_id text,
  action text NOT NULL,
  details jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE jobs (
  id bigserial PRIMARY KEY,
  type text NOT NULL,
  payload jsonb NOT NULL,
  run_at timestamptz NOT NULL DEFAULT now(),
  attempts int NOT NULL DEFAULT 0,
  max_attempts int NOT NULL DEFAULT 5,
  locked_at timestamptz,
  last_error text,
  done_at timestamptz,
  failed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX jobs_pending ON jobs (run_at) WHERE done_at IS NULL AND failed_at IS NULL;

-- Tenant isolation
ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON tenants
  USING (id = app_current_tenant() OR app_platform_access());

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['verifications', 'captures', 'check_results', 'extracted_data', 'decisions', 'audit_events'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I
         USING (tenant_id = app_current_tenant() OR app_platform_access())
         WITH CHECK (tenant_id = app_current_tenant() OR app_platform_access())', t);
  END LOOP;
END $$;

-- check_results, decisions and audit_events are append-only for the app.
GRANT SELECT ON tenants TO idv_app;
GRANT SELECT, INSERT, UPDATE ON verifications, captures, extracted_data TO idv_app;
GRANT SELECT, INSERT ON check_results, decisions, audit_events TO idv_app;
GRANT SELECT, INSERT, UPDATE ON api_keys, analysts, jobs TO idv_app;
GRANT SELECT, INSERT, DELETE ON verification_sessions TO idv_app;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO idv_app;
