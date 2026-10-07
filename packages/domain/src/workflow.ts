// The AETHER application workflow (blueprint section 2), as code:
//   telemetry + schedules -> weather agent (haiku) -> deterministic constraint builder -> four risk agents in parallel (sonnet)
//   -> optimizer agent (sonnet, OR solver) -> recovery synthesizer (opus, compact options only) -> dispatcher approval.
// Runs unchanged in a Web Worker (public sandbox) and in the API (persisted, audited), as two phases: analyze and optimize.
import { Runtime, tokens, type AgentResult, type AgentSpec, type Fault, type Finding, type Invocation, type RuntimeEvent } from "@aether/agents";
import { applyDisruption, refreshPaxSummary, flightRiskAgent, gateAgent, groundOpsAgent, optimizerAgent, passengerAgent, weatherAgent, type GateInput, type GroundInput, type OptimizeInput, type PaxInput, type RiskInput, type Sensitivity, type WeatherInput } from "./analysis.ts";
import { noActionTimes, propagate } from "./ops.ts";
import { recommendationFinding, synthesize, type CompactOption, type SynthesisInput } from "./synthesis.ts";
import type { CapacityBucket, Disruption, FlightTimes, RecoveryOption, Recommendation, Scenario } from "./types.ts";

export const WORKFLOW_VERSION = "recover-v1";
export const DEFAULT_DISRUPTION = (sc: Pick<Scenario, "t0" | "planted">): Disruption => ({ id: "storm-0900", name: "Thunderstorm cell over the field", triggerType: "thunderstorm", triggerPayload: { start: sc.t0, durationMin: Math.round((Date.parse(sc.planted.stormEnd) - Date.parse(sc.planted.stormStart)) / 60e3), capacityFactor: sc.planted.capacityFactor } });

const sonnet = <I>(name: string, description: string, run: AgentSpec<I>["run"], extra: Partial<AgentSpec<I>> = {}): AgentSpec<I> => ({ name, model: "sonnet", effort: "medium", promptVersion: "v1", description, minConfidence: 0.6, maxAttempts: 2, deadlineMs: 20_000, run, ...extra });
const ok = (r: { findings: Finding[]; confidence: number; assumptions?: string[]; warnings?: string[] }) => ({ status: r.findings.length ? "success" as const : "partial" as const, confidence: r.confidence, findings: r.findings, assumptions: r.assumptions ?? [], warnings: r.warnings ?? [] });

/** The solver's full output (per-flight times, real ms) for the input an optimizer call ran on, so optimize() solves once. */
const SOLVED = new WeakMap<object, ReturnType<typeof optimizerAgent>>();

export const AGENTS = {
  weather: { name: "weather-agent", model: "haiku", effort: "low", promptVersion: "v1", description: "Translate weather feeds into operational constraints and confidence bands.", minConfidence: 0.5, maxAttempts: 2, deadlineMs: 15_000,
    run: (i) => { const r = weatherAgent(i); return { status: r.warnings.length ? "partial" : "success", confidence: r.confidence, findings: r.findings, assumptions: ["capacity bounded by the airport's operating rules (RULES in ops.ts)"], warnings: r.warnings }; } } as AgentSpec<WeatherInput>,
  flightRisk: sonnet<RiskInput>("flight-risk-agent", "Predict delay propagation, block-time risk and turnaround failure.", (i) => ok(flightRiskAgent(i))),
  gate: sonnet<GateInput>("gate-agent", "Prepare gate-conflict inputs and interpret optimization results.", (i) => ok(gateAgent(i))),
  passenger: sonnet<PaxInput>("passenger-agent", "Identify misconnection cohorts and prioritize vulnerable itineraries.", (i, ctx) => ok(passengerAgent({ ...i, deep: ctx.model === "opus" })), {
    // escalation sends only the itineraries into the outbound flights the cheap tier could not resolve (made or missed), with the
    // times and gates they need: the whole cohort of each, never the manifest
    compact: (i, prev) => { const out = new Set((prev.findings.find((f) => f.type === "misconnection_summary")?.data.uncertainOutbounds as string[] | undefined) ?? []); const its = i.itineraries.filter((x) => out.has(x.outbound)); const ids = new Set(its.flatMap((x) => [x.inbound, x.outbound])); const times = i.times.filter((t) => ids.has(t.id)), used = new Set(times.map((t) => t.gate)); return { ...i, itineraries: its, times, gates: i.gates.filter((g) => used.has(g.id)), narrow: true }; } }),
  groundOps: sonnet<GroundInput>("ground-ops-agent", "Assess tug, fuel, baggage and crew resource conflicts.", (i) => ok(groundOpsAgent(i))),
  optimizer: sonnet<OptimizeInput>("optimizer-agent", "Invoke the OR solver; never solve schedules with free-form language.", (i) => { const r = optimizerAgent(i, undefined, undefined); SOLVED.set(i, r); return ok({ ...r, findings: [...r.findings, { id: "sensitivity", type: "sensitivity", summary: `with ${r.sensitivity.stormPlusMin} more minutes of storm: misconnected ${JSON.stringify(r.sensitivity.misconnected)}`, confidence: 0.85, evidence: [], entities: [], data: r.sensitivity as unknown as Record<string, unknown> }] }); }, { deadlineMs: 60_000 }),
  synthesizer: { name: "recovery-synthesizer", model: "opus", effort: "high", promptVersion: "v1", description: "Compare feasible optimization outputs, passenger impact and operational tradeoffs.", minConfidence: 0.3, maxAttempts: 2, deadlineMs: 40_000,
    run: (i) => { const r = synthesize(i); return { status: "success", confidence: r.confidence, findings: [recommendationFinding(r.recommendation)], assumptions: r.assumptions, warnings: [] }; } } as AgentSpec<SynthesisInput>,
};

