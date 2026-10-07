// Deterministic airport operations models. These run before any agent and inside the optimizer: runway capacity from the
// weather feed, a 5-minute slot queue that propagates delays through aircraft rotations, connection feasibility, gate overlap
// and ground-resource peaks. No free text is read anywhere here; remarks are copied as values only.
import type { Aircraft, CapacityBucket, Flight, FlightTimes, Gate, Itinerary, Resource, Scenario, WeatherObservation } from "./types.ts";

export const BUCKET_MS = 5 * 60e3;
export const TAXI_MIN = { in: 8, out: 10 };

/** Operating rules the weather agent's output is bounded by: capacity per 5 min, never above nominal, ramp limited. */
export const RULES = { maxRampPerBucket: 1, minVisibilityM: 800, convectiveFactor: 0.4, lowVisFactor: 0.6, recoveryBuckets: 2 };

/** Runway capacity per 5-minute bucket from the weather feed, with a +-1 movement band on convective buckets. */
export function capacityCurve(weather: WeatherObservation[], nominalPerHour: number): CapacityBucket[] {
  const nominal = nominalPerHour / 12;
  const out: CapacityBucket[] = [];
  let prev = nominal, recovery = 0;
  for (const w of weather) {
    let factor = 1, phase: CapacityBucket["phase"] = "normal";
    if (w.visibilityM < RULES.minVisibilityM) factor = 0;
    else if (w.convective && w.windKt >= 25) { factor = RULES.convectiveFactor; phase = "storm"; recovery = RULES.recoveryBuckets; }
    else if (w.visibilityM < 3000) { factor = RULES.lowVisFactor; phase = "storm"; recovery = RULES.recoveryBuckets; }
    else if (recovery > 0) { factor = 0.75; phase = "recovery"; recovery--; }
    let cap = Math.round(nominal * factor);
    cap = Math.min(cap, prev + RULES.maxRampPerBucket); // capacity recovers one movement per bucket, never faster (operating rule)
    cap = Math.max(0, Math.min(Math.round(nominal), cap));
    out.push({ ts: w.ts, capacity: cap, low: phase === "normal" ? cap : Math.max(0, cap - 1), high: phase === "normal" ? cap : Math.min(Math.round(nominal), cap + 1), phase });
    prev = cap;
  }
  return out;
}

export interface QueueOptions { priority: "fifo" | "connections"; connectingPax?: Map<string, number>; capacityOverride?: CapacityBucket[] }

/** Slot queue: movements take the first bucket at or after their ready time with capacity left. Departures become ready only
 *  after their arrival's estimated time plus the turnaround, so delay propagates through the rotation. */
export function propagate(sc: Pick<Scenario, "flights" | "aircraft" | "start" | "end">, capacity: CapacityBucket[], opts: QueueOptions = { priority: "fifo" }): FlightTimes[] {
  const ac = new Map(sc.aircraft.map((a) => [a.tail, a]));
  const byId = new Map(sc.flights.map((f) => [f.id, f]));
  const cap = new Map(capacity.map((c) => [Date.parse(c.ts), c.capacity]));
  const start = Date.parse(sc.start), end = Date.parse(sc.end) + 120 * 60e3;
  const est = new Map<string, number>();
  const bucketOf = (t: number) => start + Math.floor((t - start) / BUCKET_MS) * BUCKET_MS;
  const ready = (f: Flight) => f.kind === "arrival" ? Date.parse(f.scheduled) : Math.max(Date.parse(f.scheduled), (est.get(f.other) ?? Date.parse(byId.get(f.other)!.scheduled)) + (ac.get(f.tail)?.turnaroundMin ?? 40) * 60e3);
  const pending = new Set(sc.flights.map((f) => f.id));
  // arrivals land first (fuel), then departures: FIFO by schedule, or by connecting passengers at risk
  const weight = (f: Flight) => (f.kind === "arrival" ? -1e6 : 0) + (opts.priority === "connections" && f.kind === "departure" ? -(opts.connectingPax?.get(f.id) ?? 0) : 0);
  for (let b = start; b <= end && pending.size; b += BUCKET_MS) {
    let left = cap.get(b) ?? Math.round(44 / 12);
    const due = [...pending].map((id) => byId.get(id)!).filter((f) => ready(f) < b + BUCKET_MS && (f.kind === "arrival" || est.has(f.other)))
      .sort((x, y) => weight(x) - weight(y) || x.scheduled.localeCompare(y.scheduled) || x.id.localeCompare(y.id));
    for (const f of due) {
      if (left <= 0) break;
      const t = Math.max(ready(f), b);
      est.set(f.id, bucketOf(t) === b ? t : b);
      pending.delete(f.id); left--;
    }
  }
  for (const id of pending) est.set(id, end); // never served inside the horizon: reported as the maximum delay
  return sc.flights.map((f) => { const e = est.get(f.id)!; const s = Date.parse(f.scheduled); return { id: f.id, kind: f.kind, scheduled: f.scheduled, estimated: new Date(e).toISOString(), delayMin: Math.round((e - s) / 60e3), holdMin: f.kind === "arrival" ? Math.round((e - s) / 60e3) : Math.max(0, Math.round((e - ready(f)) / 60e3)), gate: f.gate }; });
}

