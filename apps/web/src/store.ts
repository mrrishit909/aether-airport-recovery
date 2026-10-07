// Application state (the source of truth). The scene reads from here; nothing in the scene writes business state except through
// these actions. Time is event time: `cursor` is a timestamp inside the 90-minutes-before-and-after window, and every aircraft,
// gate and ripple in the scene is a function of it.
import { useSyncExternalStore } from "react";
import { DEFAULT_DISRUPTION, applyDisruption, capacityCurve, noActionTimes, propagate, rotationsOf, timesMap, type CapacityBucket, type Disruption, type Flight, type FlightTimes, type Gate, type OptimizeResult, type RecoveryOption, type Recommendation, type Rotation, type Scenario, type WorkflowProgress } from "@aether/domain";
import type { Fault, Finding, Invocation, RuntimeEvent } from "@aether/agents";
import { next, type Focus, type JourneyEvent, type View } from "./journey.ts";
import { makeProvider, withRetry, type Analysis, type Approval, type DataProvider } from "./provider.ts";

export interface AgentState { name: string; model: "haiku" | "sonnet" | "opus"; status: "idle" | "running" | "retrying" | "escalated" | "done" | "failed" | "cache"; attempt: number; message?: string; invocation?: Invocation; escalatedFrom?: "haiku" | "sonnet" | "opus" }
export type Stage = WorkflowProgress["stage"] | "idle";

export interface AppState {
  view: View;
  scenario: Scenario | null;
  gateById: Map<string, Gate>; flightById: Map<string, Flight>; rots: Rotation[];
  load: { status: "idle" | "loading" | "ready" | "error"; message?: string };
  feed: { status: "ok" | "down" | "retrying" | "recovered"; attempt: number; waitMs: number; lastGood: number | null; message?: string };
  stage: Stage;
  stageLog: { stage: Stage; message: string; at: number }[];
  agents: Record<string, AgentState>;
  disruption: Disruption | null;
  preview: { capacity: CapacityBucket[]; queued: FlightTimes[] } | null;     // deterministic, computed at the trigger
  analysis: Analysis | null;
  findings: Finding[];
  options: RecoveryOption[];
  recommendation: Recommendation | null;
  sensitivity: OptimizeResult["sensitivity"] | null;
  invocations: Invocation[]; runs: Invocation[][];
  rawTokens: number; synthesisInputTokens: number;
  selectedOption: string | null;
  compare: [string, string] | null;
  approval: Approval | null; approvedOption: string | null;
  runError: string | null;
  window: { start: number; end: number; t0: number };
  cursor: number; playing: boolean; speed: number;
  focus: Focus;
  selectedFinding: string | null; selectedFlight: string | null; selectedGate: string | null;
  rippleAt: number;                                                            // performance.now() of the last trigger
  panel: "agents" | "costs" | null;
  listView: boolean; reduced: boolean; motionPaused: boolean; hud: boolean; palette: boolean; approveOpen: boolean; help: boolean; stress: boolean;
  faults: Fault[];
  webgl: "ok" | "lost" | "unsupported";
  announce: string;
}

const initial: AppState = {
  view: "intro0", scenario: null, gateById: new Map(), flightById: new Map(), rots: [], load: { status: "idle" }, feed: { status: "ok", attempt: 0, waitMs: 0, lastGood: null },
  stage: "idle", stageLog: [], agents: {}, disruption: null, preview: null, analysis: null, findings: [], options: [], recommendation: null, sensitivity: null, invocations: [], runs: [], rawTokens: 0, synthesisInputTokens: 0,
  selectedOption: null, compare: null, approval: null, approvedOption: null, runError: null,
  window: { start: 0, end: 0, t0: 0 }, cursor: 0, playing: false, speed: 300, focus: "airport", selectedFinding: null, selectedFlight: null, selectedGate: null, rippleAt: -1e9,
  panel: null, listView: false, reduced: false, motionPaused: false, hud: false, palette: false, approveOpen: false, help: false, stress: false, faults: [], webgl: "ok", announce: "",
};

