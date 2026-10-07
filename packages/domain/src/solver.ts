// Gate re-assignment as a constraint-programming problem: each aircraft rotation picks (gate, hold) from a finite domain,
// no two rotations may overlap on one gate, and the objective is a weighted sum of gate changes, remote-stand passengers,
// holds and cross-terminal walks. Solved by depth-first branch and bound with forward checking; deterministic; a node cap
// makes the answer "best found" rather than optimal and says so in the metadata. Never solved with text.
import { connections, mct, noActionTimes, occupancies, propagate, rampClosures, resourcePeaks, timesMap, type Occupancy } from "./ops.ts";
import type { CapacityBucket, FlightTimes, Gate, RecoveryOption, Scenario } from "./types.ts";

export interface Weights { change: number; walk: number; remote: number; delay: number }   // walk = weight per 10 misconnected passengers
export const HOLDS = [0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55, 60] as const;

export interface SolveResult { assignment: { occ: Occupancy; gate: string; holdMin: number; cost: number }[]; cost: number; bound: number; nodes: number; ms: number; optimal: boolean; feasible: boolean }

/** Connecting passengers on this rotation who would miss their connection if it sat at `gate` after `hold` minutes, with
 *  every counterpart flight at its queued time and original gate. Exact for the pair; interactions between two moved
 *  rotations are not modelled (ponytail: a joint objective would need the search to re-evaluate connections per node). */
function misses(sc: Pick<Scenario, "itineraries" | "flights" | "gates" | "airport">, occ: Occupancy, gate: Gate, hold: number, T: Map<string, FlightTimes>) {
  const gateOf = (id: string) => sc.gates.find((g) => g.id === T.get(id)!.gate)!;
  let n = 0;
  for (const it of sc.itineraries) {
    if (it.inbound === occ.arrival) { const d = T.get(it.outbound)!; const gap = (Date.parse(d.estimated) - Date.parse(T.get(it.inbound)!.estimated)) / 60e3 - hold; if (gap < mct(sc, gate, gateOf(it.outbound))) n += it.pax; }
    else if (it.outbound === occ.departure) { const a = T.get(it.inbound)!; const gap = (Date.parse(T.get(it.outbound)!.estimated) - Date.parse(a.estimated)) / 60e3 + hold; if (gap < mct(sc, gateOf(it.inbound), gate)) n += it.pax; }
  }
  return n;
}