/** Minimum connection time between two gates under the airport's rules. */
export function mct(sc: Pick<Scenario, "airport">, from: Gate, to: Gate) {
  const transfer = sc.airport.transferMin[`${from.terminal}-${to.terminal}`];
  let m = from.terminal === to.terminal ? sc.airport.mctMin.sameTerminal : transfer !== undefined ? sc.airport.mctMin.sameTerminal + transfer : sc.airport.mctMin.crossTerminal;
  if (from.remote) m += sc.airport.mctMin.remoteExtra;
  if (to.remote) m += sc.airport.mctMin.remoteExtra;
  return m;
}

export interface Connection { itinerary: Itinerary; inboundAt: string; outboundAt: string; gapMin: number; neededMin: number; made: boolean; crossTerminal: boolean }

/** Which itineraries still connect given estimated times and gates. */
export function connections(sc: Pick<Scenario, "airport" | "gates" | "itineraries">, times: Map<string, FlightTimes>): Connection[] {
  const gate = new Map(sc.gates.map((g) => [g.id, g]));
  return sc.itineraries.map((it) => {
    const a = times.get(it.inbound)!, d = times.get(it.outbound)!;
    const ga = gate.get(a.gate)!, gd = gate.get(d.gate)!;
    const gap = Math.round((Date.parse(d.estimated) - Date.parse(a.estimated)) / 60e3);
    const need = mct(sc, ga, gd);
    return { itinerary: it, inboundAt: a.estimated, outboundAt: d.estimated, gapMin: gap, neededMin: need, made: gap >= need, crossTerminal: ga.terminal !== gd.terminal };
  });
}

export interface Occupancy { tail: string; arrival: string; departure: string; gate: string; from: number; to: number; cls: Aircraft["cls"]; pax: number }

/** Gate occupancy per rotation (arrival estimated - 5 min .. departure estimated + 5 min) and the overlaps on the same gate. */
export function occupancies(sc: Pick<Scenario, "flights" | "aircraft">, times: Map<string, FlightTimes>): Occupancy[] {
  const ac = new Map(sc.aircraft.map((a) => [a.tail, a]));
  return sc.flights.filter((f) => f.kind === "arrival").map((a) => {
    const d = sc.flights.find((f) => f.id === a.other)!;
    const ta = times.get(a.id)!, td = times.get(d.id)!;
    return { tail: a.tail, arrival: a.id, departure: d.id, gate: ta.gate, from: Date.parse(ta.estimated) + TAXI_MIN.in * 60e3 - 5 * 60e3, to: Date.parse(td.estimated) - TAXI_MIN.out * 60e3 + 5 * 60e3, cls: ac.get(a.tail)!.cls, pax: a.pax + d.pax };
  });
}
export function gateConflicts(occ: Occupancy[]) {
  const out: { gate: string; a: Occupancy; b: Occupancy; overlapMin: number }[] = [];
  const byGate = new Map<string, Occupancy[]>();
  for (const o of occ) byGate.set(o.gate, [...(byGate.get(o.gate) ?? []), o]);
  for (const [gate, os] of byGate) for (let i = 0; i < os.length; i++) for (let j = i + 1; j < os.length; j++) {
    const ov = Math.min(os[i].to, os[j].to) - Math.max(os[i].from, os[j].from);
    if (ov > 0) out.push({ gate, a: os[i], b: os[j], overlapMin: Math.round(ov / 60e3) });
  }
  return out.sort((x, y) => x.a.from - y.a.from);
}