let state: AppState = initial;
const subs = new Set<() => void>();
export const get = () => state;
export function set(patch: Partial<AppState> | ((s: AppState) => Partial<AppState>)) {
  state = { ...state, ...(typeof patch === "function" ? patch(state) : patch) };
  for (const s of subs) s();
}
export function useApp<T>(sel: (s: AppState) => T): T {
  return useSyncExternalStore((cb) => { subs.add(cb); return () => subs.delete(cb); }, () => sel(state), () => sel(initial));
}
export const provider: DataProvider = makeProvider();
export function send(e: JourneyEvent) { set((s) => ({ view: next(s.view, e) })); }
export const say = (announce: string) => set({ announce });

/** The replay clock as rendered (advanced per frame while playing); the store's cursor follows it a few times a second. */
export const clock = { t: 0, lastSync: 0 };
export function jump(t: number) {
  const w = state.window;
  clock.t = w.end ? Math.max(w.start, Math.min(w.end, t)) : t;
  set({ cursor: clock.t });
}

export const AGENT_ORDER = ["weather-agent", "flight-risk-agent", "gate-agent", "passenger-agent", "ground-ops-agent", "optimizer-agent", "recovery-synthesizer"] as const;
const DEFAULT_MODEL: Record<string, AgentState["model"]> = { "weather-agent": "haiku", "flight-risk-agent": "sonnet", "gate-agent": "sonnet", "passenger-agent": "sonnet", "ground-ops-agent": "sonnet", "optimizer-agent": "sonnet", "recovery-synthesizer": "opus" };
const idleAgents = () => Object.fromEntries(AGENT_ORDER.map((n) => [n, { name: n, model: DEFAULT_MODEL[n], status: "idle", attempt: 0 } as AgentState]));

// ---------- which flight times the scene shows ----------
const cache = new WeakMap<object, Map<string, FlightTimes>>();
const memo = (arr: FlightTimes[]) => { let m = cache.get(arr); if (!m) { m = timesMap(arr); cache.set(arr, m); } return m; };
const planCache = new WeakMap<Map<string, FlightTimes>, Map<string, { key: string; times: Map<string, FlightTimes> }>>();
/** One stable object per (times, key): selectors that return it do not re-render the app on every store update. */
const plan = (key: string, times: Map<string, FlightTimes>) => { let m = planCache.get(times); if (!m) planCache.set(times, (m = new Map())); let p = m.get(key); if (!p) m.set(key, (p = { key, times })); return p; };
/** The plan on screen: the approved option, else the selected option, else the do-nothing baseline, else the raw runway queue, else the schedule. */
export function planOf(s: AppState): { key: string; times: Map<string, FlightTimes> } | null {
  if (!s.scenario) return null;
  const opt = (k: string | null) => s.options.find((o) => o.id === k);
  const o = opt(s.approvedOption) ?? opt(s.selectedOption);
  if (o) return plan(`option:${o.id}${s.approvedOption ? ":approved" : ""}`, memo(o.times));
  if (s.analysis) return plan("baseline", memo(s.analysis.baseline));
  if (s.preview) return plan("queued", memo(s.preview.queued));
  return plan("scheduled", memo(scheduledOf(s.scenario)));
}
const sched = new WeakMap<Scenario, FlightTimes[]>();
export function scheduledOf(sc: Scenario): FlightTimes[] {
  let x = sched.get(sc);
  if (!x) { x = sc.flights.map((f) => ({ id: f.id, kind: f.kind, scheduled: f.scheduled, estimated: f.scheduled, delayMin: 0, holdMin: 0, gate: f.gate })); sched.set(sc, x); }
  return x;
}
export function timesOfOption(s: AppState, key: string): Map<string, FlightTimes> | null { const o = s.options.find((x) => x.id === key); return o ? memo(o.times) : null; }
/** Runway capacity (movements per 5 min) at event time t, from the weather agent's curve (or the deterministic preview). */
export function capacityAt(s: AppState, t: number): CapacityBucket | null {
  const cap = s.analysis?.capacity ?? s.preview?.capacity; if (!cap || !s.scenario) return null;
  const i = Math.max(0, Math.min(cap.length - 1, Math.floor((t - Date.parse(s.scenario.start)) / 300e3)));
  return cap[i];
}

