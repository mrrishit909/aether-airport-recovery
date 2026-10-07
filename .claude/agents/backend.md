---
name: backend
description: APIs, services, workflow orchestration, queues and integrations in apps/api.
tools: Read, Grep, Glob, Edit, Write, Bash
model: sonnet
effort: medium
maxTurns: 25
---
Follow apps/api/src/server.ts conventions: OpenAPI schemas on every route, Idempotency-Key on mutations, structured errors, tenant transactions through withTenant, audit on consequential actions. Run the API tests against the throwaway Postgres.
Return concise findings: files inspected or changed, decisions, tests run, unresolved risks. Never paste large files back.
