// Data providers. The public sandbox uses StaticProvider (bundled synthetic airport, workflow in a Web Worker); the Docker stack
// builds the web app with NEXT_PUBLIC_API_URL and uses ApiProvider (the real API runs the two workflow phases, persists them and
// streams progress over a WebSocket). Both can be told to fail (the "airport feed outage" scenario) so the recovery path is
// demonstrable without breaking anything real.
import type { AnalysisResult, Disruption, OptimizeResult, RecoveryOption, Scenario, WorkflowProgress } from "@aether/domain";
import { dispatchMarkdown } from "@aether/domain";
import type { Fault } from "@aether/agents";
import { traceparent } from "@aether/telemetry";
import { AetherClient } from "@aether/sdk";
import { RecoveryClient } from "./worker/client.ts";

export class FeedError extends Error { status: number; constructor(status: number, msg: string) { super(msg); this.status = status; } }
export interface Approval { approvedBy: string; at: string; planMarkdown: string; planHash: string; optionKey: string; mode: "simulated" | "api"; gateAssignments?: number }
export type Analysis = Omit<AnalysisResult, "analysts">;

export interface DataProvider {
  readonly kind: "static" | "api";
  feedDown: boolean;
  loadScenario(): Promise<Scenario>;
  declare(d: Disruption): Promise<void>;
  analyze(d: Disruption, faults: Fault[], onProgress: (p: WorkflowProgress) => void): Promise<Analysis>;
  optimize(onProgress: (p: WorkflowProgress) => void): Promise<OptimizeResult>;
  approve(option: RecoveryOption, rec: OptimizeResult["recommendation"], note: string, acknowledgePolicy: boolean): Promise<Approval>;
}

const base = process.env.NEXT_PUBLIC_BASE_PATH ?? "";
async function getJson<T>(url: string, init?: RequestInit): Promise<T> {
  const r = await fetch(url, { ...init, headers: { traceparent: traceparent(), ...(init?.headers ?? {}) } });
  if (!r.ok) { let msg = `${r.status} ${r.statusText}`; try { const b = await r.json(); msg = b?.error?.message ?? msg; } catch { /* not json */ } throw new FeedError(r.status, msg); }
  return r.json() as Promise<T>;
}
const hex8 = () => Array.from(crypto.getRandomValues(new Uint8Array(4)), (b) => b.toString(16).padStart(2, "0")).join("");

export class StaticProvider implements DataProvider {
  readonly kind = "static" as const;
  feedDown = false;
  worker: RecoveryClient | null = null;
  private runId = "";
  async loadScenario() {
    if (this.feedDown) { await new Promise((r) => setTimeout(r, 400)); throw new FeedError(503, "airport feed unavailable (simulated outage)"); }
    const sc = await getJson<Scenario>(`${base}/data/scenario.json`);
    this.worker?.terminate();
    this.worker = new RecoveryClient({ type: "init", scenario: sc });
    await this.worker.ready;
    return sc;
  }
  async declare() { /* the browser holds the declaration; the API persists it */ }
  async analyze(d: Disruption, faults: Fault[], onProgress: (p: WorkflowProgress) => void) {
    if (!this.worker) throw new Error("airport not loaded");
    this.runId = `sandbox-${hex8()}-${hex8()}`;
    return (await this.worker.analyze({ runId: this.runId, disruption: d, faults, latencyScale: 0.6 }, onProgress)).result;
  }
  async optimize(onProgress: (p: WorkflowProgress) => void) {
    if (!this.worker) throw new Error("airport not loaded");
    return (await this.worker.optimize(onProgress)).result;
  }
  async approve(option: RecoveryOption, rec: OptimizeResult["recommendation"], note: string) {
    const at = new Date().toISOString();
    const md = dispatchMarkdown(rec, option, "sandbox-dispatcher", at) + (note ? `\n\nNote: ${note}\n` : "");
    const hash = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(md))), (b) => b.toString(16).padStart(2, "0")).join("");
    return { approvedBy: "sandbox-dispatcher", at, planMarkdown: md, planHash: hash, optionKey: option.id, mode: "simulated" as const };
  }
}

export class ApiProvider implements DataProvider {
  readonly kind = "api" as const;
  feedDown = false;
  private client: AetherClient;
  private disruptionId: string | null = null;
  private apiIds = new Map<string, string>();
  constructor(url: string, token: string) { this.client = new AetherClient(url, token); }
  async loadScenario() {
    const s = await this.client.state(this.feedDown);
    return s as Scenario;
  }
  async declare(d: Disruption) {
    const r = await this.client.declare({ name: d.name, triggerType: d.triggerType, triggerPayload: d.triggerPayload });
    this.disruptionId = r.id; this.apiIds.clear();
  }
  async analyze(d: Disruption, faults: Fault[], onProgress: (p: WorkflowProgress) => void) {
    if (!this.disruptionId) await this.declare(d);
    const stop = this.client.live((m) => { const x = m as { type: string } & WorkflowProgress; if (x.type === "progress") onProgress({ stage: x.stage, message: x.message, agent: x.agent }); });
    try {
      const r = await this.client.analyze(this.disruptionId!, faults);
      return { runId: r.runId, disruption: d, capacity: r.capacity as Analysis["capacity"], baseline: r.baseline, findings: r.summary.findings, warnings: r.summary.warnings, invocations: r.invocations, rawTokens: r.rawTokens, status: r.status, ms: r.ms };
    } finally { stop(); }
  }
  async optimize(onProgress: (p: WorkflowProgress) => void) {
    const stop = this.client.live((m) => { const x = m as { type: string } & WorkflowProgress; if (x.type === "progress") onProgress({ stage: x.stage, message: x.message, agent: x.agent }); });
    try {
      const r = await this.client.optimize(this.disruptionId!);
      for (const o of r.options) this.apiIds.set(o.optionKey, o.id);
      return { runId: r.runId, options: r.options.map((o) => ({ ...o, id: o.optionKey })) as unknown as RecoveryOption[], sensitivity: r.sensitivity, recommendation: r.recommendation, invocations: r.invocations, synthesisInputTokens: r.synthesisInputTokens, ms: r.ms };
    } finally { stop(); }
  }
  async approve(option: RecoveryOption, _rec: OptimizeResult["recommendation"], note: string, acknowledgePolicy: boolean) {
    const id = this.apiIds.get(option.id);
    if (!id) throw new Error("option was not persisted");
    const r = await this.client.approve(id, { note, acknowledgePolicy });
    return { approvedBy: r.approvedBy, at: r.at, planMarkdown: r.planMarkdown, planHash: r.planHash, optionKey: r.optionKey, mode: "api" as const, gateAssignments: r.gateAssignments };
  }
}

export function makeProvider(): DataProvider {
  const api = process.env.NEXT_PUBLIC_API_URL;
  return api ? new ApiProvider(api, process.env.NEXT_PUBLIC_DEMO_TOKEN ?? "norrvik-dispatcher-demo") : new StaticProvider();
}

/** Retry with exponential backoff; reports each wait so the UI can show it. */
export async function withRetry<T>(fn: () => Promise<T>, onWait: (attempt: number, ms: number, err: Error) => void, max = 6): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try { return await fn(); } catch (e) {
      if (attempt >= max) throw e;
      const ms = Math.min(16000, 1000 * 2 ** (attempt - 1));
      onWait(attempt, ms, e as Error);
      await new Promise((r) => setTimeout(r, ms));
    }
  }
}