// ---------- loading ----------
export async function loadScenario() {
  const first = state.scenario === null;
  set({ load: { status: "loading" } });
  try {
    const sc = await withRetry(() => provider.loadScenario(), (attempt, ms, err) => {
      set((s) => ({ feed: { ...s.feed, status: "retrying", attempt, waitMs: ms, message: err.message } }));
      say(`Airport feed unavailable. Retrying in ${Math.round(ms / 1000)} seconds.`);
    }, first ? 6 : 8);
    const start = Date.parse(sc.start), end = Date.parse(sc.end), t0 = Date.parse(sc.t0);
    const recovered = state.feed.status === "retrying" || state.feed.status === "down";
    set({ scenario: sc, gateById: new Map(sc.gates.map((g) => [g.id, g])), flightById: new Map(sc.flights.map((f) => [f.id, f])), rots: rotationsOf(sc.flights), window: { start, end, t0 }, load: { status: "ready" }, feed: { status: recovered ? "recovered" : "ok", attempt: 0, waitMs: 0, lastGood: Date.now() }, agents: state.analysis ? state.agents : idleAgents() });
    if (!clock.t) jump(start + 60 * 60e3);
    if (recovered) say(`Airport feed recovered: ${sc.flights.length} flights refreshed.`);
  } catch (e) {
    set((s) => ({ load: { status: s.scenario ? "ready" : "error", message: (e as Error).message }, feed: { ...s.feed, status: "down", message: (e as Error).message } }));
    say("Airport feed is down. Showing the last good schedule.");
  }
}

function onAgent(e: RuntimeEvent) {
  set((s) => {
    const a = { ...(s.agents[e.agent] ?? { name: e.agent, model: e.model, status: "idle", attempt: 0 }) } as AgentState;
    a.model = e.model; a.attempt = e.attempt; a.message = e.message;
    if (e.type === "start") a.status = "running";
    if (e.type === "retry") a.status = "retrying";
    if (e.type === "escalate") { a.status = "escalated"; a.escalatedFrom = s.agents[e.agent]?.model; a.model = e.model; }
    if (e.type === "done") { a.status = "done"; a.invocation = e.invocation; }
    if (e.type === "failed") { a.status = "failed"; a.invocation = e.invocation; }
    if (e.type === "cache") { a.status = "cache"; a.invocation = e.invocation; }
    return { agents: { ...s.agents, [e.agent]: a } };
  });
}
const progress = (p: WorkflowProgress) => {
  set((s) => ({ stage: p.stage, stageLog: p.agent ? s.stageLog : [...s.stageLog, { stage: p.stage, message: p.message, at: Date.now() }] }));
  if (p.agent) onAgent(p.agent);
};

// ---------- the product's commands ----------
/** Declare the thunderstorm: runway capacity falls and delays propagate immediately (deterministic, before any agent runs). */
export async function triggerDisruption(d?: Disruption) {
  const sc = state.scenario;
  if (!sc || state.stage === "weather" || state.stage === "constraints" || state.stage === "analyze" || state.stage === "optimize" || state.stage === "synthesize") return;
  const dis = d ?? DEFAULT_DISRUPTION(sc);
  const cap = capacityCurve(applyDisruption(sc.weather, dis), sc.airport.nominalMovementsPerHour);
  const queued = propagate(sc, cap, { priority: "fifo" });
  send({ type: "TRIGGER" });
  set({ disruption: dis, preview: { capacity: cap, queued }, analysis: null, findings: [], options: [], recommendation: null, sensitivity: null, invocations: [], approval: null, approvedOption: null, selectedOption: null, compare: null, stage: "idle", stageLog: [], agents: idleAgents(), runError: null, rippleAt: performance.now(), selectedFinding: null, playing: false });
  jump(Date.parse(dis.triggerPayload.start));
  const over = queued.filter((t) => t.delayMin > 15).length;
  say(`Thunderstorm declared at ${new Date(dis.triggerPayload.start).toISOString().slice(11, 16)} UTC for ${dis.triggerPayload.durationMin} minutes. Runway capacity falls to ${Math.round(100 * Math.min(...cap.map((c) => c.capacity)) / (sc.airport.nominalMovementsPerHour / 12))} percent and ${over} movements will run more than 15 minutes late.`);
  try { await provider.declare(dis); } catch (e) { set({ runError: (e as Error).message }); say(`Could not record the disruption: ${(e as Error).message}`); }
}

