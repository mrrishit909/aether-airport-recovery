// Deterministic analyzers behind the application agents. Each takes a bounded, typed input and returns findings in the
// agent contract's shape. Nothing here reads free text as instructions: flight remarks are copied as values only.
import type { Finding } from "@aether/agents";
import { capacityCurve, connections, gateConflicts, occupancies, propagate, rampClosures, resourcePeaks, timesMap, type Occupancy } from "./ops.ts";
import { STRATEGIES, buildOption, noActionOption } from "./solver.ts";
import type { Aircraft, CapacityBucket, Disruption, Flight, FlightTimes, Gate, Itinerary, RecoveryOption, Resource, Scenario, WeatherObservation } from "./types.ts";

const conf = (signals: number, max: number) => +Math.min(0.95, 0.4 + 0.55 * (signals / max)).toFixed(2);
const hhmm = (t: string | number) => new Date(t).toISOString().slice(11, 16);

/** The dispatcher's declared disruption applied to the calm feed: this is what "trigger a thunderstorm" means. */
export function applyDisruption(weather: WeatherObservation[], d: Disruption): WeatherObservation[] {
  const s = Date.parse(d.triggerPayload.start), e = s + d.triggerPayload.durationMin * 60e3;
  return weather.map((w, i) => {
    const t = Date.parse(w.ts);
    if (d.triggerType === "thunderstorm" && t >= s && t < e) return { ...w, windKt: 28 + (i % 5) * 3, visibilityM: 1200 + (i % 4) * 300, convective: true, lightningWithin5nm: t < e - 10 * 60e3 };
    if (d.triggerType === "thunderstorm" && t >= s - 10 * 60e3 && t < s) return { ...w, windKt: 16 + (i % 3) * 2, visibilityM: 5000, convective: true, lightningWithin5nm: false };
    if (d.triggerType === "runway_closure" && t >= s && t < e) return { ...w, visibilityM: 700, convective: false, lightningWithin5nm: false };
    if (d.triggerType === "ground_stop" && t >= s && t < e) return { ...w, convective: true, windKt: 30, lightningWithin5nm: true };
    return w;
  });
}

// ---------- weather-agent (haiku) ----------
export interface WeatherInput { weather: WeatherObservation[]; nominalPerHour: number }
export function weatherAgent(i: WeatherInput): { findings: Finding[]; confidence: number; warnings: string[]; capacity: CapacityBucket[] } {
  const cap = capacityCurve(i.weather, i.nominalPerHour);
  const findings: Finding[] = [];
  const warnings: string[] = [];
  let k = 0;
  while (k < cap.length) {
    const ph = cap[k].phase; let j = k; while (j < cap.length && cap[j].phase === ph) j++;
    if (ph !== "normal") {
      const seg = cap.slice(k, j), mins = seg.length * 5, avg = seg.reduce((s, c) => s + c.capacity, 0) / seg.length;
      findings.push({ id: `cap-${ph}-${hhmm(seg[0].ts).replace(":", "")}`, type: ph === "storm" ? "capacity_reduction" : "capacity_recovery", summary: `${ph}: ${hhmm(seg[0].ts)}-${hhmm(Date.parse(seg.at(-1)!.ts) + 5 * 60e3)} UTC, ${mins} min at ${avg.toFixed(1)} movements per 5 min (${Math.round((100 * avg * 12) / i.nominalPerHour)}% of nominal), band ${Math.min(...seg.map((c) => c.low))}-${Math.max(...seg.map((c) => c.high))}`, confidence: ph === "storm" ? 0.84 : 0.7, evidence: seg.map((c) => c.ts), entities: ["runways"], data: { phase: ph, from: seg[0].ts, minutes: mins, avgPer5: +avg.toFixed(2), factor: +((avg * 12) / i.nominalPerHour).toFixed(2), lightningBuckets: i.weather.filter((w) => seg.some((c) => c.ts === w.ts) && w.lightningWithin5nm).length } });
    }
    k = j;
  }
  const gaps = i.weather.filter((w, n) => n > 0 && Date.parse(w.ts) - Date.parse(i.weather[n - 1].ts) > 5 * 60e3).length;
  if (gaps) warnings.push(`${gaps} gap(s) in the weather feed; capacity carried forward`);
  if (!findings.length) findings.push({ id: "cap-normal", type: "capacity_normal", summary: `no capacity reduction in the window: ${i.nominalPerHour} movements per hour throughout`, confidence: 0.9, evidence: cap.map((c) => c.ts), entities: ["runways"], data: { factor: 1 } });
  return { findings, confidence: gaps ? 0.6 : 0.84, warnings, capacity: cap };
}

