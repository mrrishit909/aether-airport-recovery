// Model routing, escalation, retries, circuit breaker, cache and a deterministic simulated provider.
//
// No real model is called anywhere in this repository. An application agent is a deterministic analyzer (domain code); the
// provider wraps it, charges it tokens by the size of what went in and came out at the configured price for its model alias,
// and simulates latency and provider failures. Routing, escalation and cost accounting are therefore real code paths exercised
// by tests, while the "reasoning" is a stand-in. See README "What is simulated".
import { ContractError, validateContract, type AgentResult, type Finding } from "./contract.ts";

export type ModelAlias = "haiku" | "sonnet" | "opus";
export type Effort = "low" | "medium" | "high";
export const TIERS: readonly ModelAlias[] = ["haiku", "sonnet", "opus"];

/** USD per million tokens (list prices as configured for the demo) and a latency model per alias. */
export const PRICES: Record<ModelAlias, { input: number; output: number; baseMs: number; msPerKTok: number }> = {
  haiku: { input: 1, output: 5, baseMs: 250, msPerKTok: 6 },
  sonnet: { input: 3, output: 15, baseMs: 600, msPerKTok: 14 },
  opus: { input: 15, output: 75, baseMs: 1400, msPerKTok: 30 },
};

/** ~4 characters per token on JSON; good enough for routing decisions and relative cost. */
export const tokens = (x: unknown) => Math.ceil(JSON.stringify(x ?? null).length / 4);
export const cost = (model: ModelAlias, inTok: number, outTok: number) => +((inTok * PRICES[model].input + outTok * PRICES[model].output) / 1e6).toFixed(6);

export function fnv1a(s: string) {
  let h = 0xcbf29ce484222325n;
  for (let i = 0; i < s.length; i++) { h ^= BigInt(s.charCodeAt(i)); h = (h * 0x100000001b3n) & 0xffffffffffffffffn; }
  return h.toString(16).padStart(16, "0");
}
/** Stable hash of any JSON value (keys sorted), for cache keys and result hashes. */
export function hashOf(v: unknown): string {
  const canon = (x: unknown): string => Array.isArray(x) ? `[${x.map(canon).join(",")}]`
    : x && typeof x === "object" ? `{${Object.keys(x as object).sort().map((k) => `${JSON.stringify(k)}:${canon((x as Record<string, unknown>)[k])}`).join(",")}}` : JSON.stringify(x ?? null);
  return fnv1a(canon(v));
}

export type AgentOutput<F extends Finding = Finding> = Pick<AgentResult<F>, "status" | "confidence" | "findings" | "assumptions" | "warnings"> & { evidence_refs?: string[] };

export interface AgentSpec<I, F extends Finding = Finding> {
  name: string;
  model: ModelAlias;
  effort: Effort;
  promptVersion: string;
  description: string;
  /** Below this confidence the narrow subproblem is escalated one tier (default 0.6). */
  minConfidence?: number;
  /** Provider failures tolerated before escalating (default 2 = "two attempts fail"). */
  maxAttempts?: number;
  deadlineMs?: number;
  /** What the stronger model receives on escalation: a reduced input, never the whole context. Default: the same input. */
  compact?: (input: I, previous: AgentResult<F>) => I;
  run: (input: I, ctx: { model: ModelAlias; effort: Effort }) => AgentOutput<F>;
}

export class ProviderError extends Error {
  code: "rate_limited" | "provider_error" | "timeout" | "circuit_open";
  constructor(code: ProviderError["code"], msg: string) { super(msg); this.code = code; }
}

export interface Fault { model?: ModelAlias; agent?: string; code: "rate_limited" | "provider_error" | "timeout"; remaining: number }

/** Appendix C row, as written by the browser sandbox and by the API. */
export interface Invocation {
  id: string; tenant_id: string | null; workflow_name: string; workflow_run_id: string; agent_name: string; model_alias: ModelAlias; effort: Effort;
  prompt_version: string; started_at: string; completed_at: string; input_tokens: number; output_tokens: number; estimated_cost_usd: number;
  latency_ms: number; retry_count: number; status: "success" | "partial" | "failed" | "cache_hit"; error_code: string | null; result_hash: string | null;
  escalated_from: ModelAlias | null;
}

export interface RuntimeEvent {
  type: "start" | "retry" | "escalate" | "done" | "failed" | "cache";
  agent: string; model: ModelAlias; attempt: number; message?: string; invocation?: Invocation;
}

