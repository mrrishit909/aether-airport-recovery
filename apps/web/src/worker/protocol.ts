// Messages between the page and the recovery worker. The worker runs the same analyze()/optimize() workflow as the API on the
// bundled synthetic airport, sharing one agent runtime across both phases so a run is one set of Appendix C rows, with simulated
// provider latency scaled so each agent is visible for a moment.
import type { AnalysisResult, Disruption, OptimizeResult, Scenario, WorkflowProgress } from "@aether/domain";
import type { Fault } from "@aether/agents";

export type ToWorker =
  | { type: "init"; scenario: Scenario }
  | { type: "analyze"; id: number; runId: string; disruption: Disruption; faults: Fault[]; latencyScale: number }
  | { type: "optimize"; id: number };

export type FromWorker =
  | { type: "ready"; n: number; ms: number }
  | { type: "progress"; id: number; progress: WorkflowProgress }
  | { type: "analyze"; id: number; result: Omit<AnalysisResult, "analysts"> }
  | { type: "optimize"; id: number; result: OptimizeResult }
  | { type: "error"; id: number; message: string };
