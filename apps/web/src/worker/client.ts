// Promise-based wrapper around the recovery worker.
import type { WorkflowProgress } from "@aether/domain";
import type { FromWorker, ToWorker } from "./protocol.ts";

export class RecoveryClient {
  private w: Worker;
  private seq = 0;
  private waiting = new Map<number, { ok: (m: FromWorker) => void; err: (e: Error) => void; progress?: (p: WorkflowProgress) => void }>();
  ready: Promise<{ n: number; ms: number }>;

  constructor(init: Extract<ToWorker, { type: "init" }>) {
    this.w = new Worker(new URL("./recovery.worker.ts", import.meta.url), { type: "module" });
    let resolveReady!: (v: { n: number; ms: number }) => void;
    this.ready = new Promise((r) => (resolveReady = r));
    this.w.onmessage = (ev: MessageEvent<FromWorker>) => {
      const m = ev.data;
      if (m.type === "ready") return resolveReady(m);
      const h = this.waiting.get(m.id);
      if (!h) return;
      if (m.type === "progress") return h.progress?.(m.progress);
      this.waiting.delete(m.id);
      if (m.type === "error") h.err(new Error(m.message)); else h.ok(m);
    };
    this.w.postMessage(init);
  }
  private call<T extends FromWorker["type"]>(msg: Omit<Extract<ToWorker, { type: "analyze" | "optimize" }>, "id">, progress?: (p: WorkflowProgress) => void) {
    const id = ++this.seq;
    return new Promise<Extract<FromWorker, { type: T }>>((ok, err) => {
      this.waiting.set(id, { ok: ok as (m: FromWorker) => void, err, progress });
      this.w.postMessage({ ...msg, id });
    });
  }
  analyze(req: Omit<Extract<ToWorker, { type: "analyze" }>, "id" | "type">, progress?: (p: WorkflowProgress) => void) { return this.call<"analyze">({ ...req, type: "analyze" }, progress); }
  optimize(progress?: (p: WorkflowProgress) => void) { return this.call<"optimize">({ type: "optimize" }, progress); }
  terminate() { this.w.terminate(); }
}
