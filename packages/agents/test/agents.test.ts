// Contract validation (incl. malformed outputs), model routing, escalation with a compact subproblem, retries and circuit
// breaker under 429/500/timeout, cache hits, and the cost summary.
import { describe, expect, it } from "vitest";
import { Ajv } from "ajv";
import { AGENT_RESULT_SCHEMA, Breaker, Runtime, cost, hashOf, summarize, tokens, validateContract, type AgentResult, type AgentSpec, type Finding, type RuntimeEvent } from "../src/index.ts";

const good: AgentResult = { agent: "x-agent", run_id: "run-00000001", status: "success", confidence: 0.8, findings: [{ id: "f1", type: "t", summary: "s", confidence: 0.5, evidence: ["e1"], entities: [], data: {} }], evidence_refs: ["e1"], assumptions: [], warnings: [], metrics: { latency_ms: 1, input_tokens: 2, output_tokens: 3, estimated_cost_usd: 0 } };
const ajv = new Ajv({ strict: false, allErrors: true });

describe("agent contract", () => {
  it("accepts a valid result and the hand checker agrees with the JSON schema on 12 malformed outputs", () => {
    expect(validateContract(good)).toEqual([]);
    expect(ajv.validate(AGENT_RESULT_SCHEMA, good)).toBe(true);
    const bad: unknown[] = [
      null, "text", { ...good, confidence: 1.5 }, { ...good, status: "ok" }, { ...good, agent: "Not Kebab" }, { ...good, extra: 1 },
      { ...good, findings: "none" }, { ...good, findings: [{ ...good.findings[0], confidence: -1 }] }, { ...good, findings: [{ ...good.findings[0], evidence: [1] }] },
      { ...good, metrics: { ...good.metrics, input_tokens: 1.5 } }, { ...good, metrics: { latency_ms: 1 } }, { ...good, warnings: ["x".repeat(501)] },
    ];
    for (const b of bad) { expect(validateContract(b).length, JSON.stringify(b).slice(0, 60)).toBeGreaterThan(0); expect(ajv.validate(AGENT_RESULT_SCHEMA, b), JSON.stringify(b).slice(0, 60)).toBe(false); }
  });
  it("hashes are order-independent and token/cost arithmetic is as configured", () => {
    expect(hashOf({ a: 1, b: [1, { c: 2 }] })).toBe(hashOf({ b: [1, { c: 2 }], a: 1 }));
    expect(tokens("abcdefgh")).toBe(3); // 10 chars with quotes
    expect(cost("opus", 1_000_000, 0)).toBe(15);
    expect(cost("haiku", 0, 1_000_000)).toBe(5);
  });
});

const spec = (over: Partial<AgentSpec<{ xs: number[] }>> = {}): AgentSpec<{ xs: number[] }> => ({
  name: "sum-agent", model: "haiku", effort: "low", promptVersion: "v1", description: "sums", minConfidence: 0.6, maxAttempts: 2, deadlineMs: 5000,
  run: (i, ctx) => ({ status: "success", confidence: ctx.model === "haiku" ? 0.4 : 0.9, findings: [{ id: "sum", type: "sum", summary: String(i.xs.reduce((a, b) => a + b, 0)), confidence: 0.9, evidence: i.xs.slice(0, 500).map(String), entities: [], data: { model: ctx.model } }], assumptions: [], warnings: [] }),
  compact: (i, prev) => ({ xs: i.xs.filter((x) => prev.evidence_refs.includes(String(x))).slice(0, 2) }),
  ...over,
});
const rt = (o: Partial<ConstructorParameters<typeof Runtime>[0]> = {}) => { let t = 0; const events: RuntimeEvent[] = []; const r = new Runtime({ workflow: "w", runId: "run-1", latencyScale: 0, now: () => (t += 100), onEvent: (e) => events.push(e), ...o }); return { r, events }; };

