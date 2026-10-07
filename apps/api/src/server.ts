// AETHER API (one Fastify process standing in for the blueprint's gateway, ingestion, workflow/orchestrator, domain services and
// identity; see README "Not built, and why"). The multi-agent workflow runs in-process through packages/domain + packages/agents
// as two commands (analyze, optimize), persists findings, options and Appendix C agent_invocations per tenant, and approval is an
// explicit, audited human step.
import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import websocket from "@fastify/websocket";
import swagger from "@fastify/swagger";
import { randomBytes } from "node:crypto";
import { AGENT_RESULT_SCHEMA, summarize, type Fault, type Invocation } from "../../../packages/agents/src/index.ts";
import { analyze, dispatchMarkdown, optimize, uuidFor, type AnalysisResult, type Disruption, type RecoveryOption, type Recommendation, type Scenario, type WorkflowProgress } from "../../../packages/domain/src/index.ts";
import { audit, canonical, pool, sha256, withTenant } from "./db.ts";

interface Auth { org: string; slug: string; role: "viewer" | "operator" | "admin"; label: string }
declare module "fastify" { interface FastifyRequest { auth?: Auth; traceId: string; t0: bigint } }

class ApiError extends Error {
  status: number; code: string; details?: unknown;
  constructor(status: number, code: string, message: string, details?: unknown) { super(message); this.status = status; this.code = code; this.details = details; }
}

const Err = { type: "object", properties: { error: { type: "object", properties: { code: { type: "string" }, message: { type: "string" }, traceId: { type: "string" }, details: {} }, required: ["code", "message"] } }, required: ["error"] };
const Any = { type: "object", additionalProperties: true };
const Page = (item: object) => ({ type: "object", required: ["items"], properties: { items: { type: "array", items: item }, nextCursor: { type: ["string", "null"] } } });
const DisruptionS = { type: "object", required: ["id", "name", "triggerType", "status"], properties: { id: { type: "string", format: "uuid" }, name: { type: "string" }, triggerType: { type: "string", enum: ["thunderstorm", "runway_closure", "ground_stop"] }, triggerPayload: Any, status: { type: "string", enum: ["declared", "analyzed", "optimized", "approved"] }, createdAt: { type: ["string", "null"] }, lastRunId: { type: ["string", "null"] }, recommendation: { type: ["object", "null"], additionalProperties: true }, analysis: { type: ["object", "null"], additionalProperties: true } } };
const OptionS = { type: "object", required: ["id", "optionKey", "name", "status"], properties: { id: { type: "string", format: "uuid" }, scenarioId: { type: "string" }, optionKey: { type: "string" }, name: { type: "string" }, objectiveScore: { type: "number" }, passengerImpact: Any, operationalChanges: Any, solverMetadata: Any, strategy: Any, status: { type: "string" }, times: { type: "array", items: Any }, approval: { type: ["object", "null"], additionalProperties: true } } };
const idemHeader = { type: "object", properties: { "idempotency-key": { type: "string", minLength: 8, maxLength: 128 } }, required: ["idempotency-key"] };
const sec = [{ bearer: [] }];
const uuidish = (s: string) => /^[0-9a-f-]{8,36}$/.test(s);

/** Simple token bucket per credential (or IP for anonymous calls). Headers follow the IETF RateLimit draft names. */
function limiter(capacity: number, perSec: number) {
  const b = new Map<string, { tokens: number; at: number }>();
  return (key: string) => {
    const now = Date.now(), s = b.get(key) ?? { tokens: capacity, at: now };
    s.tokens = Math.min(capacity, s.tokens + ((now - s.at) / 1000) * perSec); s.at = now;
    const ok = s.tokens >= 1;
    if (ok) s.tokens -= 1;
    b.set(key, s);
    return { ok, remaining: Math.floor(s.tokens), resetS: Math.ceil((capacity - s.tokens) / perSec) };
  };
}

const iso = (t: unknown) => (t ? new Date(t as string).toISOString() : null);
const rowToDisruption = (x: Record<string, unknown>) => ({ id: x.id, name: x.name, triggerType: x.trigger_type, triggerPayload: x.trigger_payload, status: x.status, createdAt: iso(x.created_at), lastRunId: x.last_run_id ?? null, recommendation: x.recommendation ?? null, analysis: x.analysis ?? null });
const rowToOption = (x: Record<string, unknown>) => ({ id: x.id, scenarioId: x.scenario_id, optionKey: x.option_key, name: x.name, objectiveScore: Number(x.objective_score), passengerImpact: x.passenger_impact, operationalChanges: x.operational_changes, solverMetadata: x.solver_metadata, strategy: x.strategy, status: x.status, times: x.times, approval: x.approval ?? null });

