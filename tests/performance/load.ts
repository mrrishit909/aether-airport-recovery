// Load test: concurrent HTTP clients on the read paths, then N WebSocket live streams held open through an analysis run.
// node tests/performance/load.ts [base] [httpClients] [seconds] [wsClients]
import WebSocket from "ws";

const [base = "http://127.0.0.1:8540", clients = "32", secs = "10", wsN = "2000"] = process.argv.slice(2);
const OP = { authorization: "Bearer norrvik-dispatcher-demo", "content-type": "application/json" }, VIEW = { authorization: "Bearer norrvik-viewer-demo" };
const storm = { name: "Load test thunderstorm", triggerType: "thunderstorm", triggerPayload: { start: "2026-10-07T09:00:00Z", durationMin: 45, capacityFactor: 0.4 } };
const post = (path: string, body: unknown, key: string) => fetch(base + path, { method: "POST", headers: { ...OP, "idempotency-key": `${key}-${Date.now()}` }, body: JSON.stringify(body) });
const dis = await (await post("/v1/disruptions", storm, "load-declare")).json() as { id: string };
await (await post(`/v1/disruptions/${dis.id}/analyze`, {}, "load-analyze")).arrayBuffer();
await (await post(`/v1/disruptions/${dis.id}/optimize`, {}, "load-optimize")).arrayBuffer();
const paths = ["/v1/airport/state", "/v1/disruptions", `/v1/disruptions/${dis.id}`, `/v1/disruptions/${dis.id}/options`, `/v1/disruptions/${dis.id}/agent-map`, "/v1/costs"];
const q = (a: number[], p: number) => a.sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(p * a.length))];

async function http() {
  const lat: number[] = []; let errors = 0, limited = 0;
  const end = Date.now() + +secs * 1000;
  await Promise.all(Array.from({ length: +clients }, async (_, c) => {
    for (let i = c; Date.now() < end; i++) {
      const t = performance.now();
      const r = await fetch(base + paths[i % paths.length], { headers: VIEW }).catch(() => null);
      lat.push(performance.now() - t);
      if (!r) errors++; else if (r.status === 429) limited++; else if (r.status >= 400) errors++;
      await r?.arrayBuffer();
    }
  }));
  return { requests: lat.length, rps: Math.round(lat.length / +secs), p50: +q(lat, 0.5).toFixed(1), p95: +q(lat, 0.95).toFixed(1), p99: +q(lat, 0.99).toFixed(1), errors, rateLimited: limited };
}

async function ws() {
  const url = base.replace(/^http/, "ws") + "/v1/airport/live?token=norrvik-viewer-demo";
  let open = 0, failed = 0, messages = 0; const why: Record<string, number> = {};
  const socks: WebSocket[] = [];
  const t0 = Date.now();
  await Promise.all(Array.from({ length: +wsN }, () => new Promise<void>((ok) => {
    const s = new WebSocket(url); socks.push(s);
    s.on("open", () => { open++; ok(); }); s.on("message", () => { messages++; }); s.on("error", (e: Error) => { failed++; why[e.message.slice(0, 40)] = (why[e.message.slice(0, 40)] ?? 0) + 1; ok(); });
  })));
  const openedMs = Date.now() - t0;
  messages = 0;
  const d2 = await (await post("/v1/disruptions", { ...storm, name: "Load test stream" }, "load-declare-2")).json() as { id: string };
  const t1 = performance.now();
  const r = await post(`/v1/disruptions/${d2.id}/analyze`, {}, "load-analyze-2");
  const analyzeMs = Math.round(performance.now() - t1);
  await new Promise((r) => setTimeout(r, 1500));
  socks.forEach((s) => s.close());
  return { requested: +wsN, open, failed, failedBecause: why, openedInMs: openedMs, analyzeStatus: r.status, analyzeMs, progressMessagesDelivered: messages, perSubscriber: open ? +(messages / open).toFixed(1) : 0 };
}

const h = await http();
const w = await ws();
console.log(JSON.stringify({ base, httpClients: +clients, seconds: +secs, http: h, websocket: w }, null, 1));