export type Stage = "weather" | "constraints" | "analyze" | "optimize" | "synthesize" | "done";
export interface WorkflowProgress { stage: Stage; message: string; agent?: RuntimeEvent }

export interface AnalysisResult {
  runId: string; disruption: Disruption; capacity: CapacityBucket[]; baseline: FlightTimes[]; findings: Finding[];
  analysts: Record<"flightRisk" | "gate" | "passenger" | "groundOps", AgentResult | { error: string }>;
  warnings: string[]; invocations: Invocation[]; rawTokens: number; status: "complete" | "partial"; ms: number;
}
export interface OptimizeResult { runId: string; options: RecoveryOption[]; sensitivity: Sensitivity; recommendation: Recommendation; invocations: Invocation[]; synthesisInputTokens: number; ms: number }
export interface RecoveryResult extends AnalysisResult { options: RecoveryOption[]; sensitivity: Sensitivity; recommendation: Recommendation; synthesisInputTokens: number }

export interface RunOptions { runId: string; tenant?: string; latencyScale?: number; faults?: Fault[]; cache?: Map<string, AgentResult>; onProgress?: (p: WorkflowProgress) => void; now?: () => number; runtime?: Runtime }

const stageOf = (agent: string): Stage => agent === "weather-agent" ? "weather" : agent === "optimizer-agent" ? "optimize" : agent === "recovery-synthesizer" ? "synthesize" : "analyze";
const runtimeFor = (opts: RunOptions) => opts.runtime ?? new Runtime({ workflow: WORKFLOW_VERSION, runId: opts.runId, tenant: opts.tenant, latencyScale: opts.latencyScale, faults: opts.faults, cache: opts.cache, now: opts.now, onEvent: (e) => opts.onProgress?.({ stage: stageOf(e.agent), message: e.message ?? `${e.agent} ${e.type} on ${e.model}`, agent: e }) });

/** Phase 1: weather -> constraints -> four analysts in parallel. */
export async function analyze(sc: Scenario, disruption: Disruption, opts: RunOptions): Promise<AnalysisResult> {
  const t0 = (opts.now ?? Date.now)();
  const progress = opts.onProgress ?? (() => {});
  const rt = runtimeFor(opts);
  const weather = applyDisruption(sc.weather, disruption);
  const rawTokens = tokens({ flights: sc.flights, itineraries: sc.itineraries, weather, resources: sc.resources, gates: sc.gates });
  progress({ stage: "weather", message: `weather-agent on ${weather.length} observations (${rawTokens.toLocaleString("en-US")} tokens of schedules, manifests and telemetry in the window)` });
  const w = await rt.invoke(AGENTS.weather, { weather, nominalPerHour: sc.airport.nominalMovementsPerHour });
  const capacity = weatherAgent({ weather, nominalPerHour: sc.airport.nominalMovementsPerHour }).capacity; // the agent's structured output (same deterministic function)
  void w;
  progress({ stage: "constraints", message: "deterministic constraint builder: capacity curve, FIFO baseline, gate occupancy" });
  const queued = propagate(sc, capacity, { priority: "fifo" });          // runway queue only: what the gate agent sees
  const baseline = noActionTimes(sc, queued);                                 // plus waiting for the original gate: "do nothing"
  const occ = gateAgent({ flights: sc.flights, aircraft: sc.aircraft, gates: sc.gates, times: baseline }).occupancies;
  progress({ stage: "analyze", message: "four analysts in parallel: flight risk, gates, passengers, ground ops" });
  const settled = await Promise.allSettled([
    rt.invoke(AGENTS.flightRisk, { flights: sc.flights, aircraft: sc.aircraft, start: sc.start, end: sc.end, capacity }),
    rt.invoke(AGENTS.gate, { flights: sc.flights, aircraft: sc.aircraft, gates: sc.gates, times: queued }),
    rt.invoke(AGENTS.passenger, { itineraries: sc.itineraries, gates: sc.gates, airport: sc.airport, times: baseline }),
    rt.invoke(AGENTS.groundOps, { occupancies: occ, resources: sc.resources, weather, start: sc.start, end: sc.end }),
  ]);
  const names = ["flightRisk", "gate", "passenger", "groundOps"] as const;
  const analysts = Object.fromEntries(names.map((n, i) => [n, settled[i].status === "fulfilled" ? settled[i].value : { error: (settled[i] as PromiseRejectedResult).reason?.message ?? "failed" }])) as AnalysisResult["analysts"];
  const okR = settled.filter((s): s is PromiseFulfilledResult<AgentResult> => s.status === "fulfilled").map((s) => s.value);
  const findings = refreshPaxSummary([...w.findings, ...okR.flatMap((r) => r.findings)]);
  const status = okR.length === 4 ? "complete" : "partial";
  return { runId: opts.runId, disruption: { ...disruption, triggerPayload: { ...disruption.triggerPayload } }, capacity, baseline, findings, analysts, warnings: okR.flatMap((r) => r.warnings), invocations: rt.invocations, rawTokens, status, ms: (opts.now ?? Date.now)() - t0 };
}

