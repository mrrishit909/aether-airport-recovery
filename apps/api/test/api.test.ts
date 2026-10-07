// API contract, authorization matrix, tenant isolation, idempotency, rate limits, the two-phase workflow through the API with
// persisted Appendix C telemetry, chaos faults, the approval gate and its audit, and the WebSocket stream. Every 2xx/4xx body is
// validated against the OpenAPI document the server publishes.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Ajv } from "ajv";
import pg from "pg";
import WebSocket from "ws";
import { migrate } from "../src/migrate.ts";
import { seed } from "../src/seed.ts";
import { build } from "../src/server.ts";
import { pool } from "../src/db.ts";

type App = Awaited<ReturnType<typeof build>>;
let app: App;
let spec: { paths: Record<string, Record<string, { responses: Record<string, { content?: { "application/json"?: { schema: object } } }> }>> };
const ajv = new Ajv({ strict: false, allErrors: true });
ajv.addFormat("uuid", /^[0-9a-f-]{36}$/).addFormat("date-time", (s: string) => !Number.isNaN(Date.parse(s)));
const OP = { authorization: "Bearer norrvik-dispatcher-demo" }, VIEW = { authorization: "Bearer norrvik-viewer-demo" }, OTHER = { authorization: "Bearer halden-dispatcher-demo" };
const STORM = { name: "Thunderstorm cell over the field", triggerType: "thunderstorm", triggerPayload: { start: "2026-10-07T09:00:00Z", durationMin: 45, capacityFactor: 0.4 } };

async function call(method: "GET" | "POST", url: string, headers: Record<string, string> = {}, body?: unknown, route?: string) {
  const r = await app.inject({ method, url, headers: body !== undefined ? { "content-type": "application/json", ...headers } : headers, payload: body !== undefined ? JSON.stringify(body) : undefined });
  const path = route ?? url.split("?")[0];
  const schema = spec.paths[path]?.[method.toLowerCase()]?.responses?.[String(r.statusCode)]?.content?.["application/json"]?.schema;
  if (schema && r.headers["content-type"]?.toString().includes("json")) {
    const ok = ajv.validate(schema, r.json());
    if (!ok) throw new Error(`${method} ${url} ${r.statusCode} does not match its OpenAPI schema: ${ajv.errorsText()}`);
  }
  return r;
}
const DECLARE = (key: string, h = OP, body: unknown = STORM) => call("POST", "/v1/disruptions", { ...h, "idempotency-key": key }, body);
const ANALYZE = (id: string, key: string, h = OP, body: unknown = {}) => call("POST", `/v1/disruptions/${id}/analyze`, { ...h, "idempotency-key": key }, body, "/v1/disruptions/{id}/analyze");
const OPTIMIZE = (id: string, key: string, h = OP, body: unknown = {}) => call("POST", `/v1/disruptions/${id}/optimize`, { ...h, "idempotency-key": key }, body, "/v1/disruptions/{id}/optimize");
let D = "";

beforeAll(async () => {
  await migrate();
  await seed(undefined, true);
  app = await build({ logger: false, rateLimit: 60, latencyScale: 0 });
  await app.ready();
  spec = app.swagger() as unknown as typeof spec;
}, 120_000);
afterAll(async () => { await app.close(); await pool.end(); });

describe("OpenAPI document", () => {
  it("is 3.1, covers the blueprint's contract and publishes the agent contract schema", () => {
    const s = app.swagger() as { openapi: string; paths: Record<string, unknown>; components: { schemas: Record<string, unknown> } };
    expect(s.openapi).toBe("3.1.0");
    for (const p of ["/v1/airport/state", "/v1/disruptions", "/v1/disruptions/{id}/analyze", "/v1/disruptions/{id}/optimize", "/v1/disruptions/{id}/options", "/v1/options/{id}/approve", "/v1/disruptions/{id}/agent-map", "/v1/costs", "/v1/audit"]) expect(Object.keys(s.paths)).toContain(p);
    expect(s.components.schemas.AgentResult).toBeTruthy();
  });
});

