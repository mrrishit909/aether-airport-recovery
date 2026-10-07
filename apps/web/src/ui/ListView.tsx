"use client";
// Every fact in the scene as tables: the capacity curve, findings, the plans side by side, the selected plan's gate changes and
// lost connections, and every flight with its time and gate in the plan on screen. Also the fallback when WebGL is missing or
// the GPU context is lost.
import { connections } from "@aether/domain";
import { planOf, selectFinding, selectFlight, useApp } from "../store.ts";
import { hhmm, pct, words } from "./fmt.ts";

export default function ListView() {
  const findings = useApp((s) => s.findings);
  const options = useApp((s) => s.options);
  const sel = useApp((s) => s.selectedOption);
  const rec = useApp((s) => s.recommendation);
  const scenario = useApp((s) => s.scenario);
  const analysis = useApp((s) => s.analysis);
  const preview = useApp((s) => s.preview);
  const webgl = useApp((s) => s.webgl);
  const plan = useApp((s) => planOf(s));
  const capacity = analysis?.capacity ?? preview?.capacity ?? [];
  const o = options.find((x) => x.id === sel);
  const lost = scenario && plan ? connections(scenario, plan.times).filter((c) => !c.made) : [];
  return (
    <main className="listview" aria-label="List view">
      {webgl !== "ok" ? <div className="banner warn" role="status">{webgl === "lost" ? "The GPU context was lost; every fact is in these tables until it is restored." : "WebGL is not available here; every fact is in these tables."}</div> : null}
      {capacity.length ? <div className="table-wrap"><table><caption>Runway capacity per 5 minutes ({capacity.filter((c) => c.phase !== "normal").length} reduced buckets)</caption><thead><tr><th>From (UTC)</th><th className="num">Capacity</th><th className="num">Band</th><th>Phase</th></tr></thead>
        <tbody>{capacity.filter((c) => c.phase !== "normal").map((c) => <tr key={c.ts}><td>{hhmm(c.ts)}</td><td className="num">{c.capacity}</td><td className="num">{c.low}–{c.high}</td><td>{c.phase}</td></tr>)}</tbody></table></div> : null}
      {findings.length ? <div className="table-wrap"><table><caption>Findings ({findings.length})</caption><thead><tr><th>Confidence</th><th>Agent</th><th>Type</th><th>Summary</th></tr></thead>
        <tbody>{findings.map((f) => <tr key={f.id}><td className="num">{pct(f.confidence)}</td><td>{f.type.includes("recovery") ? "optimizer" : f.type}</td><td><button className="link" onClick={() => selectFinding(f.id)}>{words(f.type)}</button></td><td style={{ whiteSpace: "normal" }}>{f.summary}</td></tr>)}</tbody></table></div> : null}
      {options.length ? <div className="table-wrap"><table><caption>Recovery plans{rec ? `: option ${rec.recommended} recommended` : ""}</caption><thead><tr><th>Option</th><th className="num">Misconnected</th><th className="num">Vulnerable</th><th className="num">Delay min</th><th className="num">Gate changes</th><th className="num">Holds</th><th className="num">Bussed pax</th><th>Solver</th><th>Status</th></tr></thead>
        <tbody>{options.map((x) => <tr key={x.id}><td>{x.id} · {x.name}</td><td className="num">{x.passengerImpact.misconnected}</td><td className="num">{x.passengerImpact.vulnerableMisconnected}</td><td className="num">{x.operationalChanges.totalDelayMin}</td><td className="num">{x.operationalChanges.gateChanges.length}</td><td className="num">{x.operationalChanges.holds.length}</td><td className="num">{x.passengerImpact.onRemoteStand}</td><td>{x.id === "W" ? "none" : `${x.solverMetadata.optimal ? "optimal" : "best found"}, ${x.solverMetadata.nodes} nodes`}</td><td>{x.status}</td></tr>)}</tbody></table></div> : null}
      {o ? <div className="table-wrap"><table><caption>Gate changes in option {o.id} ({o.operationalChanges.gateChanges.length})</caption><thead><tr><th>Flight</th><th>From</th><th>To</th></tr></thead>
        <tbody>{o.operationalChanges.gateChanges.map((g) => <tr key={g.flight}><td><button className="link" onClick={() => selectFlight(g.flight)}>{g.flight}</button></td><td>{g.from}</td><td>{g.to}</td></tr>)}</tbody></table></div> : null}
      <div className="table-wrap"><table><caption>Connections lost in the plan on screen ({lost.reduce((s, c) => s + c.itinerary.pax, 0)} passengers in {lost.length} itineraries)</caption><thead><tr><th>Inbound</th><th>Outbound</th><th className="num">Pax</th><th className="num">Gap</th><th className="num">Needed</th><th>Vulnerable</th></tr></thead>
        <tbody>{lost.map((c) => <tr key={c.itinerary.id}><td>{c.itinerary.inbound}</td><td>{c.itinerary.outbound}</td><td className="num">{c.itinerary.pax}</td><td className="num">{c.gapMin}</td><td className="num">{c.neededMin}</td><td>{c.itinerary.mobility || c.itinerary.minor ? "yes" : ""}</td></tr>)}</tbody></table></div>
      {scenario && plan ? <div className="table-wrap"><table><caption>Flights in the plan on screen ({scenario.flights.length})</caption><thead><tr><th>Flight</th><th>Kind</th><th>Tail</th><th>Scheduled</th><th>Estimated</th><th className="num">Delay</th><th>Gate</th><th className="num">Pax</th></tr></thead>
        <tbody>{scenario.flights.map((f) => { const t = plan.times.get(f.id)!; return <tr key={f.id}><td><button className="link" onClick={() => selectFlight(f.id)}>{f.id}</button></td><td>{f.kind}</td><td>{f.tail}</td><td>{hhmm(f.scheduled)}</td><td>{hhmm(t.estimated)}</td><td className="num">{t.delayMin}</td><td>{t.gate}{t.gate !== f.gate ? ` (was ${f.gate})` : ""}</td><td className="num">{f.pax}</td></tr>; })}</tbody></table></div> : null}
    </main>
  );
}