/** Phase 2: optimizer (solver) -> synthesizer on compact options only. */
export async function optimize(sc: Scenario, a: AnalysisResult, opts: RunOptions): Promise<OptimizeResult> {
  const t0 = (opts.now ?? Date.now)();
  const progress = opts.onProgress ?? (() => {});
  const rt = runtimeFor(opts);
  progress({ stage: "optimize", message: "optimizer-agent: three solver-backed recovery plans, then a longer-storm sensitivity" });
  const input = { scenario: sc, capacity: a.capacity, disruption: a.disruption };
  const o = await rt.invoke(AGENTS.optimizer, input);
  const options = o.findings.filter((f) => f.type === "recovery_option").map((f) => f.data as unknown as CompactOption);
  const sensitivity = o.findings.find((f) => f.type === "sensitivity")!.data as unknown as Sensitivity;
  const full = (SOLVED.get(input) ?? optimizerAgent(input)).options; // a cache hit skips the run: solve again rather than invent times
  // baseline misconnections from the merged cohort findings (the escalated call refined some of them), not the first summary
  const cohorts = a.findings.filter((f) => f.type === "misconnection_cohort");
  const pax = { data: { misconnected: cohorts.reduce((s, f) => s + Number(f.data.pax), 0), vulnerable: cohorts.reduce((s, f) => s + Number(f.data.vulnerable), 0) } };
  const synthInput: SynthesisInput = { options, sensitivity, stormMinutes: a.disruption.triggerPayload.durationMin, capacityFactor: a.capacity.filter((c) => c.phase === "storm").reduce((s, c, _, arr) => s + (c.capacity * 12) / sc.airport.nominalMovementsPerHour / arr.length, 0), analystWarnings: a.warnings, misconnectedBaseline: Number(pax?.data.misconnected ?? 0), vulnerableBaseline: Number(pax?.data.vulnerable ?? 0), delayedBaseline: Number(a.findings.find((f) => f.type === "delay_propagation")?.data.delayedOver15 ?? 0) };
  progress({ stage: "synthesize", message: `recovery-synthesizer on ${tokens(synthInput).toLocaleString("en-US")} tokens of structured options (${Math.round((100 * tokens(synthInput)) / a.rawTokens)}% of the raw window)` });
  const s = await rt.invoke(AGENTS.synthesizer, synthInput);
  const recommendation = s.findings[0].data as unknown as Recommendation;
  progress({ stage: "done", message: `option ${recommendation.recommended} recommended; awaiting dispatcher approval` });
  return { runId: opts.runId, options: full, sensitivity, recommendation, invocations: rt.invocations, synthesisInputTokens: tokens(synthInput), ms: (opts.now ?? Date.now)() - t0 };
}

/** Both phases on one runtime (the browser sandbox and the tests). */
export async function recover(sc: Scenario, disruption: Disruption, opts: RunOptions): Promise<RecoveryResult> {
  const rt = runtimeFor(opts);
  const a = await analyze(sc, disruption, { ...opts, runtime: rt });
  const o = await optimize(sc, a, { ...opts, runtime: rt });
  return { ...a, ...o, invocations: rt.invocations, ms: a.ms + o.ms, status: a.status };
}
