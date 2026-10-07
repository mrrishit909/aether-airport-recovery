# Database rules
- Migrations are additive, numbered, applied once (apps/api/src/migrate.ts). Rollback is forward-fix.
- Tenant-owned tables: tenant_id NOT NULL, RLS enabled, policy `tenant_id = NULLIF(current_setting('app.tenant', true), '')::uuid`.
- The API role (aether_app) never gets DELETE on audit_log or agent_invocations.
- Seeds are idempotent and load only data/fixtures (synthetic).