export interface RuntimeOptions {
  tenant?: string | null;
  workflow: string;
  runId: string;
  /** 0 = no waiting (tests); 1 = simulated latency in full. The sandbox uses a fraction so packets are visible but quick. */
  latencyScale?: number;
  faults?: Fault[];
  onEvent?: (e: RuntimeEvent) => void;
  cache?: Map<string, AgentResult<Finding>>;
  seed?: number;
  /** Clock for started_at/completed_at (defaults to Date.now). */
  now?: () => number;
}

const sleep = (ms: number) => (ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve());

/** Per-alias circuit breaker: after `trip` consecutive failures the alias is skipped for `coolMs`. */
export class Breaker {
  private fails = new Map<ModelAlias, number>();
  private openUntil = new Map<ModelAlias, number>();
  private trip: number; private coolMs: number; private now: () => number;
  constructor(trip = 3, coolMs = 30_000, now: () => number = Date.now) { this.trip = trip; this.coolMs = coolMs; this.now = now; }
  open(m: ModelAlias) { return (this.openUntil.get(m) ?? 0) > this.now(); }
  ok(m: ModelAlias) { this.fails.set(m, 0); }
  fail(m: ModelAlias) { const n = (this.fails.get(m) ?? 0) + 1; this.fails.set(m, n); if (n >= this.trip) { this.openUntil.set(m, this.now() + this.coolMs); this.fails.set(m, 0); return true; } return false; }
  state() { return Object.fromEntries(TIERS.map((m) => [m, this.open(m) ? "open" : "closed"])); }
}

/**
 * The simulated provider plus the routing policy around it. One instance per workflow run.
 * invoke(): cache -> (circuit breaker -> attempts with backoff on 429/500/timeout) -> validate contract -> record invocation
 *           -> if confidence < minConfidence (or attempts exhausted) escalate the compact subproblem one tier, once.
 */
export class Runtime {
  invocations: Invocation[] = [];
  breaker: Breaker;
  private seq = 0;
  private faults: Fault[];
  opts: RuntimeOptions;
  constructor(opts: RuntimeOptions) { this.opts = opts; this.faults = opts.faults ?? []; this.breaker = new Breaker(3, 30_000, opts.now); }

  private now() { return (this.opts.now ?? Date.now)(); }
  private cache() { return this.opts.cache; }
  private fault(agent: string, model: ModelAlias): Fault | undefined {
    const f = this.faults.find((x) => x.remaining > 0 && (!x.model || x.model === model) && (!x.agent || x.agent === agent));
    if (f) f.remaining--;
    return f;
  }

  /** One provider call: tokens, simulated latency, fault injection, contract validation. */
  private async call<I, F extends Finding>(spec: AgentSpec<I, F>, model: ModelAlias, input: I, attempt: number, deadline: number): Promise<AgentResult<F>> {
    const inTok = tokens(input);
    const p = PRICES[model];
    const latency = Math.round(p.baseMs + (inTok / 1000) * p.msPerKTok * (spec.effort === "high" ? 2 : spec.effort === "medium" ? 1.3 : 1) * (1 + 0.15 * attempt));
    const f = this.fault(spec.name, model);
    const scale = this.opts.latencyScale ?? 0;
    if (f?.code === "timeout") { await sleep(Math.min(deadline, latency * 3) * scale); throw new ProviderError("timeout", `${model} did not answer within ${deadline} ms`); }
    await sleep(Math.min(latency, deadline) * scale);
    if (latency > deadline) throw new ProviderError("timeout", `${model} did not answer within ${deadline} ms`);
    if (f?.code === "rate_limited") throw new ProviderError("rate_limited", `${model}: 429 too many requests`);
    if (f?.code === "provider_error") throw new ProviderError("provider_error", `${model}: 500 upstream error`);
    const out = spec.run(input, { model, effort: spec.effort });
    const outTok = tokens(out);
    const res: AgentResult<F> = {
      agent: spec.name, run_id: `${this.opts.runId.slice(0, 36)}-${++this.seq}`.padEnd(8, "0"), status: out.status, confidence: out.confidence, findings: out.findings,
      evidence_refs: out.evidence_refs ?? [...new Set(out.findings.flatMap((x) => x.evidence))], assumptions: out.assumptions, warnings: out.warnings,
      metrics: { latency_ms: latency, input_tokens: inTok, output_tokens: outTok, estimated_cost_usd: cost(model, inTok, outTok) },
    };
    const bad = validateContract(res);
    if (bad.length) throw new ContractError(spec.name, bad);
    return res;
  }