// ---------- the four parallel analysts (sonnet) ----------
export interface RiskInput { flights: Flight[]; aircraft: Aircraft[]; start: string; end: string; capacity: CapacityBucket[]; deep?: boolean }
export function flightRiskAgent(i: RiskInput): { findings: Finding[]; confidence: number; assumptions: string[]; times: FlightTimes[] } {
  const times = propagate(i, i.capacity, { priority: "fifo" });
  const ac = new Map(i.aircraft.map((a) => [a.tail, a]));
  const T = timesMap(times);
  const findings: Finding[] = [];
  const delayed = times.filter((t) => t.delayMin > 15);
  const total = times.reduce((s, t) => s + Math.max(0, t.delayMin), 0);
  findings.push({ id: "delay-propagation", type: "delay_propagation", summary: `${delayed.length} of ${times.length} movements delayed over 15 min under the capacity curve (FIFO); ${total} delay minutes in total, worst ${Math.max(0, ...times.map((t) => t.delayMin))} min`, confidence: 0.86, evidence: delayed.map((t) => t.id), entities: delayed.map((t) => t.id), data: { delayedOver15: delayed.length, totalDelayMin: total, maxDelayMin: Math.max(0, ...times.map((t) => t.delayMin)), movements: times.length } });
  const turn = i.flights.filter((f) => f.kind === "departure").map((d) => { const a = T.get(d.other)!; const need = Date.parse(a.estimated) + (ac.get(d.tail)?.turnaroundMin ?? 40) * 60e3; return { d, lateBy: Math.round((need - Date.parse(d.scheduled)) / 60e3) }; }).filter((x) => x.lateBy > 0).sort((a, b) => b.lateBy - a.lateBy);
  for (const t of turn.slice(0, 12)) findings.push({ id: `turnaround-${t.d.id}`, type: "turnaround_failure", summary: `${t.d.tail} cannot make ${t.d.id} at ${hhmm(t.d.scheduled)}: inbound ${t.d.other} lands ${T.get(t.d.other)!.delayMin} min late, turnaround ${ac.get(t.d.tail)?.turnaroundMin} min, departure slips ${t.lateBy} min`, confidence: 0.82, evidence: [t.d.id, t.d.other], entities: [t.d.tail, t.d.id], data: { lateByMin: t.lateBy, inboundDelayMin: T.get(t.d.other)!.delayMin, turnaroundMin: ac.get(t.d.tail)?.turnaroundMin } });
  const holding = times.filter((t) => t.kind === "arrival" && t.holdMin >= 25);
  for (const h of holding) findings.push({ id: `holding-${h.id}`, type: "holding_risk", summary: `${h.id} holds ${h.holdMin} min before landing; block-time reserve at risk beyond 25 min`, confidence: 0.75, evidence: [h.id], entities: [h.id], data: { holdMin: h.holdMin } });
  return { findings, confidence: conf(Math.min(3, (delayed.length ? 1 : 0) + (turn.length ? 1 : 0) + (holding.length ? 1 : 0)), 3), assumptions: ["FIFO runway queue by scheduled time", "turnaround minutes by aircraft type, no quick-turn procedures"], times };
}

