// The product's view states as a deterministic machine (packages/motion). The store asks the machine which view follows an
// event; the scene then animates toward the camera targets of that view. Reduced motion changes how fast, never where.
import { transition, type MachineDef } from "@aether/motion";

export type View = "intro0" | "intro1" | "intro2" | "intro3" | "explore" | "disrupted" | "analyzing" | "analyzed" | "optimizing" | "review" | "approved";
export type JourneyEvent = { type: "CHAPTER"; n: number } | { type: "ENTER" } | { type: "TRIGGER" } | { type: "ANALYZE" } | { type: "ANALYZED" } | { type: "OPTIMIZE" } | { type: "OPTIMIZED" } | { type: "APPROVE" } | { type: "FAIL" } | { type: "RESET" };

const intro = (n: number): View => (["intro0", "intro1", "intro2", "intro3"] as const)[Math.max(0, Math.min(3, n))];
const introState = { on: { CHAPTER: (e: { n: number }) => intro(e.n), ENTER: "explore" as View, TRIGGER: "disrupted" as View } };

export const journey: MachineDef<View, JourneyEvent> = {
  initial: "intro0",
  states: {
    intro0: introState, intro1: introState, intro2: introState, intro3: introState,
    explore: { on: { TRIGGER: "disrupted", CHAPTER: (e) => intro(e.n) } },
    disrupted: { on: { ANALYZE: "analyzing", RESET: "explore", TRIGGER: "disrupted" } },
    analyzing: { on: { ANALYZED: "analyzed", FAIL: "disrupted" } },
    analyzed: { on: { OPTIMIZE: "optimizing", ANALYZE: "analyzing", RESET: "explore" } },
    optimizing: { on: { OPTIMIZED: "review", FAIL: "analyzed" } },
    review: { on: { APPROVE: "approved", ANALYZE: "analyzing", OPTIMIZE: "optimizing", RESET: "explore" } },
    approved: { on: { RESET: "explore" } },
  },
};
export const next = (v: View, e: JourneyEvent) => transition(journey, v, e);
export const isIntro = (v: View) => v.startsWith("intro");

/** Camera focus: the airport, the runway, the gates, one aircraft, the passenger network. Spatial context is kept between them. */
export const FOCI = ["airport", "runway", "gates", "aircraft", "passengers"] as const;
export type Focus = (typeof FOCI)[number];
export const FOCUS_LABEL: Record<Focus, string> = { airport: "Airport", runway: "Runway", gates: "Gates", aircraft: "Aircraft", passengers: "Passengers" };
