// Where is each aircraft at time t? A pure function of the backend's estimated times and the gate positions, so the 3D scene is
// a rendering of event time (never a separate animation clock): scrub to t and every aircraft is where the schedule says.
// Arrivals land eastbound on runway 09L (z=-12), taxi east then south to the apron lane (z=8.5) and in to the gate; departures
// leave the gate, take the west taxiway to runway 09R (z=-16) and take off eastbound. Late arrivals circle in a holding pattern.
import type { Flight, FlightTimes, Gate } from "./types.ts";
import { TAXI_MIN } from "./ops.ts";

export type Vec = [number, number, number];
export interface Pose { visible: boolean; pos: Vec; heading: number; phase: "hold" | "approach" | "landing" | "taxi_in" | "gate" | "pushback" | "taxi_out" | "takeoff" | "climb" | "away"; gate: string }

export const RUNWAY = { arrZ: -12, depZ: -16, x0: -34, x1: 34 };
const LANE_Z = 8.5, EAST_X = 28, WEST_X = -28, HOLD_CENTER: Vec = [-40, 13, -4], HOLD_R = 8;
const MIN = 60e3;

function along(path: Vec[], u: number): { pos: Vec; heading: number } {
  const lens = path.slice(1).map((p, i) => Math.hypot(p[0] - path[i][0], p[2] - path[i][2]) + Math.abs(p[1] - path[i][1]));
  const total = lens.reduce((s, x) => s + x, 0) || 1;
  let d = Math.min(1, Math.max(0, u)) * total, i = 0;
  while (i < lens.length - 1 && d > lens[i]) { d -= lens[i]; i++; }
  const a = path[i], b = path[i + 1] ?? a, f = lens[i] ? d / lens[i] : 0;
  return { pos: [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f], heading: Math.atan2(b[2] - a[2], b[0] - a[0]) };
}

export const taxiInPath = (g: Vec): Vec[] => [[RUNWAY.x1 - 8, 0.2, RUNWAY.arrZ], [EAST_X, 0.2, RUNWAY.arrZ], [EAST_X, 0.2, LANE_Z], [g[0], 0.2, LANE_Z], [g[0], 0.2, g[2]]];
export const taxiOutPath = (g: Vec): Vec[] => [[g[0], 0.2, g[2]], [g[0], 0.2, LANE_Z], [WEST_X, 0.2, LANE_Z], [WEST_X, 0.2, RUNWAY.depZ], [RUNWAY.x0 + 6, 0.2, RUNWAY.depZ]];

/** Pose of one flight's aircraft at time t. `ta`/`td` are the estimated arrival (touchdown) and departure (lift-off) times. */
export function aircraftPose(t: number, f: { sched: number; ta: number; td: number }, gatePos: [number, number], gateId: string): Pose {
  const g: Vec = [gatePos[0], 0.2, gatePos[1]];
  const holdFrom = f.sched - 10 * MIN, appFrom = f.ta - 5 * MIN, park = f.ta + TAXI_MIN.in * MIN, push = f.td - TAXI_MIN.out * MIN, roll = f.td - 2 * MIN;
  const mk = (phase: Pose["phase"], pos: Vec, heading: number, visible = true): Pose => ({ visible, pos, heading, phase, gate: gateId });
  const late = f.ta - f.sched > 5 * MIN;
  const holdPt = (a: number): Vec => [HOLD_CENTER[0] + HOLD_R * Math.cos(a), HOLD_CENTER[1], HOLD_CENTER[2] + HOLD_R * Math.sin(a)];
  const holdAngle = (tt: number) => ((tt - holdFrom) / (6 * MIN)) * Math.PI * 2;
  if (t < holdFrom) return mk("away", [-60, 14, -12], 0, false);
  if (late && t < appFrom) { const a = holdAngle(t); return mk("hold", holdPt(a), a + Math.PI / 2); }
  // one continuous final approach: from the holding pattern's exit point (late) or from the edge of the scene (on time) to touchdown
  const start = late ? appFrom : Math.max(holdFrom, f.ta - 7 * MIN);
  if (t < f.ta) { if (t < start) return mk("away", [-60, 14, -12], 0, false); const from: Vec = late ? holdPt(holdAngle(appFrom)) : [-60, 14, RUNWAY.arrZ]; const r = along([from, [-52, 8, RUNWAY.arrZ], [RUNWAY.x0 + 8, 0.3, RUNWAY.arrZ]], (t - start) / (f.ta - start)); return mk("approach", r.pos, r.heading); }
  // landing roll to the runway exit, then the taxi to the gate, at one steady speed until the aircraft is parked
  if (t < park) { const r = along([[RUNWAY.x0 + 8, 0.3, RUNWAY.arrZ], ...taxiInPath(g)], (t - f.ta) / (park - f.ta)); return mk(t < f.ta + MIN ? "landing" : "taxi_in", r.pos, r.heading); }
  if (t < push) return mk("gate", g, gatePos[1] < LANE_Z ? Math.PI / 2 : -Math.PI / 2);
  if (t < roll) { const r = along(taxiOutPath(g), (t - push) / (roll - push)); return mk(t < push + MIN ? "pushback" : "taxi_out", r.pos, r.heading); }
  if (t < f.td) { const r = along([[RUNWAY.x0 + 6, 0.2, RUNWAY.depZ], [RUNWAY.x0 + 40, 0.3, RUNWAY.depZ]], (t - roll) / (2 * MIN)); return mk("takeoff", r.pos, 0); }
  if (t < f.td + 5 * MIN) { const r = along([[RUNWAY.x0 + 40, 0.3, RUNWAY.depZ], [RUNWAY.x1 + 20, 14, RUNWAY.depZ - 2]], (t - f.td) / (5 * MIN)); return mk("climb", r.pos, 0); }
  return mk("away", [80, 14, -18], 0, false);
}

export interface Rotation { tail: string; arrival: Flight; departure: Flight }
export const rotationsOf = (flights: Flight[]): Rotation[] => flights.filter((f) => f.kind === "arrival").map((a) => ({ tail: a.tail, arrival: a, departure: flights.find((d) => d.id === a.other)! }));

/** Poses of every rotation at t under a set of flight times (a plan). */
export function poses(t: number, rots: Rotation[], times: Map<string, FlightTimes>, gates: Map<string, Gate>): { rot: Rotation; pose: Pose }[] {
  return rots.map((r) => {
    const ta = Date.parse(times.get(r.arrival.id)!.estimated), td = Date.parse(times.get(r.departure.id)!.estimated);
    const gid = times.get(r.arrival.id)!.gate, g = gates.get(gid)!;
    return { rot: r, pose: aircraftPose(t, { sched: Date.parse(r.arrival.scheduled), ta, td }, g.pos, gid) };
  });
}

/** Aircraft sitting at a gate at t, per gate: more than one is a conflict (only possible before the options resolve it). */
export function gateOccupancy(ps: { rot: Rotation; pose: Pose }[]) {
  const m = new Map<string, string[]>();
  for (const { rot, pose } of ps) if (pose.visible && pose.phase === "gate") m.set(pose.gate, [...(m.get(pose.gate) ?? []), rot.tail]);
  return m;
}