export interface GateInput { flights: Flight[]; aircraft: Aircraft[]; gates: Gate[]; times: FlightTimes[] }
export function gateAgent(i: GateInput): { findings: Finding[]; confidence: number; assumptions: string[]; occupancies: Occupancy[] } {
  const occ = occupancies(i, timesMap(i.times));
  const conflicts = gateConflicts(occ);
  const findings: Finding[] = conflicts.slice(0, 20).map((c) => ({ id: `gate-conflict-${c.gate}-${c.a.tail}-${c.b.tail}`, type: "gate_conflict", summary: `gate ${c.gate}: ${c.a.tail} (${c.a.arrival}/${c.a.departure}) and ${c.b.tail} (${c.b.arrival}/${c.b.departure}) overlap ${c.overlapMin} min after the delays`, confidence: 0.9, evidence: [c.a.arrival, c.a.departure, c.b.arrival, c.b.departure], entities: [c.gate, c.a.tail, c.b.tail], data: { gate: c.gate, overlapMin: c.overlapMin, from: new Date(Math.max(c.a.from, c.b.from)).toISOString() } }));
  const maint = i.gates.filter((g) => g.maintenance);
  if (maint.length) findings.push({ id: "gates-unavailable", type: "gates_unavailable", summary: `${maint.map((g) => g.id).join(", ")} closed for maintenance; ${i.gates.filter((g) => !g.maintenance && !g.remote).length} contact gates and ${i.gates.filter((g) => g.remote).length} remote stands usable`, confidence: 0.95, evidence: [], entities: maint.map((g) => g.id), data: { closed: maint.map((g) => g.id) } });
  const wide = occ.filter((o) => o.cls === "wide");
  const wideGates = i.gates.filter((g) => !g.maintenance && g.compatible.includes("wide"));
  findings.push({ id: "widebody-constraint", type: "widebody_constraint", summary: `${wide.length} wide-body rotations compete for ${wideGates.filter((g) => !g.remote).length} wide-capable contact gates (${wideGates.filter((g) => !g.remote).map((g) => g.id).join(", ")}) plus ${wideGates.filter((g) => g.remote).length} remote stands`, confidence: 0.9, evidence: wide.map((o) => o.arrival), entities: wideGates.map((g) => g.id), data: { wideRotations: wide.length, wideContactGates: wideGates.filter((g) => !g.remote).length } });
  return { findings, confidence: conflicts.length ? 0.88 : 0.8, assumptions: ["gate occupancy = arrival + taxi-in - 5 min to departure - taxi-out + 5 min", "maintenance closures hold for the whole window"], occupancies: occ };
}

export interface PaxInput { itineraries: Itinerary[]; gates: Gate[]; airport: Scenario["airport"]; times: FlightTimes[]; deep?: boolean; narrow?: boolean }
/** Misconnection cohorts. At the normal tier the terminal transfer table is not available, so cross-terminal connections
 *  inside 10 minutes of the generic cross-terminal MCT are judged at 0.55; the escalated call carries the table and refines them. */
export function passengerAgent(i: PaxInput): { findings: Finding[]; confidence: number; assumptions: string[]; warnings: string[] } {
  const T = timesMap(i.times);
  const sc = { airport: i.deep ? i.airport : { ...i.airport, transferMin: {} }, gates: i.gates, itineraries: i.itineraries };
  const conns = connections(sc, T);
  const refined = conns.map((c) => {
    if (!c.crossTerminal) return { ...c, uncertain: false };
    const ga = i.gates.find((g) => g.id === T.get(c.itinerary.inbound)!.gate)!, gd = i.gates.find((g) => g.id === T.get(c.itinerary.outbound)!.gate)!;
    const transfer = i.airport.transferMin[`${ga.terminal}-${gd.terminal}`];
    if (i.deep && transfer !== undefined) { const need = i.airport.mctMin.sameTerminal + transfer + (ga.remote ? i.airport.mctMin.remoteExtra : 0) + (gd.remote ? i.airport.mctMin.remoteExtra : 0); return { ...c, neededMin: need, made: c.gapMin >= need, uncertain: false }; }
    // no table entry (a remote stand): the airport's generic cross-terminal rule is the best available, at either tier
    return { ...c, uncertain: !i.deep && Math.abs(c.gapMin - c.neededMin) <= 10 };
  });
  const cohorts = new Map<string, { outbound: string; pax: number; vulnerable: number; shortfallMin: number; uncertain: boolean; itineraries: string[] }>();
  for (const c of refined) {
    if (c.made) continue;
    const k = cohorts.get(c.itinerary.outbound) ?? { outbound: c.itinerary.outbound, pax: 0, vulnerable: 0, shortfallMin: 0, uncertain: false, itineraries: [] };
    k.pax += c.itinerary.pax; k.vulnerable += c.itinerary.mobility || c.itinerary.minor ? c.itinerary.pax : 0; k.shortfallMin = Math.max(k.shortfallMin, c.neededMin - c.gapMin); k.uncertain ||= c.uncertain; k.itineraries.push(c.itinerary.id);
    cohorts.set(c.itinerary.outbound, k);
  }
  const list = [...cohorts.values()].sort((a, b) => b.vulnerable - a.vulnerable || b.pax - a.pax);
  const findings: Finding[] = list.map((k) => ({ id: `cohort-${k.outbound}`, type: "misconnection_cohort", summary: `${k.pax} passengers miss ${k.outbound} (departs ${hhmm(T.get(k.outbound)!.estimated)}) by up to ${k.shortfallMin} min${k.vulnerable ? `, ${k.vulnerable} with reduced mobility or unaccompanied` : ""}${k.uncertain ? " (cross-terminal: transfer time not available at this tier)" : ""}`, confidence: k.uncertain ? 0.55 : 0.88, evidence: k.itineraries, entities: [k.outbound], data: { pax: k.pax, vulnerable: k.vulnerable, shortfallMin: k.shortfallMin, uncertain: k.uncertain } }));
  // outbounds with any cross-terminal connection within 10 min of the generic MCT, made or missed: the cheap tier cannot resolve them
  const unresolved = [...new Set(refined.filter((c) => c.uncertain).map((c) => c.itinerary.outbound))].sort();
  const total = list.reduce((s, k) => s + k.pax, 0), vul = list.reduce((s, k) => s + k.vulnerable, 0);
  // the escalated call answers only the uncertain cohorts; it must not restate the whole summary from a subset
  if (!i.narrow) findings.unshift({ id: "misconnections", type: "misconnection_summary", summary: `${total} connecting passengers in ${list.length} cohorts miss their onward flight under the baseline delays, ${vul} of them vulnerable; priority order: vulnerable first, then cohort size`, confidence: 0.88, evidence: refined.filter((c) => !c.made).map((c) => c.itinerary.id), entities: list.map((k) => k.outbound), data: { misconnected: total, vulnerable: vul, cohorts: list.length, uncertainCohorts: list.filter((k) => k.uncertain).length, uncertainOutbounds: unresolved } });
  const warnings = unresolved.length ? [`${unresolved.length} outbound flight(s) have cross-terminal connections judged on the generic ${i.airport.mctMin.crossTerminal}-min MCT: terminal transfer times were not available at this tier`] : [];
  return { findings, confidence: unresolved.length ? 0.55 : 0.88, assumptions: ["a connection is made when the gap at the estimated times covers the minimum connection time for the gate pair", "vulnerable = reduced mobility or unaccompanied minor"], warnings };
}