export async function runAnalyze() {
  if (!state.disruption || ["weather", "constraints", "analyze", "optimize", "synthesize"].includes(state.stage)) return false;
  send({ type: "ANALYZE" });
  set({ stage: "weather", stageLog: [], agents: idleAgents(), analysis: null, findings: [], options: [], recommendation: null, selectedOption: null, compare: null, approval: null, approvedOption: null, runError: null, selectedFinding: null });
  say("Agents started: the weather agent first, then four analysts in parallel.");
  try {
    const a = await provider.analyze(state.disruption, state.faults, progress);
    set((s) => ({ analysis: a, findings: a.findings, rawTokens: a.rawTokens, invocations: a.invocations, runs: [...s.runs.filter((r) => r[0]?.workflow_run_id !== a.runId), a.invocations], stage: "idle" }));
    send({ type: "ANALYZED" });
    const g = a.findings.filter((f) => f.type === "gate_conflict").length, m = a.findings.find((f) => f.type === "misconnection_summary");
    say(`Analysis ${a.status}: ${a.findings.length} findings, ${g} gate conflicts, ${m ? Number(m.data.misconnected) : 0} passengers would miss connections if nothing changes.`);
    return true;
  } catch (e) {
    set({ runError: (e as Error).message, stage: "idle" });
    send({ type: "FAIL" });
    say(`Analysis failed: ${(e as Error).message}`);
    return false;
  }
}

export async function runOptimize() {
  if (!state.analysis || ["weather", "constraints", "analyze", "optimize", "synthesize"].includes(state.stage)) return false;
  send({ type: "OPTIMIZE" });
  set({ stage: "optimize", runError: null, options: [], recommendation: null, selectedOption: null, compare: null, approval: null, approvedOption: null });
  say("Optimizer started: three solver-backed recovery plans, then the synthesizer.");
  try {
    const r = await provider.optimize(progress);
    // the browser worker shares one runtime across both phases (its list already holds the analysis calls); the API persists each
    // phase under its own run id, so merge by invocation id either way
    set((s) => { const prev = s.analysis?.invocations ?? []; const all = [...prev, ...r.invocations.filter((i) => !prev.some((a) => a.id === i.id))]; return { options: r.options, recommendation: r.recommendation, sensitivity: r.sensitivity, selectedOption: r.recommendation.recommended, invocations: all, synthesisInputTokens: r.synthesisInputTokens, runs: [...s.runs.filter((x) => x !== prev), all], stage: "idle" as const }; });
    send({ type: "OPTIMIZED" });
    const rec = r.options.find((o) => o.id === r.recommendation.recommended)!;
    say(`Three plans ready. Option ${rec.id}, ${rec.name}, is recommended: ${rec.passengerImpact.misconnected} misconnected passengers and ${rec.operationalChanges.gateChanges.length} gate changes.`);
    return true;
  } catch (e) {
    set({ runError: (e as Error).message, stage: "idle" });
    send({ type: "FAIL" });
    say(`Optimization failed: ${(e as Error).message}`);
    return false;
  }
}

export async function runAll() {
  if (!state.disruption) await triggerDisruption();
  if (await runAnalyze()) await runOptimize();
}

