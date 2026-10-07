// Typed client for the AETHER API (shapes match docs/openapi.json). Adds the bearer token, a W3C traceparent per call, an
// Idempotency-Key on every mutation, follows nextCursor pagination, and turns error bodies into ApiError.
import type { Disruption, FlightTimes, Recommendation, RecoveryOption, Scenario } from "@aether/domain";
import type { CostSummary, Fault, Finding, Invocation } from "@aether/agents";

export class ApiError extends Error {
  status: number; code: string; traceId?: string; details?: unknown;
  constructor(status: number, code: string, message: string, traceId?: string, details?: unknown) { super(message); this.status = status; this.code = code; this.traceId = traceId; this.details = details; }
}
export interface DisruptionRow { id: string; name: string; triggerType: Disruption["triggerType"]; triggerPayload: Disruption["triggerPayload"]; status: "declared" | "analyzed" | "optimized" | "approved"; createdAt: string | null; lastRunId: string | null; recommendation: Recommendation | null; analysis: { capacity: unknown[]; baseline: FlightTimes[]; findings: Finding[]; warnings: string[]; rawTokens: number; status: "complete" | "partial"; ms: number } | null }
export interface OptionRow extends Omit<RecoveryOption, "id"> { id: string; optionKey: string; scenarioId: string; approval: { approvedBy: string; at: string; planHash: string } | null }
export interface AnalyzeResponse { runId: string; status: "complete" | "partial"; findings: number; costUsd: number; escalations: CostSummary["escalations"]; rawTokens: number; capacity: unknown[]; baseline: FlightTimes[]; summary: { findings: Finding[]; warnings: string[] }; invocations: Invocation[]; ms: number }
export interface OptimizeResponse { runId: string; options: OptionRow[]; recommendation: Recommendation; costUsd: number; escalations: CostSummary["escalations"]; synthesisInputTokens: number; sensitivity: { stormPlusMin: number; misconnected: Record<string, number>; totalDelayMin: Record<string, number> }; invocations: Invocation[]; ms: number }
export type AirportState = Scenario & { tenant: { slug: string; name: string }; disruption: DisruptionRow | null; approvedOption: string | null };

const hex = (n: number) => Array.from(crypto.getRandomValues(new Uint8Array(n)), (b) => b.toString(16).padStart(2, "0")).join("");

export class AetherClient {
  private base: string; private token?: string;
  constructor(base: string, token?: string) { this.base = base.replace(/\/$/, ""); this.token = token; }

  private async req<T>(method: string, path: string, body?: unknown, idempotencyKey?: string): Promise<T> {
    const headers: Record<string, string> = { traceparent: `00-${hex(16)}-${hex(8)}-01` };
    if (this.token) headers.authorization = `Bearer ${this.token}`;
    if (body !== undefined) headers["content-type"] = "application/json";
    if (method !== "GET") headers["idempotency-key"] = idempotencyKey ?? crypto.randomUUID();
    const r = await fetch(this.base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const j = r.status === 204 ? null : await r.json().catch(() => null);
    if (!r.ok) throw new ApiError(r.status, j?.error?.code ?? "http_error", j?.error?.message ?? r.statusText, j?.error?.traceId, j?.error?.details);
    return j as T;
  }
  state(simulateOutage = false) { return this.req<AirportState>("GET", `/v1/airport/state${simulateOutage ? "?simulate=outage" : ""}`); }
  declare(d: { name: string; triggerType: Disruption["triggerType"]; triggerPayload: Disruption["triggerPayload"] }, idempotencyKey?: string) { return this.req<DisruptionRow>("POST", "/v1/disruptions", d, idempotencyKey); }
  disruptions(q: { status?: string; limit?: number; cursor?: string } = {}) { return this.req<{ items: DisruptionRow[]; nextCursor: string | null }>("GET", `/v1/disruptions?${new URLSearchParams(Object.entries(q).filter(([, v]) => v !== undefined).map(([k, v]) => [k, String(v)]))}`); }
  async *allDisruptions() { let cursor: string | undefined; do { const p = await this.disruptions({ limit: 200, cursor }); yield* p.items; cursor = p.nextCursor ?? undefined; } while (cursor); }
  disruption(id: string) { return this.req<DisruptionRow>("GET", `/v1/disruptions/${id}`); }
  analyze(id: string, faults: Fault[] = [], idempotencyKey?: string) { return this.req<AnalyzeResponse>("POST", `/v1/disruptions/${id}/analyze`, { faults }, idempotencyKey); }
  optimize(id: string, faults: Fault[] = [], idempotencyKey?: string) { return this.req<OptimizeResponse>("POST", `/v1/disruptions/${id}/optimize`, { faults }, idempotencyKey); }
  options(id: string, q: { limit?: number; cursor?: string } = {}) { return this.req<{ items: OptionRow[]; nextCursor: string | null; recommendation: Recommendation | null }>("GET", `/v1/disruptions/${id}/options?${new URLSearchParams(Object.entries(q).filter(([, v]) => v !== undefined).map(([k, v]) => [k, String(v)]))}`); }
  approve(optionId: string, body: { note?: string; acknowledgePolicy?: boolean } = {}, idempotencyKey?: string) { return this.req<{ status: string; optionKey: string; approvedBy: string; at: string; planMarkdown: string; planHash: string; gateAssignments: number }>("POST", `/v1/options/${optionId}/approve`, body, idempotencyKey); }
  agentMap(id: string) { return this.req<{ runIds: string[]; invocations: Invocation[]; summary: CostSummary }>("GET", `/v1/disruptions/${id}/agent-map`); }
  costs() { return this.req<CostSummary>("GET", "/v1/costs"); }
  /** Live airport events (progress, status, approval) for the caller's tenant. */
  live(onMessage: (m: unknown) => void) { const ws = new WebSocket(`${this.base.replace(/^http/, "ws")}/v1/airport/live?token=${encodeURIComponent(this.token ?? "")}`); ws.onmessage = (e) => onMessage(JSON.parse(String(e.data))); return () => ws.close(); }
}
