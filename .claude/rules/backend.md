# Backend rules
- Every route declares an OpenAPI schema; `make openapi` regenerates docs/openapi.json and the API tests validate bodies against it.
- Mutations require Idempotency-Key (same key + same body replays; different body is 409). Consequential actions write the audit log.
- Tenant data goes through withTenant(); never query a tenant table outside it. The API role has no DELETE: superseded options are marked, not removed.
- Agent outputs are validated against the contract before persistence; the router never sends raw schedules or manifests to the opus tier.
- Run `npx vitest run apps/api` against the throwaway Postgres (docker compose --profile test) before returning.