export function solveGates(sc: Pick<Scenario, "gates" | "itineraries" | "flights" | "airport">, occ: Occupancy[], w: Weights, T: Map<string, FlightTimes>, nodeCap = 8_000, now: () => number = Date.now): SolveResult {
  const t0 = now();
  const gates = sc.gates.filter((g) => !g.maintenance);
  // ponytail: only rotations in a conflict at their original gate are variables; the rest are fixed where they are. Moving an
  // unconflicted rotation to free a gate is never considered, which is the ceiling of this solver.
  const byGate = new Map<string, Occupancy[]>();
  for (const o of occ) byGate.set(o.gate, [...(byGate.get(o.gate) ?? []), o]);
  const inConflict = new Set<Occupancy>();
  for (const os of byGate.values()) for (let i = 0; i < os.length; i++) for (let j = i + 1; j < os.length; j++) if (os[i].from < os[j].to && os[j].from < os[i].to) { inConflict.add(os[i]); inConflict.add(os[j]); }
  const fixedBusy = new Map<string, [number, number][]>();
  for (const o of occ) if (!inConflict.has(o)) fixedBusy.set(o.gate, [...(fixedBusy.get(o.gate) ?? []), [o.from, o.to]]);
  const maxHold = HOLDS[HOLDS.length - 1] * 60e3;
  // independent components among the variables: conflicting rotations that can never overlap in time are solved separately
  const sorted = [...inConflict].sort((a, b) => a.from - b.from || a.tail.localeCompare(b.tail));
  const comps: Occupancy[][] = [];
  for (const o of sorted) { const last = comps.at(-1); if (last && o.from < Math.max(...last.map((x) => x.to)) + maxHold) last.push(o); else comps.push([o]); }
  const assignment: SolveResult["assignment"] = occ.filter((o) => !inConflict.has(o)).map((o) => ({ occ: o, gate: o.gate, holdMin: 0, cost: 0 }));
  let nodes = 0, cut = false, cost = 0, bound = 0;
  for (const rots of comps) {
    // domains, cost relative to "same gate, no hold" so an untouched rotation costs 0 and is tried first
    const optCost = (o: Occupancy, g: Gate, h: number, base: number) => +Math.max(0, w.change * (g.id === o.gate ? 0 : 1) + w.remote * (g.remote ? o.pax / 100 : 0) + w.delay * (h / 15) * (o.pax / 100) + w.walk * (misses(sc, o, g, h, T) / 10) - base).toFixed(4);
    const baseOf = (o: Occupancy) => w.walk * (misses(sc, o, sc.gates.find((g) => g.id === o.gate)!, 0, T) / 10);
    const domain = rots.map((o) => {
      const base = baseOf(o);
      const opts: { gate: Gate; hold: number; cost: number }[] = [];
      for (const g of gates) if (g.compatible.includes(o.cls)) for (const h of HOLDS) opts.push({ gate: g, hold: h, cost: optCost(o, g, h, base) });
      return opts.sort((a, b) => a.cost - b.cost || a.hold - b.hold || a.gate.id.localeCompare(b.gate.id));
    });
    const busy = new Map<string, [number, number][]>([...fixedBusy].map(([k, v]) => [k, [...v]]));
    const chosen: ({ gate: Gate; hold: number; cost: number } | undefined)[] = new Array(rots.length);
    let best: typeof chosen | null = null, bestCost = Infinity;
    const fits = (g: string, a: number, b: number) => !(busy.get(g) ?? []).some(([x, y]) => a < y && b > x);
    const okOpt = (k: number, o: { gate: Gate; hold: number }) => fits(o.gate.id, rots[k].from + o.hold * 60e3, rots[k].to + o.hold * 60e3);
    // fail-first: branch on the unassigned rotation with the fewest feasible options (counted to 3); the bound is the sum of
    // each unassigned rotation's cheapest feasible option under the current partial assignment (forward checking)
    // warm start: every rotation keeps its gate and waits until the previous occupant has gone (the "do nothing" plan). It is
    // feasible whenever the waits fit the hold domain, so the search starts from a real incumbent and only ever improves it.
    {
      const b2 = new Map<string, [number, number][]>([...fixedBusy].map(([k, v]) => [k, [...v]]));
      const ws: { gate: Gate; hold: number; cost: number }[] = []; let ok = true, wc = 0;
      for (const o of [...rots].sort((x, y) => x.from - y.from)) {
        const used = b2.get(o.gate) ?? [];
        let h = 0;
        while (h <= 240 && used.some(([x, y]) => o.from + h * 60e3 < y && o.to + h * 60e3 > x)) h += 5;
        const own = sc.gates.find((g) => g.id === o.gate)!;
        const opt = domain[rots.indexOf(o)].find((d) => d.gate.id === o.gate && d.hold === h) ?? (h <= 240 && own.compatible.includes(o.cls) ? { gate: own, hold: h, cost: optCost(o, own, h, baseOf(o)) } : undefined); // waits longer than the search window are allowed only here
        if (!opt) { ok = false; break; }
        ws[rots.indexOf(o)] = opt; wc += opt.cost; b2.set(o.gate, [...used, [o.from + h * 60e3, o.to + h * 60e3]]);
      }
      if (ok) { best = ws; bestCost = wc; }
    }
    const dfs = (done: number, c: number) => {
      if (cut) return;
      if (done === rots.length) { if (c < bestCost) { bestCost = c; best = [...chosen]; } return; }
      let pick = -1, pickN = 9, lb = 0;
      for (let k = 0; k < rots.length; k++) {
        if (chosen[k]) continue;
        let n = 0, first = Infinity;
        for (const o of domain[k]) if (okOpt(k, o)) { if (first === Infinity) first = o.cost; if (++n >= 3) break; }
        if (n === 0) return; // dead end: this rotation has nowhere to go
        lb += first;
        if (n < pickN || (n === pickN && rots[k].from < rots[pick].from)) { pick = n === 0 ? pick : k; pickN = n; }
      }
      if (c + lb >= bestCost) return;
      for (const o of domain[pick]) {
        if (++nodes > nodeCap) { cut = true; return; }
        if (c + o.cost >= bestCost) break;
        if (!okOpt(pick, o)) continue;
        chosen[pick] = o; busy.set(o.gate.id, [...(busy.get(o.gate.id) ?? []), [rots[pick].from + o.hold * 60e3, rots[pick].to + o.hold * 60e3]]);
        dfs(done + 1, c + o.cost);
        busy.get(o.gate.id)!.pop(); chosen[pick] = undefined;
        if (cut) return;
      }
    };
    dfs(0, 0);
    bound += rots.reduce((s, _, k) => s + (domain[k][0]?.cost ?? 0), 0);
    const b = best as typeof chosen | null;
    if (!b) return { assignment: [], cost: Infinity, bound: 0, nodes, ms: now() - t0, optimal: false, feasible: false };
    rots.forEach((o, i) => assignment.push({ occ: o, gate: b[i]!.gate.id, holdMin: b[i]!.hold, cost: b[i]!.cost }));
    cost += bestCost;
  }
  return { assignment, cost: +cost.toFixed(3), bound: +bound.toFixed(3), nodes, ms: now() - t0, optimal: !cut, feasible: true };
}