export interface GroundInput { occupancies: Occupancy[]; resources: Resource[]; weather: WeatherObservation[]; start: string; end: string }
export function groundOpsAgent(i: GroundInput): { findings: Finding[]; confidence: number; assumptions: string[] } {
  const closures = rampClosures(i.weather);
  const { peaks } = resourcePeaks(i.occupancies, i.resources, closures, Date.parse(i.start), Date.parse(i.end));
  const findings: Finding[] = [];
  for (const c of closures) findings.push({ id: `ramp-stop-${hhmm(c[0]).replace(":", "")}`, type: "ramp_lightning_stop", summary: `ramp closed ${hhmm(c[0])}-${hhmm(c[1])} UTC (lightning within 5 nm): no fuelling, loading or pushback; ${i.occupancies.filter((o) => o.from < c[1] && o.to > c[0]).length} aircraft at gates wait`, confidence: 0.9, evidence: i.weather.filter((w) => Date.parse(w.ts) >= c[0] && Date.parse(w.ts) < c[1]).map((w) => w.ts), entities: ["ramp"], data: { from: new Date(c[0]).toISOString(), to: new Date(c[1]).toISOString(), minutes: (c[1] - c[0]) / 60e3 } });
  for (const p of peaks) if (p.bucketsOver) findings.push({ id: `peak-${p.type}`, type: "resource_peak", summary: `${p.type}: demand peaks at ${p.peak} against ${p.capacity} available around ${hhmm(p.worstAt)} UTC, over capacity in ${p.bucketsOver} five-minute buckets`, confidence: 0.8, evidence: [], entities: i.resources.filter((r) => r.type === p.type).map((r) => r.id), data: { type: p.type, peak: p.peak, capacity: p.capacity, bucketsOver: p.bucketsOver, worstAt: new Date(p.worstAt).toISOString() } });
  const oos = i.resources.filter((r) => r.status === "out_of_service");
  if (oos.length) findings.push({ id: "out-of-service", type: "resource_out_of_service", summary: `${oos.map((r) => r.id).join(", ")} out of service`, confidence: 0.95, evidence: [], entities: oos.map((r) => r.id), data: { ids: oos.map((r) => r.id) } });
  return { findings, confidence: findings.length ? 0.85 : 0.7, assumptions: ["each turnaround needs one tug, one fuel truck and one baggage crew for its first 30 minutes at the gate", "crews are not modelled"] };
}