describe("authorization matrix and tenant isolation", () => {
  it("needs a token; unknown tokens are rejected; viewers read but cannot change", async () => {
    expect((await call("GET", "/v1/airport/state")).statusCode).toBe(401);
    expect((await call("GET", "/v1/disruptions", { authorization: "Bearer nope" })).statusCode).toBe(401);
    const st = await call("GET", "/v1/airport/state", VIEW);
    expect(st.statusCode).toBe(200);
    expect(st.json().planted.stormEnd).toBe("2026-10-07T09:45:00.000Z"); expect(st.json().airport.planted).toBeUndefined(); expect(st.json().flights).toHaveLength(90); expect(st.json().gates).toHaveLength(30); expect(st.json().itineraries).toHaveLength(225);
    expect((await DECLARE("viewer-declare-1", VIEW)).statusCode).toBe(403);
  });
  it("another tenant sees an empty airport and cannot see, analyze or guess Norrvik's disruptions or costs", async () => {
    const mine = await DECLARE("declare-iso-0001");
    expect(mine.statusCode).toBe(201); D = mine.json().id;
    expect((await call("GET", "/v1/airport/state", OTHER)).statusCode).toBe(404);   // no airport for that tenant
    expect((await call("GET", "/v1/disruptions", OTHER)).json().items).toHaveLength(0);
    expect((await call("GET", `/v1/disruptions/${D}`, OTHER, undefined, "/v1/disruptions/{id}")).statusCode).toBe(404);
    expect((await call("GET", `/v1/disruptions/${D.slice(0, 8)}`, OTHER, undefined, "/v1/disruptions/{id}")).statusCode).toBe(404);
    expect((await ANALYZE(D, "tenant-escape-1", OTHER)).statusCode).toBe(404);
    expect((await call("GET", "/v1/costs", OTHER)).json().invocations).toBe(0);
  });
  it("row-level security holds for a WHERE-less query and a cross-tenant insert, with an empty app.tenant", async () => {
    const c = new pg.Client({ connectionString: process.env.DATABASE_URL ?? "postgresql://aether_app:app-dev-only@127.0.0.1:55540/aether" });
    await c.connect();
    expect((await c.query("SELECT count(*)::int n FROM flights")).rows[0].n).toBe(0);
    await c.query("BEGIN"); await c.query("SELECT set_config('app.tenant', (SELECT id::text FROM organizations WHERE slug = 'norrvik'), true)"); await c.query("COMMIT");
    expect((await c.query("SELECT current_setting('app.tenant', true) s")).rows[0].s).toBe("");
    expect((await c.query("SELECT count(*)::int n FROM flights")).rows[0].n).toBe(0);
    const halden = (await c.query("SELECT id FROM organizations WHERE slug = 'halden'")).rows[0].id;
    await c.query("BEGIN"); await c.query("SELECT set_config('app.tenant', $1, true)", [halden]);
    expect((await c.query("SELECT count(*)::int n FROM agent_invocations")).rows[0].n).toBe(0);
    expect((await c.query("SELECT count(*)::int n FROM disruption_scenarios")).rows[0].n).toBe(0);
    await expect(c.query("INSERT INTO disruption_scenarios (id, tenant_id, name, trigger_type) SELECT gen_random_uuid(), id, 'x', 'thunderstorm' FROM organizations WHERE slug = 'norrvik'")).rejects.toThrow(/row-level security/);
    await c.query("ROLLBACK"); await c.end();
  });
});