  private record(spec: AgentSpec<unknown, Finding>, model: ModelAlias, startedAt: number, res: AgentResult<Finding> | null, retries: number, error: string | null, escalatedFrom: ModelAlias | null, status?: Invocation["status"]): Invocation {
    const inv: Invocation = {
      id: `${this.opts.runId}-${++this.seq}`, tenant_id: this.opts.tenant ?? null, workflow_name: this.opts.workflow, workflow_run_id: this.opts.runId, agent_name: spec.name, model_alias: model, effort: spec.effort,
      prompt_version: spec.promptVersion, started_at: new Date(startedAt).toISOString(), completed_at: new Date(this.now()).toISOString(),
      input_tokens: res?.metrics.input_tokens ?? 0, output_tokens: res?.metrics.output_tokens ?? 0, estimated_cost_usd: res?.metrics.estimated_cost_usd ?? 0,
      latency_ms: res?.metrics.latency_ms ?? 0, retry_count: retries, status: status ?? (res ? res.status : "failed"), error_code: error, result_hash: res ? hashOf({ f: res.findings, c: res.confidence }) : null, escalated_from: escalatedFrom,
    };
    this.invocations.push(inv);
    return inv;
  }

  async invoke<I, F extends Finding = Finding>(spec: AgentSpec<I, F>, input: I, escalatedFrom: ModelAlias | null = null, modelOverride?: ModelAlias): Promise<AgentResult<F>> {
    const emit = this.opts.onEvent ?? (() => {});
    const model = modelOverride ?? spec.model;
    const key = `${spec.name}:${spec.promptVersion}:${model}:${hashOf(input)}`;
    const hit = this.cache()?.get(key);
    const t0 = this.now();
    if (hit) {
      const inv = this.record(spec as unknown as AgentSpec<unknown, Finding>, model, t0, hit, 0, null, escalatedFrom, "cache_hit");
      inv.estimated_cost_usd = 0; inv.latency_ms = 0;
      emit({ type: "cache", agent: spec.name, model, attempt: 0, invocation: inv });
      return hit as AgentResult<F>;
    }
    const maxAttempts = spec.maxAttempts ?? 2, deadline = spec.deadlineMs ?? 20_000;
    let last: Error | null = null, res: AgentResult<F> | null = null, retries = 0;
    if (this.breaker.open(model)) {
      last = new ProviderError("circuit_open", `${model} circuit is open`);
    } else {
      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        emit({ type: attempt ? "retry" : "start", agent: spec.name, model, attempt, message: last?.message });
        try { res = await this.call(spec, model, input, attempt, deadline); this.breaker.ok(model); break; }
        catch (e) {
          last = e as Error; 
          if (e instanceof ContractError) break; // a malformed answer is not retried blindly; it escalates below
          const tripped = this.breaker.fail(model);
          retries++;
          if (tripped) { last = new ProviderError("circuit_open", `${model} circuit opened after repeated failures`); break; }
          await sleep(200 * 2 ** attempt * (this.opts.latencyScale ?? 0));
        }
      }
    }
    const code: string | null = last ? ((last as ProviderError).code ?? "invalid_contract") : null;
    const inv = this.record(spec as unknown as AgentSpec<unknown, Finding>, model, t0, res, retries, res ? null : code, escalatedFrom);
    const next = TIERS[TIERS.indexOf(model) + 1];
    const lowConfidence = res !== null && res.confidence < (spec.minConfidence ?? 0.6) && res.status !== "failed";
    // escalate once for low confidence; keep climbing only when the tier itself failed (429/500/timeout/circuit), never for a malformed answer
    if ((res === null || lowConfidence) && next && (escalatedFrom === null || (res === null && code !== "invalid_contract"))) {
      const narrow = res && spec.compact ? spec.compact(input, res) : input;
      emit({ type: "escalate", agent: spec.name, model: next, attempt: 0, message: res ? `confidence ${res.confidence.toFixed(2)} < ${spec.minConfidence ?? 0.6}: escalating the subproblem (${tokens(narrow)} tokens) to ${next}` : `${code} on ${model} after ${maxAttempts} attempts: escalating to ${next}` });
      const up = await this.invoke(spec, narrow, model, next);
      if (!res) return up;
      if (up.confidence < res.confidence) return up.status === "failed" ? res : res; // the stronger model did not help; keep the cheaper answer
      // merge: the stronger model answered the narrow subproblem; the cheaper model's confident findings stand
      const min = spec.minConfidence ?? 0.6;
      const byId = new Map(res.findings.filter((f) => f.confidence >= min).map((f) => [f.id, f]));
      for (const f of up.findings) byId.set(f.id, f);
      const findings = [...byId.values()];
      return { ...up, findings, evidence_refs: [...new Set([...res.evidence_refs, ...up.evidence_refs])], assumptions: [...new Set([...res.assumptions, ...up.assumptions])], warnings: up.warnings, confidence: Math.max(res.confidence, up.confidence) };
    }
    if (res) {
      this.cache()?.set(key, res as AgentResult<Finding>);
      emit({ type: "done", agent: spec.name, model, attempt: retries, invocation: inv });
      return res;
    }
    emit({ type: "failed", agent: spec.name, model, attempt: retries, message: last?.message, invocation: inv });
    throw last;
  }
}