// ---------- optimizer-agent (sonnet): invokes the solver, never reasons about the schedule in text ----------
export interface OptimizeInput { scenario: Scenario; capacity: CapacityBucket[]; stormPlusMin?: number; disruption: Disruption }
export interface Sensitivity { stormPlusMin: number; misconnected: Record<string, number>; totalDelayMin: Record<string, number> }
export function optimizerAgent(i: OptimizeInput, now: () => number = Date.now, nodeCap?: number): { findings: Finding[]; confidence: number; assumptions: string[]; options: RecoveryOption[]; sensitivity: Sensitivity } {
  const options = [noActionOption(i.scenario, i.capacity), ...STRATEGIES.map((s) => buildOption(i.scenario, i.capacity, s, now, nodeCap))];
  // falsifiable assumption: the storm ends as declared. Re-run every option with the storm 15 minutes longer.
  const plus = i.stormPlusMin ?? 15;
  const longer: Disruption = { ...i.disruption, triggerPayload: { ...i.disruption.triggerPayload, durationMin: i.disruption.triggerPayload.durationMin + plus } };
  const cap2 = capacityCurve(applyDisruption(i.scenario.weather, longer), i.scenario.airport.nominalMovementsPerHour);
  const alt = [noActionOption(i.scenario, cap2), ...STRATEGIES.map((s) => buildOption(i.scenario, cap2, s, now, nodeCap))];
  const sensitivity: Sensitivity = { stormPlusMin: plus, misconnected: Object.fromEntries(alt.map((o) => [o.id, o.passengerImpact.misconnected])), totalDelayMin: Object.fromEntries(alt.map((o) => [o.id, o.operationalChanges.totalDelayMin])) };
  const findings: Finding[] = options.map((o) => ({ id: `option-${o.id}`, type: "recovery_option", summary: `${o.name}: ${o.passengerImpact.misconnected} misconnected (${o.passengerImpact.vulnerableMisconnected} vulnerable), ${o.operationalChanges.totalDelayMin} delay minutes, ${o.operationalChanges.gateChanges.length} gate changes, ${o.operationalChanges.holds.length} holds; solver ${o.solverMetadata.optimal ? "optimal" : "best found"} in ${o.solverMetadata.nodes} nodes`, confidence: o.solverMetadata.feasible ? (o.solverMetadata.optimal ? 0.9 : 0.7) : 0.2, evidence: o.operationalChanges.gateChanges.map((g) => g.flight), entities: [o.id], data: { ...o, times: undefined, solverMetadata: { ...o.solverMetadata, ms: 0 } } as unknown as Record<string, unknown> })); // wall-clock ms is not part of an agent's deterministic output (it would change the token count between runs); the options returned to callers keep it
  return { findings, confidence: options.every((o) => o.solverMetadata.feasible) ? 0.88 : 0.4, assumptions: ["the capacity curve from the weather agent holds", "holds shift both legs of a rotation and keep the runway order"], options, sensitivity };
}

/** After the escalated call has refined the cohorts, the summary finding must say what the merged cohorts say (the cheap tier's
 *  summary was written before the refinement and would undercount). */
export function refreshPaxSummary(findings: Finding[]): Finding[] {
  const cohorts = findings.filter((f) => f.type === "misconnection_cohort");
  const total = cohorts.reduce((s, f) => s + Number(f.data.pax), 0), vul = cohorts.reduce((s, f) => s + Number(f.data.vulnerable), 0), unc = cohorts.filter((f) => f.data.uncertain).length;
  return findings.map((f) => f.type !== "misconnection_summary" ? f : { ...f, summary: `${total} connecting passengers in ${cohorts.length} cohorts miss their onward flight under the baseline delays, ${vul} of them vulnerable; priority order: vulnerable first, then cohort size`, confidence: unc ? 0.55 : 0.88, entities: cohorts.map((c) => c.entities[0]), evidence: cohorts.flatMap((c) => c.evidence), data: { ...f.data, misconnected: total, vulnerable: vul, cohorts: cohorts.length, uncertainCohorts: unc, uncertainOutbounds: unc ? f.data.uncertainOutbounds : [] } });
}