export function selectOption(key: string | null) {
  if (key && !state.options.find((o) => o.id === key)) return;
  set({ selectedOption: key, selectedFinding: null });
  if (key) say(`Showing option ${key}: ${state.options.find((o) => o.id === key)!.name}.`);
}
export function setCompare(pair: [string, string] | null) {
  set({ compare: pair && pair[0] !== pair[1] && pair.every((k) => state.options.some((o) => o.id === k)) ? pair : null });
  if (state.compare) say(`Split view: option ${state.compare[0]} against option ${state.compare[1]}, on one clock.`);
}
export function toggleCompare(key: string) {
  const c = state.compare;
  if (!c) { const other = state.options.find((o) => o.id !== key && o.id === (state.recommendation?.recommended ?? "B")) ?? state.options.find((o) => o.id !== key); if (other) setCompare([other.id, key].sort() as [string, string]); return; }
  if (c.includes(key)) setCompare(null); else setCompare([c[0], key]);
}

export function selectFinding(id: string | null) {
  if (!id) { set({ selectedFinding: null }); return; }
  const f = state.findings.find((x) => x.id === id || x.id.startsWith(id));
  if (!f) return;
  set({ selectedFinding: f.id, selectedFlight: null, playing: false });
  const t = (f.data.from ?? f.data.approvedAt ?? f.data.worstAt) as string | undefined;
  if (t && !Number.isNaN(Date.parse(t))) jump(Date.parse(t));
  else { const fl = f.entities.map((e) => state.flightById.get(e)).find(Boolean); if (fl) jump(Date.parse(state.analysis?.baseline.find((b) => b.id === fl.id)?.estimated ?? fl.scheduled)); }
  say(`${f.type.replace(/_/g, " ")}, confidence ${Math.round(f.confidence * 100)} percent: ${f.summary}`);
}
export function selectFlight(id: string | null) {
  if (!id) { set({ selectedFlight: null }); return; }
  const fl = state.flightById.get(id) ?? [...state.flightById.values()].find((x) => x.id.startsWith(id));
  if (!fl) return;
  set({ selectedFlight: fl.id, selectedGate: null, selectedFinding: null, focus: "aircraft" });
  say(`Following ${fl.id}, ${fl.kind}, aircraft ${fl.tail}.`);
}
export function selectGate(id: string | null) {
  if (!id) { set({ selectedGate: null }); return; }
  if (!state.gateById.has(id)) return;
  set({ selectedGate: id, selectedFlight: null, selectedFinding: null, focus: "gates" });
  say(`Gate ${id} selected.`);
}

export async function approve(note: string, acknowledgePolicy: boolean) {
  const o = state.options.find((x) => x.id === state.selectedOption);
  if (!o || !state.recommendation) return;
  const flags = state.recommendation.tradeoffs.find((t) => t.optionId === o.id)?.policyFlags ?? [];
  if (flags.length && !acknowledgePolicy) throw new Error(`${flags.length} policy flag${flags.length > 1 ? "s" : ""} on option ${o.id}; confirm them to approve`);
  const a = await provider.approve(o, state.recommendation, note, acknowledgePolicy);
  set({ approval: a, approvedOption: o.id, approveOpen: false, rippleAt: performance.now() });
  send({ type: "APPROVE" });
  say(`Option ${o.id} approved by ${a.approvedBy}. ${o.operationalChanges.gateChanges.length} gate changes and ${o.operationalChanges.holds.length} holds are now the plan; the gates and aircraft update.`);
}

export function setFault(kind: "rate-limit-storm" | "ground-outage" | "opus-timeout" | null) {
  if (kind === "rate-limit-storm") set({ faults: [{ code: "rate_limited", model: "haiku", remaining: 2 }, { code: "rate_limited", model: "sonnet", remaining: 3 }] });
  else if (kind === "ground-outage") set({ faults: [{ code: "provider_error", agent: "ground-ops-agent", remaining: 20 }] });
  else if (kind === "opus-timeout") set({ faults: [{ code: "timeout", model: "opus", remaining: 1 }] });
  else set({ faults: [] });
}
export function setStress(on: boolean) { set({ stress: on }); }
export function reset() { send({ type: "RESET" }); set({ disruption: null, preview: null, analysis: null, findings: [], options: [], recommendation: null, selectedOption: null, compare: null, approval: null, approvedOption: null, stage: "idle", agents: idleAgents() }); }