describe("the workflow through the API: declare, analyze, optimize, approve", () => {
  it("analyze: weather on haiku, four analysts on sonnet, one escalation, persisted Appendix C rows", async () => {
    const r = await ANALYZE(D, "analyze-key-0001");
    expect(r.statusCode).toBe(201);
    const b = r.json();
    expect(b).toMatchObject({ status: "complete", findings: 35 });
    expect(b.costUsd).toBeLessThan(0.3);
    expect(b.escalations).toEqual({ haikuToSonnet: 0, sonnetToOpus: 1, rate: 0.2 });
    expect(b.invocations.map((i: { agent_name: string; model_alias: string }) => `${i.agent_name}@${i.model_alias}`)).toEqual(["weather-agent@haiku", "flight-risk-agent@sonnet", "gate-agent@sonnet", "passenger-agent@sonnet", "ground-ops-agent@sonnet", "passenger-agent@opus"]);
    const d = (await call("GET", `/v1/disruptions/${D}`, OP, undefined, "/v1/disruptions/{id}")).json();
    expect(d.status).toBe("analyzed"); expect(d.analysis.capacity.length).toBe(37); expect(d.analysis.findings).toHaveLength(35);
  });
  it("optimize requires analysis first; then three solver-backed options plus the reference are stored and a recommendation is made", async () => {
    const fresh = (await DECLARE("declare-iso-0002")).json().id;
    const early = await OPTIMIZE(fresh, "optimize-early-0001");
    expect(early.statusCode).toBe(409); expect(early.json().error.code).toBe("not_analyzed");
    const r = await OPTIMIZE(D, "optimize-key-0001");
    expect(r.statusCode).toBe(201);
    const b = r.json();
    expect(b.options.map((o: { optionKey: string }) => o.optionKey)).toEqual(["W", "A", "B", "C"]);
    expect(b.recommendation.recommended).toBe("B");
    expect(b.costUsd).toBeLessThan(0.5);
    const byKey = Object.fromEntries(b.options.map((o: { optionKey: string; passengerImpact: { misconnected: number } }) => [o.optionKey, o]));
    expect(byKey.B.passengerImpact.misconnected).toBeLessThan(byKey.W.passengerImpact.misconnected / 3);
    expect(byKey.A.solverMetadata.nodes).toBeLessThanOrEqual(8001); expect(byKey.W.solverMetadata).toMatchObject({ optimal: true, nodes: 0 });
    const page1 = await call("GET", `/v1/disruptions/${D}/options?limit=3`, VIEW, undefined, "/v1/disruptions/{id}/options");
    expect(page1.json().items).toHaveLength(3); expect(page1.json().nextCursor).toBeTruthy(); expect(page1.json().recommendation.recommended).toBe("B");
    const page2 = await call("GET", `/v1/disruptions/${D}/options?limit=3&cursor=${page1.json().nextCursor}`, VIEW, undefined, "/v1/disruptions/{id}/options");
    expect(page2.json().items).toHaveLength(1); expect(page2.json().nextCursor).toBeNull();
    const m = (await call("GET", `/v1/disruptions/${D}/agent-map`, OP, undefined, "/v1/disruptions/{id}/agent-map")).json();
    expect(m.runIds.length).toBeGreaterThanOrEqual(1);
    expect(m.invocations.some((i: { agent_name: string; model_alias: string }) => i.agent_name === "recovery-synthesizer" && i.model_alias === "opus")).toBe(true);
    expect((await call("GET", `/v1/disruptions/${D}/agent-map`, OTHER, undefined, "/v1/disruptions/{id}/agent-map")).statusCode).toBe(404);
    const costs = (await call("GET", "/v1/costs", OP)).json();
    expect(costs.byModel.opus.calls).toBe(2); expect(costs.runs).toBeGreaterThanOrEqual(2);
  });
  it("requires an Idempotency-Key, replays the same request, rejects a reused key with a different body", async () => {
    expect((await call("POST", "/v1/disruptions", OP, STORM)).statusCode).toBe(400);
    const again = await ANALYZE(D, "analyze-key-0001");
    expect(again.statusCode).toBe(201); expect(again.headers["idempotent-replayed"]).toBe("true");
    expect((await ANALYZE(D, "analyze-key-0001", OP, { faults: [{ code: "timeout", remaining: 1 }] })).statusCode).toBe(409);
    const n0 = (await call("GET", "/v1/costs", OP)).json().runs;
    await ANALYZE(D, "analyze-key-0001");
    expect((await call("GET", "/v1/costs", OP)).json().runs).toBe(n0); // the replay did not add a run
  });
  it("chaos through the API: a provider outage on one analyst gives a partial analysis, and the optimizer still produces plans", async () => {
    const id = (await DECLARE("declare-chaos-0001")).json().id;
    const r = await ANALYZE(id, "analyze-chaos-0001", OP, { faults: [{ code: "provider_error", agent: "ground-ops-agent", remaining: 50 }] });
    expect(r.statusCode).toBe(201); expect(r.json().status).toBe("partial");
    expect(r.json().summary.findings.some((f: { type: string }) => f.type === "resource_peak")).toBe(false);
    const o = await OPTIMIZE(id, "optimize-chaos-0001");
    expect(o.statusCode).toBe(201); expect(o.json().recommendation.recommended).toBe("B");
    const m = (await call("GET", `/v1/disruptions/${id}/agent-map`, OP, undefined, "/v1/disruptions/{id}/agent-map")).json();
    expect(m.summary.retries.byError.provider_error).toBeGreaterThanOrEqual(2);
  });
  it("approval is gated on policy flags, operator-only, writes gate assignments, and is audited with a valid hash chain", async () => {
    const opts = (await call("GET", `/v1/disruptions/${D}/options?limit=10`, OP, undefined, "/v1/disruptions/{id}/options")).json();
    const B = opts.items.find((o: { optionKey: string }) => o.optionKey === "B");
    const blocked = await call("POST", `/v1/options/${B.id}/approve`, { ...OP, "idempotency-key": "approve-key-0001" }, {}, "/v1/options/{id}/approve");
    expect(blocked.statusCode).toBe(409); expect(blocked.json().error.code).toBe("policy_unconfirmed");
    expect(blocked.json().error.details.flags.length).toBeGreaterThan(0);
    expect((await call("POST", `/v1/options/${B.id}/approve`, { ...VIEW, "idempotency-key": "approve-key-0002" }, { acknowledgePolicy: true }, "/v1/options/{id}/approve")).statusCode).toBe(403);
    expect((await call("POST", `/v1/options/${B.id}/approve`, { ...OTHER, "idempotency-key": "approve-key-0003" }, { acknowledgePolicy: true }, "/v1/options/{id}/approve")).statusCode).toBe(404);
    const ok = await call("POST", `/v1/options/${B.id}/approve`, { ...OP, "idempotency-key": "approve-key-0004" }, { acknowledgePolicy: true, note: "assistance for 2 vulnerable cohorts arranged" }, "/v1/options/{id}/approve");
    expect(ok.statusCode).toBe(201);
    expect(ok.json().gateAssignments).toBeGreaterThan(5);
    expect(ok.json().planMarkdown).toContain("# Dispatch order: option B");
    const after = (await call("GET", `/v1/disruptions/${D}/options?limit=10`, OP, undefined, "/v1/disruptions/{id}/options")).json().items;
    expect(Object.fromEntries(after.map((o: { optionKey: string; status: string }) => [o.optionKey, o.status]))).toEqual({ W: "rejected", A: "rejected", B: "approved", C: "rejected" });
    expect((await call("GET", `/v1/disruptions/${D}`, OP, undefined, "/v1/disruptions/{id}")).json().status).toBe("approved");
    const again = await call("POST", `/v1/options/${B.id}/approve`, { ...OP, "idempotency-key": "approve-key-0005" }, { acknowledgePolicy: true }, "/v1/options/{id}/approve");
    expect(again.statusCode).toBe(409);
    expect((await ANALYZE(D, "analyze-after-0001")).statusCode).toBe(409);
    const state = (await call("GET", "/v1/airport/state", OP)).json();
    expect(state.approvedOption).toBe("B");
    const audit = (await call("GET", "/v1/audit", OP)).json();
    expect(audit.chainValid).toBe(true);
    expect(audit.items.map((i: { action: string }) => i.action)).toEqual(expect.arrayContaining(["disruption.declare", "disruption.analyze", "disruption.optimize", "option.approve"]));
    const approve = audit.items.find((i: { action: string }) => i.action === "option.approve");
    expect(approve.detail).toMatchObject({ approvedBy: "norrvik-dispatcher-demo", optionKey: "B", misconnected: B.passengerImpact.misconnected });
    expect(approve.detail.planHash).toMatch(/^[0-9a-f]{64}$/);
    expect((await call("GET", "/v1/audit", OTHER)).json().items).toHaveLength(0);
  });
  it("declares disruptions with validation and pagination; a malformed payload is refused", async () => {
    expect((await DECLARE("declare-bad-0001", OP, { name: "x", triggerType: "meteor", triggerPayload: {} })).statusCode).toBe(400);
    expect((await DECLARE("declare-bad-0002", OP, { name: "Runway closure", triggerType: "runway_closure", triggerPayload: { start: "2026-10-07T09:10:00Z", durationMin: 1 } })).statusCode).toBe(400);
    const list = await call("GET", "/v1/disruptions?limit=2", OP, undefined, "/v1/disruptions");
    expect(list.json().items).toHaveLength(2); expect(list.json().nextCursor).toBeTruthy();
    expect((await call("GET", "/v1/disruptions?status=approved", OP, undefined, "/v1/disruptions")).json().items).toHaveLength(1);
  });
  it("a simulated feed outage is a structured 503; trace ids propagate; 429 carries RateLimit headers", async () => {
    const o = await call("GET", "/v1/airport/state?simulate=outage", { ...OP, traceparent: "00-0123456789abcdef0123456789abcdef-0123456789abcdef-01" }, undefined, "/v1/airport/state");
    expect(o.statusCode).toBe(503); expect(o.json().error).toMatchObject({ code: "feed_unavailable", traceId: "0123456789abcdef0123456789abcdef" });
    expect(o.headers.traceparent).toMatch(/^00-0123456789abcdef0123456789abcdef-/);
    let limited = false;
    for (let i = 0; i < 80 && !limited; i++) { const r = await app.inject({ method: "GET", url: "/healthz", headers: { authorization: "Bearer halden-dispatcher-demo" } }); if (r.statusCode === 429) { limited = true; expect(r.headers["retry-after"]).toBeTruthy(); expect(r.headers["ratelimit-remaining"]).toBe("0"); } }
    expect(limited).toBe(true);
  });
  it("streams workflow progress over the WebSocket to the caller's tenant only", async () => {
    await app.listen({ port: 0, host: "127.0.0.1" });
    const port = (app.server.address() as { port: number }).port;
    const mine: { type: string; stage?: string }[] = [], theirs: unknown[] = [];
    const open = (token: string, into: unknown[]) => new Promise<WebSocket>((ok) => { const ws = new WebSocket(`ws://127.0.0.1:${port}/v1/airport/live?token=${token}`); ws.on("message", (m) => into.push(JSON.parse(String(m)))); ws.on("open", () => ok(ws)); });
    const w1 = await open("norrvik-viewer-demo", mine), w2 = await open("halden-dispatcher-demo", theirs);
    const bad = new WebSocket(`ws://127.0.0.1:${port}/v1/airport/live?token=nope`); const closed = await new Promise<number>((ok) => bad.on("close", (code) => ok(code)));
    expect(closed).toBe(4401);
    await expect.poll(() => mine.length).toBeGreaterThan(0);
    const id = (await DECLARE("declare-ws-0001")).json().id;
    await ANALYZE(id, "analyze-ws-0001");
    await new Promise((r) => setTimeout(r, 150));
    w1.close(); w2.close();
    expect(mine[0]).toEqual({ type: "hello" });
    expect(mine.filter((m) => m.type === "progress").map((m) => m.stage)).toEqual(expect.arrayContaining(["weather", "constraints", "analyze"]));
    expect(mine.at(-1)).toMatchObject({ type: "status", status: "analyzed" });
    expect(theirs).toEqual([{ type: "hello" }]); // nothing from the other tenant leaks
  });
});