// ---------- Appendix C dashboards: everything an internal cost view needs, from the invocation rows ----------
export interface CostSummary {
  runs: number; totalCostUsd: number; costPerRun: number; invocations: number;
  byAgent: { agent: string; model: ModelAlias; calls: number; inputTokens: number; outputTokens: number; costUsd: number; p50LatencyMs: number }[];
  byModel: Record<ModelAlias, { calls: number; inputTokens: number; outputTokens: number; costUsd: number }>;
  escalations: { haikuToSonnet: number; sonnetToOpus: number; rate: number };
  retries: { count: number; wastedMs: number; byError: Record<string, number> };
  cache: { hits: number; misses: number; hitRate: number; avoidedCostUsd: number };
  pareto: { agent: string; model: ModelAlias; costUsd: number; latencyMs: number; confidence: number | null }[];
}
export function summarize(rows: Invocation[], confidenceByInvocation: Map<string, number> = new Map()): CostSummary {
  const runs = new Set(rows.map((r) => r.workflow_run_id)).size;
  const total = rows.reduce((s, r) => s + r.estimated_cost_usd, 0);
  const groups = new Map<string, Invocation[]>();
  for (const r of rows) { const k = `${r.agent_name}|${r.model_alias}`; groups.set(k, [...(groups.get(k) ?? []), r]); }
  const p50 = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : 0; };
  const byAgent = [...groups.entries()].map(([k, g]) => ({ agent: k.split("|")[0], model: k.split("|")[1] as ModelAlias, calls: g.length, inputTokens: g.reduce((s, r) => s + r.input_tokens, 0), outputTokens: g.reduce((s, r) => s + r.output_tokens, 0), costUsd: +g.reduce((s, r) => s + r.estimated_cost_usd, 0).toFixed(6), p50LatencyMs: p50(g.map((r) => r.latency_ms)) }));
  const byModel = Object.fromEntries(TIERS.map((m) => { const g = rows.filter((r) => r.model_alias === m); return [m, { calls: g.length, inputTokens: g.reduce((s, r) => s + r.input_tokens, 0), outputTokens: g.reduce((s, r) => s + r.output_tokens, 0), costUsd: +g.reduce((s, r) => s + r.estimated_cost_usd, 0).toFixed(6) }]; })) as CostSummary["byModel"];
  const h2s = rows.filter((r) => r.escalated_from === "haiku").length, s2o = rows.filter((r) => r.escalated_from === "sonnet").length;
  const first = rows.filter((r) => !r.escalated_from).length;
  const retries = rows.reduce((s, r) => s + r.retry_count, 0);
  const byError: Record<string, number> = {};
  for (const r of rows) if (r.error_code) byError[r.error_code] = (byError[r.error_code] ?? 0) + 1;
  const hits = rows.filter((r) => r.status === "cache_hit");
  const avoided = hits.reduce((s, h) => { const prior = rows.find((r) => r.agent_name === h.agent_name && r.model_alias === h.model_alias && r.status !== "cache_hit"); return s + (prior?.estimated_cost_usd ?? 0); }, 0);
  return {
    runs, totalCostUsd: +total.toFixed(6), costPerRun: runs ? +(total / runs).toFixed(6) : 0, invocations: rows.length, byAgent, byModel,
    escalations: { haikuToSonnet: h2s, sonnetToOpus: s2o, rate: first ? +((h2s + s2o) / first).toFixed(3) : 0 },
    retries: { count: retries, wastedMs: rows.filter((r) => r.status === "failed").reduce((s, r) => s + r.latency_ms, 0), byError },
    cache: { hits: hits.length, misses: rows.length - hits.length, hitRate: rows.length ? +(hits.length / rows.length).toFixed(3) : 0, avoidedCostUsd: +avoided.toFixed(6) },
    pareto: rows.filter((r) => r.status !== "cache_hit").map((r) => ({ agent: r.agent_name, model: r.model_alias, costUsd: r.estimated_cost_usd, latencyMs: r.latency_ms, confidence: confidenceByInvocation.get(r.id) ?? null })),
  };
}
