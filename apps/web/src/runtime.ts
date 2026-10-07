// Per-frame runtime that must not go through React: the replay clock as rendered, the motion orchestrator and telemetry.
// The store remains the source of truth; the clock is copied back to it a few times a second for the UI.
import { Orchestrator } from "@aether/motion";
import { Telemetry } from "@aether/telemetry";
import { clock, get, set } from "./store.ts";
export { clock, jump } from "./store.ts";

export const orchestrator = new Orchestrator();
export const telemetry = new Telemetry((s) => {
  const api = process.env.NEXT_PUBLIC_API_URL;
  if (api && typeof navigator !== "undefined") navigator.sendBeacon?.(`${api}/v1/telemetry`, new Blob([JSON.stringify(s)], { type: "application/json" }));
});

/** Advance replay time by a frame (only while playing); clamp to the scenario window. */
export function advance(dtMs: number, nowMs: number) {
  const s = get();
  if (!s.window.end) return;
  if (clock.t === 0) clock.t = s.cursor;
  if (s.playing && !s.motionPaused) {
    clock.t = Math.min(s.window.end, clock.t + dtMs * s.speed);
    if (clock.t >= s.window.end) set({ playing: false });
  }
  if (nowMs - clock.lastSync > 120 && s.playing) { clock.lastSync = nowMs; set({ cursor: clock.t }); }
}
