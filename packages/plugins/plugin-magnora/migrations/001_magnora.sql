CREATE TABLE plugin_magnora_7b37db9650.outbox (
  id uuid PRIMARY KEY,
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  kind text NOT NULL,
  channel text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL,
  requested_by_agent_id uuid,
  requested_by_agent_name text,
  run_id text,
  scheduled_for timestamptz,
  decided_by_user_id text,
  decided_at timestamptz,
  decision_note text,
  result jsonb,
  error text,
  attempts integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX outbox_company_status_idx ON plugin_magnora_7b37db9650.outbox (company_id, status, created_at DESC);

CREATE TABLE plugin_magnora_7b37db9650.error_log (
  id uuid PRIMARY KEY,
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  source text NOT NULL,
  task text NOT NULL,
  agent_id uuid,
  agent_name text,
  run_id text,
  error text NOT NULL,
  retry_status text NOT NULL DEFAULT 'none',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX error_log_company_created_idx ON plugin_magnora_7b37db9650.error_log (company_id, created_at DESC);

CREATE TABLE plugin_magnora_7b37db9650.gmail_account (
  company_id uuid PRIMARY KEY REFERENCES public.companies(id) ON DELETE CASCADE,
  email text,
  refresh_token_enc text,
  scopes text,
  status text NOT NULL DEFAULT 'not_connected',
  last_error text,
  connected_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE plugin_magnora_7b37db9650.oauth_pending (
  state text PRIMARY KEY,
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  user_id text,
  code_verifier text NOT NULL,
  redirect_uri text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
