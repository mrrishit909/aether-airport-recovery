// Synthetic data generator: writes data/fixtures/{scenario,provenance,cost-baseline}.json. Deterministic for a seed.
// The cost baseline is the invocation ledger of one clean run; the token/cost regression test compares against it.
import { mkdirSync, writeFileSync } from "node:fs";
import { DEFAULT_DISRUPTION, generateScenario, recover, SCENARIO_VERSION, WORKFLOW_VERSION } from "../../packages/domain/src/index.ts";
import { summarize } from "../../packages/agents/src/index.ts";

const seed = Number(process.env.SEED ?? 7);
const out = new URL("../fixtures/", import.meta.url);
mkdirSync(out, { recursive: true });
const sc = generateScenario(seed);
writeFileSync(new URL("scenario.json", out), JSON.stringify(sc));
let t = 0;
const run = await recover(sc, DEFAULT_DISRUPTION(sc), { runId: "baseline-run-0001", latencyScale: 0, now: () => (t += 1000) });
const summary = summarize(run.invocations);
const rec = run.options.find((o) => o.id === run.recommendation.recommended)!;
writeFileSync(new URL("cost-baseline.json", out), JSON.stringify({ workflow: WORKFLOW_VERSION, scenario: SCENARIO_VERSION, seed, totalCostUsd: summary.totalCostUsd, byAgent: summary.byAgent.map((a) => ({ agent: a.agent, model: a.model, calls: a.calls, inputTokens: a.inputTokens, outputTokens: a.outputTokens, costUsd: a.costUsd })), escalations: summary.escalations, rawTokens: run.rawTokens, synthesisInputTokens: run.synthesisInputTokens, findings: run.findings.length, options: run.options.map((o) => ({ id: o.id, name: o.name, misconnected: o.passengerImpact.misconnected, vulnerable: o.passengerImpact.vulnerableMisconnected, totalDelayMin: o.operationalChanges.totalDelayMin, gateChanges: o.operationalChanges.gateChanges.length, holds: o.operationalChanges.holds.length, optimal: o.solverMetadata.optimal, nodes: o.solverMetadata.nodes })), recommended: rec.id, misconnectedBaseline: run.recommendation.impact.passengersAffected, sensitivity: run.sensitivity }, null, 1));
writeFileSync(new URL("provenance.json", out), JSON.stringify({
  generated: new Date().toISOString(), seed, scenario: SCENARIO_VERSION, workflow: WORKFLOW_VERSION,
  note: "Everything in scenario.json is synthetic: the airport (NVK), airlines, tails, cities, passengers, ground fleet and weather feed are invented. No model is called: agents are deterministic analyzers charged simulated tokens at the configured price table; the gate solver is a real branch-and-bound search.",
  counts: { flights: sc.flights.length, aircraft: sc.aircraft.length, gates: sc.gates.length, itineraries: sc.itineraries.length, connectingPax: sc.itineraries.reduce((s, i) => s + i.pax, 0), resources: sc.resources.length, observations: sc.weather.length },
}, null, 1));
console.log(JSON.stringify({ msg: "generated", flights: sc.flights.length, itineraries: sc.itineraries.length, findings: run.findings.length, recommended: rec.id, options: run.options.map((o) => [o.id, o.passengerImpact.misconnected, o.passengerImpact.vulnerableMisconnected, o.operationalChanges.totalDelayMin, o.operationalChanges.gateChanges.length, o.operationalChanges.holds.length, o.solverMetadata.nodes, o.solverMetadata.optimal]), baselineMisconnected: run.recommendation.impact.passengersAffected, costUsd: summary.totalCostUsd, escalations: summary.escalations, synthesisTokens: run.synthesisInputTokens, rawTokens: run.rawTokens, sensitivity: run.sensitivity }));