export async function build(opts: { rateLimit?: number; logger?: boolean; latencyScale?: number; nodeCap?: number } = {}) {
  const app = Fastify({ logger: opts.logger ?? true, genReqId: () => randomBytes(8).toString("hex"), bodyLimit: 4 * 1024 * 1024 });
  const limit = limiter(opts.rateLimit ?? 120, (opts.rateLimit ?? 120) / 60);
  const metrics = new Map<string, { n: number; errors: number; lat: number[] }>();
  const streams = new Set<(m: unknown) => void>();       // live websocket senders, one set per process; messages carry the tenant they belong to
  let wsClients = 0;

  await app.register(swagger, {
    openapi: { openapi: "3.1.0", info: { title: "AETHER API", version: "1.0.0", description: "Airport disruption recovery API on a synthetic airport. Mutations need an Idempotency-Key header. Errors are {error:{code,message,traceId}}. Lists are paginated with ?limit and ?cursor (nextCursor). Model calls are simulated (deterministic analyzers charged tokens at a price table); the routing, escalation, gate solver and telemetry are real." },
      components: { securitySchemes: { bearer: { type: "http", scheme: "bearer" } }, schemas: { AgentResult: AGENT_RESULT_SCHEMA as unknown as object } }, servers: [{ url: "http://localhost:8540" }] },
  });
  await app.register(websocket);

  // ---- cross-cutting: trace context, auth, rate limit, CORS, security headers, metrics ----
  app.addHook("onRequest", async (req, reply) => {
    req.t0 = process.hrtime.bigint();
    const m = /^00-([0-9a-f]{32})-([0-9a-f]{16})-0[01]$/.exec(String(req.headers.traceparent ?? ""));
    req.traceId = m ? m[1] : randomBytes(16).toString("hex");
    reply.header("traceparent", `00-${req.traceId}-${randomBytes(8).toString("hex")}-01`);
    reply.header("x-content-type-options", "nosniff").header("referrer-policy", "no-referrer").header("cache-control", "no-store");
    const origin = String(req.headers.origin ?? "");
    const allowed = (process.env.CORS_ORIGINS ?? "http://localhost:8541,http://127.0.0.1:8541,http://localhost:3000").split(",");
    if (allowed.includes(origin)) reply.header("access-control-allow-origin", origin).header("vary", "origin").header("access-control-allow-headers", "authorization,content-type,idempotency-key,traceparent").header("access-control-expose-headers", "traceparent,ratelimit-limit,ratelimit-remaining,ratelimit-reset");
    if (req.method === "OPTIONS") return reply.code(204).send();
    const h = String(req.headers.authorization ?? "");
    if (h.startsWith("Bearer ")) {
      const a = await authenticate(h.slice(7));
      if (!a) throw new ApiError(401, "unauthenticated", "unknown token");
      req.auth = a;
    }
    const rl = limit(req.auth?.label ?? req.ip);
    reply.header("ratelimit-limit", opts.rateLimit ?? 120).header("ratelimit-remaining", rl.remaining).header("ratelimit-reset", rl.resetS);
    if (!rl.ok) { reply.header("retry-after", rl.resetS); throw new ApiError(429, "rate_limited", "too many requests"); }
  });
  app.addHook("onResponse", async (req, reply) => {
    const route = `${req.method} ${req.routeOptions.url ?? "unmatched"}`;
    const m = metrics.get(route) ?? { n: 0, errors: 0, lat: [] };
    m.n++; if (reply.statusCode >= 500) m.errors++;
    m.lat.push(Number(process.hrtime.bigint() - req.t0) / 1e6); if (m.lat.length > 2000) m.lat.shift();
    metrics.set(route, m);
    req.log.info({ traceId: req.traceId, route, status: reply.statusCode, tenant: req.auth?.slug }, "request");
  });
  app.setErrorHandler((e: Error & { statusCode?: number; validation?: unknown }, req, reply) => {
    if (e instanceof ApiError) return reply.code(e.status).send({ error: { code: e.code, message: e.message, traceId: req.traceId, details: e.details } });
    if (e.validation) return reply.code(400).send({ error: { code: "invalid_request", message: e.message, traceId: req.traceId } });
    req.log.error({ err: e, traceId: req.traceId }, "unhandled");
    return reply.code(e.statusCode && e.statusCode < 500 ? e.statusCode : 500).send({ error: { code: "internal", message: e.statusCode && e.statusCode < 500 ? e.message : "internal error", traceId: req.traceId } });
  });

  /** Token lookup with a 5-second cache (a revoked token stays usable for at most that long): every request and every WebSocket
   *  handshake would otherwise queue on the 10-connection pool. */
  const tokens = new Map<string, { a: Auth | null; at: number }>();
  async function authenticate(token: string): Promise<Auth | null> {
    const k = sha256(token), hit = tokens.get(k);
    if (hit && Date.now() - hit.at < 5000) return hit.a;
    const r = await pool.query("SELECT t.role, t.label, o.id, o.slug FROM api_tokens t JOIN organizations o ON o.id = t.organization_id WHERE t.token_sha256 = $1", [k]);
    const a = r.rows[0] ? { org: r.rows[0].id as string, slug: r.rows[0].slug as string, role: r.rows[0].role as Auth["role"], label: r.rows[0].label as string } : null;
    if (tokens.size > 500) tokens.clear();
    tokens.set(k, { a, at: Date.now() });
    return a;
  }
  const need = (req: FastifyRequest, role?: "operator"): Auth => {
    if (!req.auth) throw new ApiError(401, "unauthenticated", "Bearer token required");
    if (role && req.auth.role === "viewer") throw new ApiError(403, "forbidden", "viewer tokens cannot change anything");
    return req.auth;
  };
  /** Idempotency: same key + same body replays the stored response; same key + different body is a conflict. */
  async function idempotent(req: FastifyRequest, reply: FastifyReply, run: () => Promise<{ status: number; body: unknown }>) {
    const a = need(req, "operator");
    const key = String(req.headers["idempotency-key"]);
    const hash = sha256(JSON.stringify(req.body ?? null) + req.url);
    const prior = await withTenant(a.org, (c) => c.query("SELECT request_sha256, status, response FROM idempotency_keys WHERE key = $1", [key]));
    if (prior.rows[0]) {
      if (prior.rows[0].request_sha256 !== hash) throw new ApiError(409, "idempotency_conflict", "this Idempotency-Key was used with a different request");
      return reply.code(prior.rows[0].status).header("idempotent-replayed", "true").send(prior.rows[0].response);
    }
    const out = await run();
    await withTenant(a.org, (c) => c.query("INSERT INTO idempotency_keys (tenant_id, key, method, path, request_sha256, status, response) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING", [a.org, key, req.method, req.url, hash, out.status, out.body]));
    return reply.code(out.status).send(out.body);
  }
  const getDisruption = async (org: string, id: string) => {
    if (!uuidish(id)) throw new ApiError(400, "invalid_request", "bad id");
    const r = await withTenant(org, (c) => c.query("SELECT * FROM disruption_scenarios WHERE id::text LIKE $1 || '%' LIMIT 2", [id]));
    if (r.rows.length !== 1) throw new ApiError(404, "not_found", `no disruption ${id}`); // another tenant's rows are invisible, so they 404 too
    return r.rows[0] as Record<string, unknown>;
  };
  /** The tenant's airport as the domain package's Scenario (the same shape the static sandbox loads). */
  const loadScenario = (org: string): Promise<Scenario> => withTenant(org, async (c) => {
    const ap = (await c.query("SELECT * FROM airports")).rows[0];
    if (!ap) throw new ApiError(404, "not_found", "this tenant has no airport");
    const { planted, ...airport } = ap.config as Scenario["airport"] & { planted: Scenario["planted"] };
    const aircraft = (await c.query("SELECT * FROM aircraft ORDER BY tail")).rows.map((x) => ({ tail: x.tail, type: x.aircraft_type, cls: x.class, seats: x.seats, turnaroundMin: x.turnaround_min }));
    const gates = (await c.query("SELECT * FROM gates")).rows.map((x) => ({ id: x.gate_code, terminal: x.terminal, pos: x.constraints.pos, compatible: x.compatible_aircraft_types, remote: !!x.constraints.remote, maintenance: !!x.constraints.maintenance }));
    const flights = (await c.query("SELECT * FROM flights")).rows.map((x) => { const arr = x.kind === "arrival"; return { id: x.flight_no, kind: x.kind, tail: x.tail, other: x.other_flight_no, city: arr ? x.origin : x.destination, scheduled: iso(arr ? x.scheduled_arrival : x.scheduled_departure)!, estimated: iso(arr ? x.estimated_arrival : x.estimated_departure)!, gate: x.home_gate, pax: x.pax, remarks: x.remarks ?? "", lastOfDay: !!x.last_of_day }; })
      .sort((a, b) => (a.scheduled < b.scheduled ? -1 : a.scheduled > b.scheduled ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const itineraries = (await c.query("SELECT * FROM itineraries ORDER BY seq")).rows.map((x) => ({ id: `itn-${x.seq}`, inbound: x.inbound_flight_no, outbound: x.outbound_flight_no, pax: x.pax, mobility: x.mobility, minor: x.minor }));
    const resources = (await c.query("SELECT * FROM resources ORDER BY id")).rows.map((x) => ({ id: x.code, type: x.resource_type, status: x.status, location: x.location }));
    const weather = (await c.query("SELECT payload FROM weather_observations ORDER BY ts")).rows.map((x) => x.payload);
    return { version: "scenario-v1", seed: 0, airport, start: iso(ap.window_start)!, end: iso(ap.window_end)!, t0: iso(ap.t0)!, aircraft, gates, flights, itineraries, resources, weather, planted } as Scenario;
  });
  const publish = (org: string, m: unknown) => { for (const s of streams) s({ tenant: org, ...(m as object) }); };
  const persistInvocations = async (c: import("pg").PoolClient, org: string, runId: string, invs: Invocation[]) => {
    for (const i of invs) await c.query("INSERT INTO agent_invocations (id, tenant_id, workflow_name, workflow_run_id, agent_name, model_alias, effort, prompt_version, started_at, completed_at, input_tokens, output_tokens, estimated_cost_usd, latency_ms, retry_count, status, error_code, result_hash, escalated_from) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)",
      [uuidFor(4, Number.parseInt(sha256(i.id + runId).slice(0, 7), 16)), org, i.workflow_name, runId, i.agent_name, i.model_alias, i.effort, i.prompt_version, i.started_at, i.completed_at, i.input_tokens, i.output_tokens, i.estimated_cost_usd, i.latency_ms, i.retry_count, i.status, i.error_code, i.result_hash, i.escalated_from]);
  };

  // ---- routes ----
  app.get("/healthz", { schema: { hide: true } }, async () => { await pool.query("SELECT 1"); return { ok: true }; });
  app.get("/openapi.json", { schema: { hide: true } }, async () => app.swagger());
  app.get("/metrics", { schema: { hide: true } }, async (_, reply) => {
    const q = (a: number[], p: number) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : 0; };
    const lines = ["# TYPE aether_requests_total counter", "# TYPE aether_request_errors_total counter", "# TYPE aether_request_latency_ms summary"];
    for (const [r, m] of metrics) { const l = `route="${r}"`; lines.push(`aether_requests_total{${l}} ${m.n}`, `aether_request_errors_total{${l}} ${m.errors}`); for (const p of [0.5, 0.95, 0.99]) lines.push(`aether_request_latency_ms{${l},quantile="${p}"} ${q(m.lat, p).toFixed(2)}`); }
    lines.push(`aether_db_pool_total ${pool.totalCount}`, `aether_db_pool_idle ${pool.idleCount}`, `aether_ws_subscriptions ${wsClients}`);
    return reply.type("text/plain; version=0.0.4").send(lines.join("\n") + "\n");
  });

  app.get("/v1/airport/state", { schema: { tags: ["airport"], security: sec, summary: "The tenant's airport as the web app loads it (bounded: one airport, one three-hour window), plus the latest disruption and the approved option's gate assignments", querystring: { type: "object", properties: { simulate: { type: "string", enum: ["outage"] } } }, response: { 200: Any, 401: Err, 503: Err } } }, async (req) => {
    const a = need(req);
    if ((req.query as { simulate?: string }).simulate === "outage" || process.env.FAIL_FEED === "1") throw new ApiError(503, "feed_unavailable", "airport feed unavailable (simulated outage)");
    const sc = await loadScenario(a.org);
    const d = await withTenant(a.org, async (c) => {
      const x = (await c.query("SELECT * FROM disruption_scenarios ORDER BY updated_at DESC, created_at DESC LIMIT 1")).rows[0];
      const approved = x ? (await c.query("SELECT option_key FROM recovery_options WHERE scenario_id = $1 AND status = 'approved' LIMIT 1", [x.id])).rows[0] : null;
      return { latest: x ? rowToDisruption(x) : null, approvedOption: approved?.option_key ?? null };
    });
    return { ...sc, tenant: { slug: a.slug, name: a.slug }, disruption: d.latest, approvedOption: d.approvedOption };
  });

  app.post("/v1/disruptions", { schema: { tags: ["disruptions"], security: sec, summary: "Declare a disruption (a thunderstorm, a runway closure or a ground stop)", headers: idemHeader, body: { type: "object", required: ["name", "triggerType", "triggerPayload"], properties: { name: { type: "string", minLength: 3, maxLength: 200 }, triggerType: { type: "string", enum: ["thunderstorm", "runway_closure", "ground_stop"] }, triggerPayload: { type: "object", required: ["start", "durationMin"], properties: { start: { type: "string", format: "date-time" }, durationMin: { type: "integer", minimum: 5, maximum: 240 }, capacityFactor: { type: "number", minimum: 0, maximum: 1 } } } } }, response: { 201: DisruptionS, 400: Err, 401: Err, 403: Err, 409: Err } } }, async (req, reply) =>
    idempotent(req, reply, async () => {
      const a = need(req, "operator");
      const b = req.body as { name: string; triggerType: string; triggerPayload: Record<string, unknown> };
      const id = uuidFor(8, Number.parseInt(sha256(a.org + String(req.headers["idempotency-key"])).slice(0, 7), 16));
      const r = await withTenant(a.org, async (c) => { const x = await c.query("INSERT INTO disruption_scenarios (id, tenant_id, name, trigger_type, trigger_payload, created_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *", [id, a.org, b.name, b.triggerType, b.triggerPayload, a.label]); await audit(c, a.org, a.label, "disruption.declare", id, { name: b.name, triggerType: b.triggerType, triggerPayload: b.triggerPayload }, req.traceId); return x.rows[0]; });
      publish(a.org, { type: "disruption", id, name: b.name });
      return { status: 201, body: rowToDisruption(r) };
    }));

  app.get("/v1/disruptions", { schema: { tags: ["disruptions"], security: sec, querystring: { type: "object", properties: { status: { type: "string" }, limit: { type: "integer", minimum: 1, maximum: 200, default: 50 }, cursor: { type: "string" } } }, response: { 200: Page(DisruptionS), 401: Err } } }, async (req) => {
    const a = need(req);
    const q = req.query as { status?: string; limit: number; cursor?: string };
    const after = q.cursor ? Buffer.from(q.cursor, "base64url").toString() : "9999-12-31T00:00:00Z";
    const r = await withTenant(a.org, (c) => c.query("SELECT * FROM disruption_scenarios WHERE created_at < $1 AND ($2::text IS NULL OR status = $2) ORDER BY created_at DESC LIMIT $3", [after, q.status ?? null, q.limit + 1]));
    const items = r.rows.slice(0, q.limit).map(rowToDisruption);
    return { items, nextCursor: r.rows.length > q.limit ? Buffer.from(items.at(-1)!.createdAt as string).toString("base64url") : null };
  });
  app.get("/v1/disruptions/:id", { schema: { tags: ["disruptions"], security: sec, params: { type: "object", properties: { id: { type: "string" } } }, response: { 200: DisruptionS, 401: Err, 404: Err } } }, async (req) => rowToDisruption(await getDisruption(need(req).org, (req.params as { id: string }).id)));

  const faultsSchema = { type: "object", properties: { faults: { type: "array", maxItems: 8, items: { type: "object", required: ["code", "remaining"], properties: { code: { type: "string", enum: ["rate_limited", "provider_error", "timeout"] }, model: { type: "string", enum: ["haiku", "sonnet", "opus"] }, agent: { type: "string" }, remaining: { type: "integer", minimum: 1, maximum: 100 } } } } } };
  app.post("/v1/disruptions/:id/analyze", { schema: { tags: ["workflow"], security: sec, summary: "Run the analysis phase: weather agent, the deterministic constraint builder, then four analysts in parallel (flight risk, gates, passengers, ground ops)", headers: idemHeader, params: { type: "object", properties: { id: { type: "string" } } }, body: faultsSchema, response: { 201: { type: "object", additionalProperties: true, properties: { runId: { type: "string" }, status: { type: "string" }, findings: { type: "integer" }, costUsd: { type: "number" }, escalations: Any, capacity: { type: "array", items: Any }, baseline: { type: "array", items: Any }, summary: Any, invocations: { type: "array", items: Any } } }, 400: Err, 401: Err, 403: Err, 404: Err, 409: Err } } }, async (req, reply) =>
    idempotent(req, reply, async () => {
      const a = need(req, "operator");
      const d = await getDisruption(a.org, (req.params as { id: string }).id);
      if (d.status === "approved") throw new ApiError(409, "already_approved", "an option was already approved for this disruption");
      const faults = ((req.body ?? {}) as { faults?: Fault[] }).faults ?? [];
      const sc = await loadScenario(a.org);
      const runId = uuidFor(6, Number.parseInt(sha256(String(req.headers["idempotency-key"]) + a.org).slice(0, 7), 16));
      const disruption: Disruption = { id: d.id as string, name: d.name as string, triggerType: d.trigger_type as Disruption["triggerType"], triggerPayload: d.trigger_payload as Disruption["triggerPayload"] };
      publish(a.org, { type: "status", status: "analyzing", runId, disruption: d.id });
      const res = await analyze(sc, disruption, { runId, tenant: a.org, latencyScale: opts.latencyScale ?? 0.05, faults, onProgress: (p: WorkflowProgress) => publish(a.org, { type: "progress", ...p }) });
      const analysis = { capacity: res.capacity, baseline: res.baseline, findings: res.findings, warnings: res.warnings, rawTokens: res.rawTokens, status: res.status, ms: res.ms };
      const s = summarize(res.invocations);
      await withTenant(a.org, async (c) => {
        await persistInvocations(c, a.org, runId, res.invocations);
        await c.query("UPDATE disruption_scenarios SET status = 'analyzed', analysis = $2, last_run_id = $3, recommendation = NULL, updated_at = now() WHERE id = $1", [d.id, analysis, runId]);
        await audit(c, a.org, a.label, "disruption.analyze", d.id as string, { runId, status: res.status, findings: res.findings.length, costUsd: s.totalCostUsd, analysisHash: sha256(canonical(analysis)) }, req.traceId);
      });
      publish(a.org, { type: "status", status: "analyzed", runId, workflow: res.status });
      return { status: 201, body: { runId, status: res.status, findings: res.findings.length, costUsd: s.totalCostUsd, escalations: s.escalations, rawTokens: res.rawTokens, capacity: res.capacity, baseline: res.baseline, summary: { findings: res.findings, warnings: res.warnings }, invocations: res.invocations, ms: res.ms } };
    }));

  app.post("/v1/disruptions/:id/optimize", { schema: { tags: ["workflow"], security: sec, summary: "Run the optimization phase: the optimizer agent calls the gate solver for three strategies (plus the wait-for-gates reference), then the recovery synthesizer compares them on compact structured results only", headers: idemHeader, params: { type: "object", properties: { id: { type: "string" } } }, body: faultsSchema, response: { 201: { type: "object", additionalProperties: true, properties: { runId: { type: "string" }, options: { type: "array", items: OptionS }, recommendation: Any, costUsd: { type: "number" }, escalations: Any, synthesisInputTokens: { type: "integer" }, sensitivity: Any, invocations: { type: "array", items: Any } } }, 400: Err, 401: Err, 403: Err, 404: Err, 409: Err } } }, async (req, reply) =>
    idempotent(req, reply, async () => {
      const a = need(req, "operator");
      const d = await getDisruption(a.org, (req.params as { id: string }).id);
      if (d.status === "declared" || !d.analysis) throw new ApiError(409, "not_analyzed", "run analyze first");
      if (d.status === "approved") throw new ApiError(409, "already_approved", "an option was already approved for this disruption");
      const faults = ((req.body ?? {}) as { faults?: Fault[] }).faults ?? [];
      const sc = await loadScenario(a.org);
      const prev = d.analysis as { capacity: AnalysisResult["capacity"]; baseline: AnalysisResult["baseline"]; findings: AnalysisResult["findings"]; warnings: string[]; rawTokens: number; status: "complete" | "partial"; ms: number };
      const disruption: Disruption = { id: d.id as string, name: d.name as string, triggerType: d.trigger_type as Disruption["triggerType"], triggerPayload: d.trigger_payload as Disruption["triggerPayload"] };
      const runId = uuidFor(6, Number.parseInt(sha256(String(req.headers["idempotency-key"]) + a.org + "opt").slice(0, 7), 16));
      const analysis: AnalysisResult = { runId: d.last_run_id as string, disruption, capacity: prev.capacity, baseline: prev.baseline, findings: prev.findings, analysts: {} as AnalysisResult["analysts"], warnings: prev.warnings, invocations: [], rawTokens: prev.rawTokens, status: prev.status, ms: prev.ms };
      publish(a.org, { type: "status", status: "optimizing", runId, disruption: d.id });
      const res = await optimize(sc, analysis, { runId, tenant: a.org, latencyScale: opts.latencyScale ?? 0.05, faults, onProgress: (p: WorkflowProgress) => publish(a.org, { type: "progress", ...p }) });
      const s = summarize(res.invocations);
      const saved = await withTenant(a.org, async (c) => {
        await persistInvocations(c, a.org, runId, res.invocations);
        await c.query("UPDATE recovery_options SET status = 'superseded', updated_at = now() WHERE scenario_id = $1 AND status = 'proposed'", [d.id]);
        const out: ReturnType<typeof rowToOption>[] = [];
        for (const o of res.options) {
          const id = uuidFor(5, Number.parseInt(sha256(runId + o.id).slice(0, 7), 16));
          const x = await c.query("INSERT INTO recovery_options (id, scenario_id, tenant_id, objective_score, passenger_impact, operational_changes, solver_metadata, status, option_key, name, strategy, times) VALUES ($1,$2,$3,$4,$5,$6,$7,'proposed',$8,$9,$10,$11) RETURNING *",
            [id, d.id, a.org, o.objectiveScore, o.passengerImpact, o.operationalChanges, o.solverMetadata, o.id, o.name, o.strategy, JSON.stringify(o.times)]);
          out.push(rowToOption(x.rows[0]));
        }
        await c.query("UPDATE disruption_scenarios SET status = 'optimized', recommendation = $2, last_run_id = $3, updated_at = now() WHERE id = $1", [d.id, res.recommendation, runId]);
        await audit(c, a.org, a.label, "disruption.optimize", d.id as string, { runId, options: res.options.map((o) => [o.id, o.passengerImpact.misconnected, o.operationalChanges.totalDelayMin, o.solverMetadata.nodes, o.solverMetadata.optimal]), recommended: res.recommendation.recommended, costUsd: s.totalCostUsd, recommendationHash: sha256(canonical(res.recommendation)) }, req.traceId);
        return out;
      });
      publish(a.org, { type: "status", status: "optimized", runId });
      return { status: 201, body: { runId, options: saved, recommendation: res.recommendation, costUsd: s.totalCostUsd, escalations: s.escalations, synthesisInputTokens: res.synthesisInputTokens, sensitivity: res.sensitivity, invocations: res.invocations, ms: res.ms } };
    }));

  app.get("/v1/disruptions/:id/options", { schema: { tags: ["disruptions"], security: sec, summary: "The proposed recovery options (and the synthesizer's recommendation), paginated", params: { type: "object", properties: { id: { type: "string" } } }, querystring: { type: "object", properties: { limit: { type: "integer", minimum: 1, maximum: 50, default: 10 }, cursor: { type: "string" }, includeSuperseded: { type: "boolean", default: false } } }, response: { 200: { type: "object", required: ["items"], properties: { items: { type: "array", items: OptionS }, nextCursor: { type: ["string", "null"] }, recommendation: { type: ["object", "null"], additionalProperties: true } } }, 401: Err, 404: Err } } }, async (req) => {
    const a = need(req); const d = await getDisruption(a.org, (req.params as { id: string }).id);
    const q = req.query as { limit: number; cursor?: string; includeSuperseded?: boolean };
    const after = q.cursor ? Number(Buffer.from(q.cursor, "base64url").toString()) : -1;
    const r = await withTenant(a.org, (c) => c.query("SELECT *, row_number() OVER (ORDER BY created_at, option_key) AS rn FROM recovery_options WHERE scenario_id = $1 AND ($2 OR status <> 'superseded') ORDER BY created_at, option_key", [d.id, !!q.includeSuperseded]));
    const rows = r.rows.filter((x) => Number(x.rn) > after);
    const page = rows.slice(0, q.limit);
    return { items: page.map(rowToOption), nextCursor: rows.length > q.limit ? Buffer.from(String(page.at(-1)!.rn)).toString("base64url") : null, recommendation: d.recommendation ?? null };
  });

  app.post("/v1/options/:id/approve", { schema: { tags: ["workflow"], security: sec, summary: "Human approval gate: records who approved which option, supersedes the others, writes the gate assignments, audits it and returns the dispatch order (markdown)", headers: idemHeader, params: { type: "object", properties: { id: { type: "string" } } }, body: { type: "object", properties: { note: { type: "string", maxLength: 500 }, acknowledgePolicy: { type: "boolean" } } }, response: { 201: { type: "object", properties: { status: { type: "string" }, optionKey: { type: "string" }, approvedBy: { type: "string" }, at: { type: "string" }, planMarkdown: { type: "string" }, planHash: { type: "string" }, gateAssignments: { type: "integer" } } }, 400: Err, 401: Err, 403: Err, 404: Err, 409: Err } } }, async (req, reply) =>
    idempotent(req, reply, async () => {
      const a = need(req, "operator");
      const id = (req.params as { id: string }).id;
      if (!uuidish(id)) throw new ApiError(400, "invalid_request", "bad id");
      const o = (await withTenant(a.org, (c) => c.query("SELECT * FROM recovery_options WHERE id::text LIKE $1 || '%' LIMIT 2", [id]))).rows;
      if (o.length !== 1) throw new ApiError(404, "not_found", `no option ${id}`);
      const opt = o[0]; const d = (await withTenant(a.org, (c) => c.query("SELECT * FROM disruption_scenarios WHERE id = $1", [opt.scenario_id]))).rows[0];
      if (opt.status !== "proposed") throw new ApiError(409, "not_proposed", `option is ${opt.status}`);
      if (d.status === "approved") throw new ApiError(409, "already_approved", "an option was already approved for this disruption");
      const rec = d.recommendation as Recommendation;
      const b = (req.body ?? {}) as { note?: string; acknowledgePolicy?: boolean };
      const flags = rec.tradeoffs.find((t) => t.optionId === opt.option_key)?.policyFlags ?? [];
      if (flags.length && !b.acknowledgePolicy) throw new ApiError(409, "policy_unconfirmed", "this option carries policy flags the dispatcher must confirm; approve with acknowledgePolicy=true to proceed with them recorded", { flags });
      const at = new Date().toISOString();
      const full = { ...rowToOption(opt), id: opt.option_key, objectiveScore: Number(opt.objective_score) } as unknown as RecoveryOption;
      const option = { id: opt.option_key, name: opt.name, strategy: opt.strategy, objectiveScore: Number(opt.objective_score), passengerImpact: opt.passenger_impact, operationalChanges: opt.operational_changes, solverMetadata: opt.solver_metadata, times: opt.times, status: "approved" } as RecoveryOption; void full;
      const md = dispatchMarkdown(rec, option, a.label, at);
      const approval = { approvedBy: a.label, at, note: b.note ?? null, planHash: sha256(md), acknowledgedFlags: b.acknowledgePolicy ? flags : [], optionKey: opt.option_key };
      const changes = (opt.operational_changes as RecoveryOption["operationalChanges"]).gateChanges;
      const n = await withTenant(a.org, async (c) => {
        await c.query("UPDATE recovery_options SET status = 'approved', approval = $2, updated_at = now() WHERE id = $1", [opt.id, approval]);
        await c.query("UPDATE recovery_options SET status = 'rejected', updated_at = now() WHERE scenario_id = $1 AND status = 'proposed' AND id <> $2", [opt.scenario_id, opt.id]);
        await c.query("UPDATE disruption_scenarios SET status = 'approved', updated_at = now() WHERE id = $1", [opt.scenario_id]);
        let written = 0;
        for (const g of changes) {
          const f = (await c.query("SELECT id, scheduled_arrival, scheduled_departure FROM flights WHERE flight_no = $1", [g.flight])).rows[0];
          const gate = (await c.query("SELECT id FROM gates WHERE gate_code = $1", [g.to])).rows[0];
          if (!f || !gate) continue;
          const t = (opt.times as { id: string; estimated: string }[]).find((x) => x.id === g.flight)!;
          await c.query("INSERT INTO gate_assignments (flight_id, tenant_id, gate_id, start_ts, end_ts, assignment_source, option_id) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING", [f.id, a.org, gate.id, t.estimated, new Date(Date.parse(t.estimated) + 40 * 60e3).toISOString(), `option:${opt.option_key}`, opt.id]);
          written++;
        }
        await audit(c, a.org, a.label, "option.approve", opt.id as string, { ...approval, disruption: opt.scenario_id, gateChanges: changes.length, holds: (opt.operational_changes as RecoveryOption["operationalChanges"]).holds.length, misconnected: (opt.passenger_impact as RecoveryOption["passengerImpact"]).misconnected }, req.traceId);
        return written;
      });
      publish(a.org, { type: "approved", optionKey: opt.option_key, disruption: opt.scenario_id, approvedBy: a.label });
      return { status: 201, body: { status: "approved", optionKey: opt.option_key, approvedBy: a.label, at, planMarkdown: md, planHash: approval.planHash, gateAssignments: n } };
    }));

  app.get("/v1/disruptions/:id/agent-map", { schema: { tags: ["workflow"], security: sec, summary: "Every agent invocation of the disruption's analysis and optimization runs, with model, escalation, retries and cost", params: { type: "object", properties: { id: { type: "string" } } }, response: { 200: { type: "object", properties: { runIds: { type: "array", items: { type: "string" } }, invocations: { type: "array", items: Any }, summary: Any } }, 401: Err, 404: Err } } }, async (req) => {
    const a = need(req); const d = await getDisruption(a.org, (req.params as { id: string }).id);
    const runs = (await withTenant(a.org, (c) => c.query("SELECT DISTINCT workflow_run_id FROM agent_invocations WHERE workflow_run_id = $1 OR workflow_run_id IN (SELECT (audit_log.detail->>'runId')::uuid FROM audit_log WHERE target = $2 AND detail ? 'runId')", [d.last_run_id ?? "00000000-0000-4000-8000-000000000000", d.id]))).rows.map((x) => x.workflow_run_id as string);
    const rows = runs.length ? await withTenant(a.org, (c) => c.query("SELECT * FROM agent_invocations WHERE workflow_run_id = ANY($1::uuid[]) ORDER BY started_at, id", [runs])) : { rows: [] };
    const inv = rows.rows.map(rowToInvocation);
    return { runIds: runs, invocations: inv, summary: summarize(inv) };
  });
  app.get("/v1/costs", { schema: { tags: ["workflow"], security: sec, summary: "Appendix C dashboards across the tenant's runs: cost per run, tokens by agent/model, escalation rate, retry waste, cache", response: { 200: Any, 401: Err } } }, async (req) => {
    const a = need(req);
    const rows = await withTenant(a.org, (c) => c.query("SELECT * FROM agent_invocations ORDER BY started_at, id"));
    return summarize(rows.rows.map(rowToInvocation));
  });

  app.get("/v1/audit", { schema: { tags: ["admin"], security: sec, response: { 200: { type: "object", properties: { items: { type: "array", items: Any }, chainValid: { type: "boolean" } } }, 401: Err } } }, async (req) => {
    const a = need(req);
    const r = await withTenant(a.org, (c) => c.query("SELECT tenant_id, actor, action, target, detail, prev_hash, hash, at FROM audit_log ORDER BY id"));
    let prev = "genesis", ok = true;
    for (const x of r.rows) { if (x.prev_hash !== prev || sha256(prev + canonical({ tenant: x.tenant_id, actor: x.actor, action: x.action, target: x.target, detail: x.detail })) !== x.hash) ok = false; prev = x.hash; }
    return { items: r.rows.map((x) => ({ actor: x.actor, action: x.action, target: x.target, at: x.at, detail: x.detail })), chainValid: ok };
  });

  app.post("/v1/telemetry", { schema: { hide: true } }, async (req, reply) => {
    const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
    if (!body || typeof body !== "object") throw new ApiError(400, "invalid_request", "telemetry sample must be an object");
    await pool.query("INSERT INTO client_telemetry (sample) VALUES ($1)", [body]);
    return reply.code(204).send();
  });

  // live airport events: the server pushes stage/agent/approval events while commands run. The token is a query parameter (a
  // browser WebSocket cannot set headers) and only the caller's own tenant's messages are forwarded.
  app.get("/v1/airport/live", { websocket: true, schema: { hide: true } }, async (socket, req) => {
    const tok = String((req.query as { token?: string }).token ?? "");
    const who = tok ? await authenticate(tok) : null;
    if (!who) { socket.close(4401, "unauthenticated"); return; }
    const org = who.org;
    wsClients++;
    const send = (m: unknown) => { const { tenant, ...rest } = m as { tenant: string }; if (tenant !== org) return; try { socket.send(JSON.stringify(rest)); } catch { /* closed */ } };
    streams.add(send);
    socket.send(JSON.stringify({ type: "hello" }));
    socket.on("close", () => { streams.delete(send); wsClients--; });
  });
  return app;
}

const rowToInvocation = (x: Record<string, unknown>): Invocation => ({ id: x.id as string, tenant_id: x.tenant_id as string, workflow_name: x.workflow_name as string, workflow_run_id: x.workflow_run_id as string, agent_name: x.agent_name as string, model_alias: x.model_alias as Invocation["model_alias"], effort: x.effort as Invocation["effort"], prompt_version: x.prompt_version as string, started_at: new Date(x.started_at as string).toISOString(), completed_at: new Date(x.completed_at as string).toISOString(), input_tokens: Number(x.input_tokens), output_tokens: Number(x.output_tokens), estimated_cost_usd: Number(x.estimated_cost_usd), latency_ms: Number(x.latency_ms), retry_count: Number(x.retry_count), status: x.status as Invocation["status"], error_code: (x.error_code as string) ?? null, result_hash: (x.result_hash as string) ?? null, escalated_from: (x.escalated_from as Invocation["escalated_from"]) ?? null });