describe("routing and escalation", () => {
  it("routes a routine agent to the cheap model and records an Appendix C row", async () => {
    const { r } = rt();
    const s = spec({ run: (i) => ({ status: "success", confidence: 0.9, findings: [], assumptions: [], warnings: [] }) });
    const res = await r.invoke(s, { xs: [1, 2] });
    expect(res.status).toBe("success");
    expect(r.invocations).toHaveLength(1);
    expect(r.invocations[0]).toMatchObject({ agent_name: "sum-agent", model_alias: "haiku", effort: "low", status: "success", retry_count: 0, escalated_from: null, prompt_version: "v1" });
    expect(r.invocations[0].estimated_cost_usd).toBeGreaterThan(0);
    expect(r.invocations[0].result_hash).toMatch(/^[0-9a-f]{16}$/);
  });
  it("escalates a low-confidence answer one tier with a compact subproblem, not the whole context", async () => {
    const { r, events } = rt();
    const big = { xs: Array.from({ length: 2000 }, (_, i) => i) };
    const res = await r.invoke(spec(), big);
    expect(res.confidence).toBe(0.9);
    expect(res.findings[0].data.model).toBe("sonnet");
    const [first, second] = r.invocations;
    expect(first.model_alias).toBe("haiku"); expect(second.model_alias).toBe("sonnet"); expect(second.escalated_from).toBe("haiku");
    expect(second.input_tokens).toBeLessThan(first.input_tokens / 50); // the compact subproblem is two numbers, not two thousand
    expect(events.find((e) => e.type === "escalate")?.message).toMatch(/confidence 0.40 < 0.6/);
    // opus is never reached: one escalation at most per invocation
    expect(r.invocations.map((i) => i.model_alias)).toEqual(["haiku", "sonnet"]);
  });
  it("keeps the cheaper answer when the escalation is no better", async () => {
    const { r } = rt();
    const s = spec({ run: (i, ctx) => ({ status: "success", confidence: ctx.model === "haiku" ? 0.5 : 0.3, findings: [], assumptions: [], warnings: [] }) });
    const res = await r.invoke(s, { xs: [1] });
    expect(res.confidence).toBe(0.5);
    expect(r.invocations).toHaveLength(2);
  });
  it("a malformed answer is not retried blindly: it escalates once and fails loudly if still malformed", async () => {
    const { r } = rt();
    const s = spec({ run: () => ({ status: "success", confidence: 2, findings: [], assumptions: [], warnings: [] }) });
    await expect(r.invoke(s, { xs: [] })).rejects.toThrow(/invalid contract/);
    expect(r.invocations.map((i) => [i.model_alias, i.status, i.error_code])).toEqual([["haiku", "failed", "invalid_contract"], ["sonnet", "failed", "invalid_contract"]]);
  });
});

describe("chaos: provider failures", () => {
  it("retries a 429 then a 500 with backoff and succeeds on the same tier", async () => {
    const { r, events } = rt({ faults: [{ code: "rate_limited", remaining: 1 }, { code: "provider_error", remaining: 1 }] });
    const s = spec({ maxAttempts: 3, run: () => ({ status: "success", confidence: 0.9, findings: [], assumptions: [], warnings: [] }) });
    await r.invoke(s, { xs: [1] });
    expect(r.invocations[0]).toMatchObject({ retry_count: 2, status: "success", model_alias: "haiku" });
    expect(events.filter((e) => e.type === "retry").map((e) => e.message)).toEqual(["haiku: 429 too many requests", "haiku: 500 upstream error"]);
  });
  it("two timeouts exhaust the attempts and the subproblem moves one tier up", async () => {
    const { r, events } = rt({ faults: [{ code: "timeout", model: "haiku", remaining: 5 }] });
    const s = spec({ run: () => ({ status: "success", confidence: 0.9, findings: [], assumptions: [], warnings: [] }) });
    const res = await r.invoke(s, { xs: [1] });
    expect(res.status).toBe("success");
    expect(r.invocations.map((i) => [i.model_alias, i.status, i.error_code, i.retry_count])).toEqual([["haiku", "failed", "timeout", 2], ["sonnet", "success", null, 0]]);
    expect(events.find((e) => e.type === "escalate")?.message).toMatch(/timeout on haiku after 2 attempts/);
  });
  it("a slow answer past the deadline is a timeout", async () => {
    const { r } = rt();
    const s = spec({ deadlineMs: 1, run: () => ({ status: "success", confidence: 0.9, findings: [], assumptions: [], warnings: [] }) });
    await expect(r.invoke(s, { xs: [1] })).rejects.toThrow(/did not answer within 1 ms/);
    expect(r.invocations.map((i) => [i.model_alias, i.error_code])).toEqual([["haiku", "timeout"], ["sonnet", "timeout"], ["opus", "timeout"]]); // every tier tried once, then it fails loudly
  });
  it("the circuit opens after three consecutive failures and later calls skip the tier until it cools", async () => {
    const { r } = rt({ faults: [{ code: "provider_error", model: "sonnet", remaining: 10 }] });
    const s = spec({ model: "sonnet", maxAttempts: 4, run: () => ({ status: "success", confidence: 0.9, findings: [], assumptions: [], warnings: [] }) });
    const res = await r.invoke(s, { xs: [1] });
    expect(res.findings).toEqual([]);
    expect(r.invocations[0]).toMatchObject({ model_alias: "sonnet", error_code: "circuit_open", retry_count: 3 });
    expect(r.invocations[1].model_alias).toBe("opus");
    expect(r.breaker.state().sonnet).toBe("open");
    const again = await r.invoke(s, { xs: [2] });
    expect(again.status).toBe("success");
    expect(r.invocations[2]).toMatchObject({ model_alias: "sonnet", error_code: "circuit_open", retry_count: 0 });
    let t = 0; const b = new Breaker(2, 1000, () => t);
    expect(b.fail("haiku")).toBe(false); expect(b.fail("haiku")).toBe(true); expect(b.open("haiku")).toBe(true); t = 1001; expect(b.open("haiku")).toBe(false);
  });
  it("partial workflow completion: a failed branch does not take the others down", async () => {
    const { r } = rt({ faults: [{ code: "provider_error", agent: "b-agent", remaining: 10 }] });
    const ok = spec({ name: "a-agent", run: () => ({ status: "success", confidence: 0.9, findings: [], assumptions: [], warnings: [] }) });
    const bad = spec({ name: "b-agent", run: () => ({ status: "success", confidence: 0.9, findings: [], assumptions: [], warnings: [] }) });
    const settled = await Promise.allSettled([r.invoke(ok, { xs: [1] }), r.invoke(bad, { xs: [1] })]);
    expect(settled.map((s) => s.status)).toEqual(["fulfilled", "rejected"]);
    expect(r.invocations.filter((i) => i.agent_name === "b-agent").every((i) => i.status === "failed")).toBe(true);
  });
});