/** Ground resources: each turnaround needs one tug, one fuel truck and one baggage crew for its first 30 minutes at the gate;
 *  a lightning stop (ramp closed) pushes those needs after the stop. Returns per-bucket demand and the peaks over capacity. */
export function resourcePeaks(occ: Occupancy[], resources: Resource[], rampClosed: [number, number][], start: number, end: number) {
  const capacity: Record<string, number> = {};
  for (const r of resources) if (r.status === "available" && r.type !== "crew") capacity[r.type] = (capacity[r.type] ?? 0) + 1;
  const demand: { ts: number; tug: number; fuel: number; baggage: number }[] = [];
  const closed = (t: number) => rampClosed.some(([a, b]) => t >= a && t < b);
  for (let b = start; b <= end; b += BUCKET_MS) {
    let n = 0;
    for (const o of occ) { let s = o.from + 5 * 60e3; while (closed(s)) s += BUCKET_MS; if (b >= s && b < s + 30 * 60e3) n++; }
    demand.push({ ts: b, tug: n, fuel: n, baggage: n });
  }
  const peaks = (["tug", "fuel", "baggage"] as const).map((t) => ({ type: t, capacity: capacity[t] ?? 0, peak: Math.max(0, ...demand.map((d) => d[t])), bucketsOver: demand.filter((d) => d[t] > (capacity[t] ?? 0)).length, worstAt: demand.reduce((w, d) => (d[t] > w[t] ? d : w), demand[0]).ts }));
  return { demand, peaks };
}

/** Ramp (apron) closure intervals: lightning within 5 nm closes the ramp for that observation's 5 minutes. */
export function rampClosures(weather: WeatherObservation[]): [number, number][] {
  const out: [number, number][] = [];
  for (const w of weather) if (w.lightningWithin5nm) { const t = Date.parse(w.ts); const last = out.at(-1); if (last && last[1] === t) last[1] = t + BUCKET_MS; else out.push([t, t + BUCKET_MS]); }
  return out;
}

export const timesMap = (ts: FlightTimes[]) => new Map(ts.map((t) => [t.id, t]));

/** "Do nothing": every rotation keeps its gate and waits for it. Later rotations on a conflicting gate are held (both legs)
 *  until the previous occupant has pushed back. This is the feasible baseline the options are compared against. */
export function noActionTimes(sc: Pick<Scenario, "flights" | "aircraft">, times: FlightTimes[]): FlightTimes[] {
  const out = new Map(times.map((t) => [t.id, { ...t }]));
  const occ = occupancies(sc, out).sort((a, b) => a.from - b.from || a.tail.localeCompare(b.tail));
  const lastTo = new Map<string, number>();
  for (const o of occ) {
    const prev = lastTo.get(o.gate) ?? -Infinity;
    const hold = prev > o.from ? Math.ceil((prev - o.from) / BUCKET_MS) * BUCKET_MS : 0;
    for (const id of [o.arrival, o.departure]) { const t = out.get(id)!; const e = Date.parse(t.estimated) + hold; t.estimated = new Date(e).toISOString(); t.delayMin += hold / 60e3; t.holdMin += hold / 60e3; }
    lastTo.set(o.gate, o.to + hold);
  }
  return times.map((t) => out.get(t.id)!);
}
