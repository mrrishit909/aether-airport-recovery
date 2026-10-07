# AETHER: one command per job. Ports: web 8541, API 8540, Postgres 55540, mail sink 8542.
.PHONY: dev seed test e2e load-test agent-contract-test reset build typecheck openapi record

dev:        ## full stack in Docker: web, API, Postgres, mail sink, OpenTelemetry collector, generator
	docker compose up --build -d --wait
	@echo "web http://localhost:8541  api http://localhost:8540/openapi.json  mail http://localhost:8542"

seed:       ## regenerate the synthetic scenario + cost baseline, then load it (owner connection)
	node data/simulators/generate.ts
	node apps/api/src/migrate.ts && node apps/api/src/seed.ts --reset

test:       ## unit + agent + API contract tests with coverage (>= 85% on domain, agents, motion) against a throwaway Postgres
	docker compose --profile test run --rm --build test

agent-contract-test:  ## only the agent contract / routing / escalation / chaos tests (no database)
	npx vitest run packages/agents packages/domain

e2e:        ## Playwright against the static export (needs Google Chrome installed)
	node scripts/copy-fixtures.ts && npm run build -w @aether/web
	npx playwright test

load-test:  ## HTTP concurrency + WebSocket streams against a running API (start it with RATE_LIMIT=1000000)
	node tests/performance/load.ts http://127.0.0.1:8540 32 10 2000

reset:      ## drop all data and reseed
	docker compose down -v
	docker compose up --build -d --wait

build:      ## static export for GitHub Pages (base path = the projects site)
	NEXT_PUBLIC_BASE_PATH=/projects/aether-airport-recovery/demo npm run build -w @aether/web

typecheck:
	npx tsc -p . && (cd apps/web && npx tsc --noEmit -p .)

openapi:    ## write docs/openapi.json from the running route schemas
	node -e "import('./apps/api/src/server.ts').then(async (m) => { const app = await m.build({ logger: false }); await app.ready(); require('fs').writeFileSync('docs/openapi.json', JSON.stringify(app.swagger(), null, 1)); await app.close(); process.exit(0); })"

record:     ## 2-4 minute captioned demo recording (Playwright video -> docs/video/demo.mp4)
	node scripts/record-demo.ts
