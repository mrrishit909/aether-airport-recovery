// Runs the multi-agent workflow off the main thread so the scene keeps rendering while agents work. One Runtime per run, shared by
// the analyze and optimize phases, so the invocations of a run carry one run id and the cache and circuit breaker persist.
import { analyze, optimize, type AnalysisResult, type Scenario, type WorkflowProgress } from "@aether/domain";
import { Runtime } from "@aether/agents";
import type { FromWorker, ToWorker } from "./protocol.ts";

let scenario: Scenario | null = null;
let rt: Runtime | null = null;
let last: AnalysisResult | null = null;
let sink: (p: WorkflowProgress) => void = () => {};
const cache = new Map();
const post = (m: FromWorker) => (self as unknown as Worker).postMessage(m);

self.onmessage = async (ev: MessageEvent<ToWorker>) => {
  const m = ev.data;
  if (m.type === "init") { const t0 = performance.now(); scenario = m.scenario; post({ type: "ready", n: scenario.flights.length, ms: performance.now() - t0 }); return; }
  if (!scenario) return post({ type: "error", id: m.id, message: "no airport loaded" });
  try {
    if (m.type === "analyze") {
      sink = (progress) => post({ type: "progress", id: m.id, progress });
      rt = new Runtime({ workflow: "recover-v1", runId: m.runId, latencyScale: m.latencyScale, faults: m.faults, cache, onEvent: (e) => sink({ stage: e.agent === "weather-agent" ? "weather" : e.agent === "optimizer-agent" ? "optimize" : e.agent === "recovery-synthesizer" ? "synthesize" : "analyze", message: e.message ?? `${e.agent} ${e.type} on ${e.model}`, agent: e }) });
      last = await analyze(scenario, m.disruption, { runId: m.runId, runtime: rt, onProgress: sink });
      const { analysts: _a, ...result } = last; void _a;
      post({ type: "analyze", id: m.id, result: { ...result, invocations: [...rt.invocations] } });
    } else if (m.type === "optimize") {
      if (!last || !rt) return post({ type: "error", id: m.id, message: "run the agents first" });
      sink = (progress) => post({ type: "progress", id: m.id, progress });
      const result = await optimize(scenario, last, { runId: last.runId, runtime: rt, onProgress: sink });
      post({ type: "optimize", id: m.id, result: { ...result, invocations: [...rt.invocations] } });
    }
  } catch (e) { post({ type: "error", id: m.id, message: (e as Error).message }); }
};
