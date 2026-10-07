-- AETHER domain tables (blueprint 02 section 7) plus Appendix C agent telemetry, with tenant_id, audit timestamps and
-- row-level security on everything that belongs to one organization. (+) marks a column the blueprint's DDL does not have.
CREATE TABLE airports (                                       -- (+) one airport per tenant: operating rules the constraint builder reads
  tenant_id UUID PRIMARY KEY REFERENCES organizations(id),
  code TEXT NOT NULL, name TEXT NOT NULL, config JSONB NOT NULL, window_start TIMESTAMPTZ NOT NULL, window_end TIMESTAMPTZ NOT NULL, t0 TIMESTAMPTZ NOT NULL
);

CREATE TABLE aircraft (                                       -- (+)
  tenant_id UUID NOT NULL REFERENCES organizations(id),
  tail TEXT NOT NULL, aircraft_type TEXT NOT NULL, class TEXT NOT NULL CHECK (class IN ('regional','narrow','wide')), seats INT NOT NULL, turnaround_min INT NOT NULL,
  PRIMARY KEY (tenant_id, tail)
);

CREATE TABLE flights (
  id UUID PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES organizations(id),       -- (+)
  flight_no TEXT NOT NULL,
  origin TEXT,
  destination TEXT,
  scheduled_arrival TIMESTAMPTZ,
  scheduled_departure TIMESTAMPTZ,
  estimated_arrival TIMESTAMPTZ,
  estimated_departure TIMESTAMPTZ,
  aircraft_type TEXT,
  status TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('arrival','departure')), -- (+)
  tail TEXT NOT NULL, other_flight_no TEXT NOT NULL, home_gate TEXT NOT NULL, pax INT NOT NULL, remarks TEXT, last_of_day BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE (tenant_id, flight_no)
);
CREATE INDEX flights_tenant ON flights (tenant_id, scheduled_arrival, scheduled_departure);

CREATE TABLE gates (
  id UUID PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES organizations(id),       -- (+)
  terminal TEXT,
  gate_code TEXT NOT NULL,                                    -- unique per tenant (the blueprint's global UNIQUE would forbid a second airport)
  compatible_aircraft_types TEXT[],
  constraints JSONB,                                          -- remote, maintenance, position
  UNIQUE (tenant_id, gate_code)
);

CREATE TABLE gate_assignments (
  flight_id UUID REFERENCES flights(id),
  tenant_id UUID NOT NULL REFERENCES organizations(id),       -- (+)
  gate_id UUID REFERENCES gates(id),
  start_ts TIMESTAMPTZ,
  end_ts TIMESTAMPTZ,
  assignment_source TEXT,                                     -- 'schedule' or 'option:<id>' once a dispatcher approves
  option_id UUID,                                             -- (+)
  PRIMARY KEY (flight_id, start_ts)
);

CREATE TABLE itineraries (                                    -- (+) connecting passengers, grouped by pair of flights
  id UUID PRIMARY KEY, tenant_id UUID NOT NULL REFERENCES organizations(id),
  seq INT NOT NULL, inbound_flight_no TEXT NOT NULL, outbound_flight_no TEXT NOT NULL, pax INT NOT NULL, mobility BOOLEAN NOT NULL, minor BOOLEAN NOT NULL
);

CREATE TABLE resources (
  id UUID PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES organizations(id),       -- (+)
  resource_type TEXT,
  location TEXT,
  status TEXT,
  capabilities JSONB,
  code TEXT                                                   -- (+) "TUG-3"
);

CREATE TABLE weather_observations (                           -- (+) the feed the weather agent reads
  tenant_id UUID NOT NULL REFERENCES organizations(id), ts TIMESTAMPTZ NOT NULL, payload JSONB NOT NULL, PRIMARY KEY (tenant_id, ts)
);

CREATE TABLE disruption_scenarios (
  id UUID PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES organizations(id),       -- (+)
  name TEXT,
  trigger_type TEXT,
  trigger_payload JSONB,
  created_at TIMESTAMPTZ DEFAULT now(),
  status TEXT NOT NULL DEFAULT 'declared' CHECK (status IN ('declared','analyzed','optimized','approved')), -- (+)
  analysis JSONB,                                             -- (+) the analysis phase: capacity curve, findings, warnings
  recommendation JSONB,                                       -- (+) the synthesizer's structured output
  last_run_id UUID, created_by TEXT, updated_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX disruption_tenant_created ON disruption_scenarios (tenant_id, created_at DESC);

CREATE TABLE recovery_options (
  id UUID PRIMARY KEY,
  scenario_id UUID REFERENCES disruption_scenarios(id),
  tenant_id UUID NOT NULL REFERENCES organizations(id),       -- (+)
  objective_score DOUBLE PRECISION,
  passenger_impact JSONB,
  operational_changes JSONB,
  solver_metadata JSONB,
  status TEXT,
  option_key TEXT NOT NULL, name TEXT NOT NULL, strategy JSONB, times JSONB,   -- (+)
  approval JSONB, created_at TIMESTAMPTZ DEFAULT now(), updated_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX recovery_options_scenario ON recovery_options (scenario_id);

-- Appendix C, as written
CREATE TABLE agent_invocations (
  id UUID PRIMARY KEY,
  tenant_id UUID,
  workflow_name TEXT NOT NULL,
  workflow_run_id UUID NOT NULL,
  agent_name TEXT NOT NULL,
  model_alias TEXT NOT NULL,
  effort TEXT,
  prompt_version TEXT,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  input_tokens BIGINT,
  output_tokens BIGINT,
  estimated_cost_usd NUMERIC,
  latency_ms BIGINT,
  retry_count INT DEFAULT 0,
  status TEXT,
  error_code TEXT,
  result_hash TEXT,
  escalated_from TEXT                                         -- (+) model alias this call was escalated from
);
CREATE INDEX idx_agent_invocations_run ON agent_invocations(workflow_run_id, started_at);
CREATE INDEX idx_agent_invocations_cost ON agent_invocations(agent_name, model_alias, started_at);

CREATE TABLE client_telemetry (                                -- (+) browser Web Vitals / FPS samples
  id BIGSERIAL PRIMARY KEY, at TIMESTAMPTZ DEFAULT now(), sample JSONB NOT NULL
);

-- row-level security: the API connects as aether_app (not the owner) and sets app.tenant per transaction
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'aether_app') THEN CREATE ROLE aether_app LOGIN PASSWORD 'app-dev-only'; END IF;
END $$;
GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA public TO aether_app;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO aether_app;
REVOKE UPDATE, DELETE ON audit_log FROM aether_app;
REVOKE UPDATE, DELETE ON agent_invocations FROM aether_app;
DO $$ DECLARE t TEXT; BEGIN
  FOREACH t IN ARRAY ARRAY['airports','aircraft','flights','gates','gate_assignments','itineraries','resources','weather_observations','disruption_scenarios','recovery_options','agent_invocations','audit_log','idempotency_keys'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id = NULLIF(current_setting(''app.tenant'', true), '''')::uuid) WITH CHECK (tenant_id = NULLIF(current_setting(''app.tenant'', true), '''')::uuid)', t);
  END LOOP;
END $$;