export interface Strategy { id: string; name: string; runwayPriority: "fifo" | "connections"; weights: Weights; connectionHoldMaxMin?: number }
export const STRATEGIES: Strategy[] = [
  { id: "A", name: "Minimum total delay", runwayPriority: "fifo", weights: { change: 1, walk: 2, remote: 1, delay: 6 } },
  { id: "B", name: "Protect connections", runwayPriority: "fifo", weights: { change: 0.2, walk: 14, remote: 0.3, delay: 1 }, connectionHoldMaxMin: 25 },
  { id: "C", name: "Least disruption", runwayPriority: "fifo", weights: { change: 8, walk: 1, remote: 2, delay: 1 } },
];

/** Hold a departure up to `maxMin` for passengers who would otherwise miss it, when enough passengers are saved per 5 minutes
 *  (3, or 1 if any are vulnerable), the gate stays free, and the runway slot is not given up (the departure still leaves
 *  inside its capacity bucket's slack: ponytail, bucket slack is not re-checked). Mutates `times` and `T`; returns the holds. */
function holdDeparturesForConnections(sc: Scenario, times: FlightTimes[], T: Map<string, FlightTimes>, maxMin: number) {
  const out: { flight: string; minutes: number }[] = [];
  const deps = sc.flights.filter((f) => f.kind === "departure");
  const paxTo = (id: string) => connections(sc, T).filter((c) => c.itinerary.outbound === id);
  for (const d of deps) {
    const t = T.get(d.id)!;
    const base = paxTo(d.id).filter((c) => !c.made);
    if (!base.length) continue;
    let bestHold = 0, bestSaved = 0;
    for (let h = 5; h <= maxMin; h += 5) {
      const saved = base.filter((c) => c.gapMin + h >= c.neededMin).reduce((s, c) => s + c.itinerary.pax, 0);
      const vul = base.filter((c) => c.gapMin + h >= c.neededMin && (c.itinerary.mobility || c.itinerary.minor)).length;
      if (saved >= (vul ? 1 : 3) * (h / 5) && saved > bestSaved) { bestHold = h; bestSaved = saved; }
    }
    if (!bestHold) continue;
    const before = t.estimated;
    t.estimated = new Date(Date.parse(t.estimated) + bestHold * 60e3).toISOString(); t.delayMin += bestHold; t.holdMin += bestHold;
    const occ = occupancies(sc, T).filter((o) => o.gate === t.gate);
    const clash = occ.some((a, i) => occ.some((b, j) => j > i && a.from < b.to && b.from < a.to));
    if (clash) { t.estimated = before; t.delayMin -= bestHold; t.holdMin -= bestHold; continue; }
    out.push({ flight: d.id, minutes: bestHold });
  }
  return out;
}