describe("cache and cost summary", () => {
  it("the same agent + prompt version + input is a cache hit that costs nothing", async () => {
    const cache = new Map<string, AgentResult<Finding>>();
    const { r, events } = rt({ cache });
    const s = spec({ run: () => ({ status: "success", confidence: 0.9, findings: [], assumptions: [], warnings: [] }) });
    await r.invoke(s, { xs: [1, 2, 3] });
    await r.invoke(s, { xs: [1, 2, 3] });
    await r.invoke({ ...s, promptVersion: "v2" }, { xs: [1, 2, 3] });
    expect(r.invocations.map((i) => i.status)).toEqual(["success", "cache_hit", "success"]);
    expect(r.invocations[1].estimated_cost_usd).toBe(0);
    expect(events.filter((e) => e.type === "cache")).toHaveLength(1);
    const sum = summarize(r.invocations);
    expect(sum.cache).toMatchObject({ hits: 1, misses: 2 });
    expect(sum.cache.avoidedCostUsd).toBe(r.invocations[0].estimated_cost_usd);
  });
  it("summarize reports cost per run, by agent and model, escalation rate and retry waste", async () => {
    const { r } = rt({ faults: [{ code: "timeout", model: "haiku", remaining: 2 }] });
    await r.invoke(spec({ run: () => ({ status: "success", confidence: 0.9, findings: [], assumptions: [], warnings: [] }) }), { xs: [1] }); // haiku x2 timeout -> sonnet
    await r.invoke(spec({ name: "other-agent", model: "opus", run: () => ({ status: "success", confidence: 0.9, findings: [], assumptions: [], warnings: [] }) }), { xs: [1] });
    const s = summarize(r.invocations);
    expect(s.runs).toBe(1); expect(s.invocations).toBe(3);
    expect(s.escalations).toEqual({ haikuToSonnet: 1, sonnetToOpus: 0, rate: 0.5 });
    expect(s.retries.count).toBe(2); expect(s.retries.byError).toEqual({ timeout: 1 });
    expect(s.byModel.opus.calls).toBe(1); expect(s.byAgent.find((a) => a.agent === "sum-agent" && a.model === "sonnet")?.calls).toBe(1);
    expect(s.totalCostUsd).toBeCloseTo(s.byModel.haiku.costUsd + s.byModel.sonnet.costUsd + s.byModel.opus.costUsd, 6);
    expect(s.pareto.every((p) => p.costUsd >= 0 && p.latencyMs >= 0)).toBe(true);
  });
});
