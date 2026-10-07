// Deep links: the product state that matters is in the query string, so any view can be shared and restored.
import { FOCI, type Focus } from "./journey.ts";
export interface LinkState { enter?: boolean; trig?: boolean; run?: boolean; opt?: string; cmp?: [string, string]; f?: string; g?: string; t?: number; panel?: "agents" | "costs"; view?: "list"; rm?: boolean; stage?: "approved"; cam?: Focus }

export function readLink(search: string): LinkState {
  const q = new URLSearchParams(search);
  const s: LinkState = {};
  if (q.get("enter") === "1") s.enter = true;
  if (q.get("trig") === "1") s.trig = true;
  if (q.get("run") === "1") s.run = true;
  const o = q.get("opt"); if (o && /^[A-Z]$/.test(o)) s.opt = o;
  const c = q.get("cmp"); if (c && /^[A-Z],[A-Z]$/.test(c)) s.cmp = c.split(",") as [string, string];
  const f = q.get("f"); if (f && /^[A-Z0-9]{3,10}$/.test(f)) s.f = f;
  const g = q.get("g"); if (g && /^[A-Z][0-9]{1,2}$/.test(g)) s.g = g;
  const t = q.get("t"); if (t) { const ms = Date.parse(t); if (!Number.isNaN(ms)) s.t = ms; }
  const p = q.get("panel"); if (p === "agents" || p === "costs") s.panel = p;
  if (q.get("view") === "list") s.view = "list";
  if (q.get("rm") === "1") s.rm = true;
  if (q.get("stage") === "approved") s.stage = "approved";
  const cam = q.get("cam") as Focus | null; if (cam && (FOCI as readonly string[]).includes(cam)) s.cam = cam;
  return s;
}

export function writeLink(s: LinkState): string {
  const q = new URLSearchParams();
  if (s.run) q.set("run", "1"); else if (s.trig) q.set("trig", "1"); else if (s.enter) q.set("enter", "1");
  if (s.stage) q.set("stage", s.stage);
  if (s.opt) q.set("opt", s.opt);
  if (s.cmp) q.set("cmp", s.cmp.join(","));
  if (s.f) q.set("f", s.f);
  if (s.g) q.set("g", s.g);
  if (s.t !== undefined) q.set("t", new Date(Math.round(s.t / 1000) * 1000).toISOString().replace(".000Z", "Z"));
  if (s.cam && s.cam !== "airport") q.set("cam", s.cam);
  if (s.panel) q.set("panel", s.panel);
  if (s.view) q.set("view", s.view);
  if (s.rm) q.set("rm", "1");
  const str = q.toString();
  return str ? `?${str}` : "";
}