/** Option 0, "wait for gates": no re-assignment, every rotation waits for its own gate. Compared on the same footing. */
export function noActionOption(sc: Scenario, capacity: CapacityBucket[]): RecoveryOption {
  const times = noActionTimes(sc, propagate(sc, capacity, { priority: "fifo" }));
  const T = timesMap(times);
  const conns = connections(sc, T), missed = conns.filter((c) => !c.made);
  const cohorts = new Map<string, { outbound: string; pax: number; vulnerable: number; shortfallMin: number }>();
  for (const m of missed) { const c = cohorts.get(m.itinerary.outbound) ?? { outbound: m.itinerary.outbound, pax: 0, vulnerable: 0, shortfallMin: 0 }; c.pax += m.itinerary.pax; c.vulnerable += (m.itinerary.mobility || m.itinerary.minor) ? m.itinerary.pax : 0; c.shortfallMin = Math.max(c.shortfallMin, m.neededMin - m.gapMin); cohorts.set(m.itinerary.outbound, c); }
  const holds = times.filter((t) => t.kind === "arrival" && t.holdMin > 0 && Date.parse(t.estimated) - Date.parse(t.scheduled) > 0).map((t) => ({ flight: t.id, minutes: t.holdMin }));
  const occ = occupancies(sc, T);
  const peaks = resourcePeaks(occ, sc.resources, rampClosures(sc.weather), Date.parse(sc.start), Date.parse(sc.end)).peaks;
  const totalDelay = times.reduce((s, t) => s + Math.max(0, t.delayMin), 0);
  const gateById = new Map(sc.gates.map((g) => [g.id, g]));
  return {
    id: "W", name: "Wait for gates (no re-assignment)", strategy: { runwayPriority: "fifo", weights: { change: 0, walk: 0, remote: 0, delay: 0 } }, objectiveScore: 0,
    passengerImpact: { misconnected: missed.reduce((s, m) => s + m.itinerary.pax, 0), vulnerableMisconnected: [...cohorts.values()].reduce((s, c) => s + c.vulnerable, 0), cohorts: [...cohorts.values()].sort((a, b) => b.pax - a.pax), onRemoteStand: times.filter((t) => gateById.get(t.gate)?.remote).reduce((s, t) => s + sc.flights.find((f) => f.id === t.id)!.pax, 0), avgDelayMin: +(totalDelay / times.length).toFixed(1) },
    operationalChanges: { gateChanges: [], holds, delayedOver15: times.filter((t) => t.delayMin > 15).length, maxDelayMin: Math.max(0, ...times.map((t) => t.delayMin)), totalDelayMin: totalDelay, resourcePeakOver: peaks.reduce((s, p) => s + p.bucketsOver, 0) },
    solverMetadata: { nodes: 0, ms: 0, optimal: true, bound: 0, feasible: true, rotations: occ.length, conflicts: 0 },
    times, status: "proposed",
  };
}

/** One solver-backed recovery option: runway queue under the capacity curve, then gate re-assignment, then the impact. */
export function buildOption(sc: Scenario, capacity: CapacityBucket[], strat: Strategy, now: () => number = Date.now, nodeCap?: number): RecoveryOption {
  const connecting = new Map<string, number>();
  for (const it of sc.itineraries) { connecting.set(it.inbound, (connecting.get(it.inbound) ?? 0) + it.pax); connecting.set(it.outbound, (connecting.get(it.outbound) ?? 0) + it.pax); }
  const base = propagate(sc, capacity, { priority: strat.runwayPriority, connectingPax: connecting });
  const occ = occupancies(sc, timesMap(base));
  const sol = solveGates(sc, occ, strat.weights, timesMap(base), nodeCap, now);
  const byTail = new Map(sol.assignment.map((a) => [a.occ.tail, a]));
  // ponytail: a hold shifts both legs by the hold and keeps the runway slot order; a second queue pass would refine it
  const times: FlightTimes[] = base.map((t) => { const f = sc.flights.find((x) => x.id === t.id)!; const a = byTail.get(f.tail); if (!a) return t; const e = Date.parse(t.estimated) + a.holdMin * 60e3; return { ...t, estimated: new Date(e).toISOString(), delayMin: t.delayMin + a.holdMin, holdMin: t.holdMin + a.holdMin, gate: a.gate }; });
  const T = timesMap(times);
  const connHolds = strat.connectionHoldMaxMin ? holdDeparturesForConnections(sc, times, T, strat.connectionHoldMaxMin) : [];
  const conns = connections(sc, T);
  const missed = conns.filter((c) => !c.made);
  const cohorts = new Map<string, { outbound: string; pax: number; vulnerable: number; shortfallMin: number }>();
  for (const m of missed) { const c = cohorts.get(m.itinerary.outbound) ?? { outbound: m.itinerary.outbound, pax: 0, vulnerable: 0, shortfallMin: 0 }; c.pax += m.itinerary.pax; c.vulnerable += (m.itinerary.mobility || m.itinerary.minor) ? m.itinerary.pax : 0; c.shortfallMin = Math.max(c.shortfallMin, m.neededMin - m.gapMin); cohorts.set(m.itinerary.outbound, c); }
  const gateById = new Map(sc.gates.map((g) => [g.id, g]));
  const gateChanges = sol.assignment.filter((a) => a.gate !== a.occ.gate).map((a) => ({ flight: a.occ.arrival, from: a.occ.gate, to: a.gate }));
  const holds = [...sol.assignment.filter((a) => a.holdMin > 0).map((a) => ({ flight: a.occ.arrival, minutes: a.holdMin })), ...connHolds];
  const occ2 = occupancies(sc, T);
  const peaks = resourcePeaks(occ2, sc.resources, rampClosures(sc.weather), Date.parse(sc.start), Date.parse(sc.end)).peaks;
  const totalDelay = times.reduce((s, t) => s + Math.max(0, t.delayMin), 0);
  const onRemote = times.filter((t) => gateById.get(t.gate)?.remote).reduce((s, t) => s + sc.flights.find((f) => f.id === t.id)!.pax, 0);
  const vulnerable = [...cohorts.values()].reduce((s, c) => s + c.vulnerable, 0);
  const misconnected = missed.reduce((s, m) => s + m.itinerary.pax, 0);
  const objective = +(strat.weights.delay * totalDelay / 60 + strat.weights.walk * misconnected / 10 + strat.weights.remote * onRemote / 100 + strat.weights.change * gateChanges.length).toFixed(2);
  return {
    id: strat.id, name: strat.name, strategy: { runwayPriority: strat.runwayPriority, weights: strat.weights }, objectiveScore: objective,
    passengerImpact: { misconnected, vulnerableMisconnected: vulnerable, cohorts: [...cohorts.values()].sort((a, b) => b.pax - a.pax), onRemoteStand: onRemote, avgDelayMin: +(totalDelay / times.length).toFixed(1) },
    operationalChanges: { gateChanges, holds, delayedOver15: times.filter((t) => t.delayMin > 15).length, maxDelayMin: Math.max(0, ...times.map((t) => t.delayMin)), totalDelayMin: totalDelay, resourcePeakOver: peaks.reduce((s, p) => s + p.bucketsOver, 0) },
    solverMetadata: { nodes: sol.nodes, ms: sol.ms, optimal: sol.optimal, bound: sol.bound, feasible: sol.feasible, rotations: occ.length, conflicts: occ.length ? gateChanges.length + holds.length : 0 },
    times, status: "proposed",
  };
}
