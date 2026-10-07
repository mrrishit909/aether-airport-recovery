"use client";
// The command center chrome: top bar with the workflow buttons and failure lab, workflow stage bar, findings panel (left),
// inspector (right: plans, evidence, flight or gate), and the replay timeline with the 90-minutes-either-side scrubber.
import { useMemo, useState } from "react";
import { AGENT_ORDER, capacityAt, get, jump, loadScenario, planOf, provider, runAll, runAnalyze, runOptimize, selectFinding, selectFlight, selectGate, set, setFault, setStress, triggerDisruption, useApp } from "../store.ts";
import { FOCI, FOCUS_LABEL } from "../journey.ts";
import { GROUP_OF, AGENT_OF, hhmm, mins, n, pct, tier, usd, utc, words } from "./fmt.ts";
import { RecoveryPlans } from "./Plans.tsx";
import { connections, gateOccupancy, poses } from "@aether/domain";

const GROUPS = ["all", "weather", "flight-risk", "gate", "passenger", "ground-ops", "optimizer"] as const;

export function TopBar() {
  const feed = useApp((s) => s.feed);
  const stage = useApp((s) => s.stage);
  const view = useApp((s) => s.view);
  const disruption = useApp((s) => s.disruption);
  const analysis = useApp((s) => s.analysis);
  const options = useApp((s) => s.options);
  const panel = useApp((s) => s.panel);
  const listView = useApp((s) => s.listView);
  const reduced = useApp((s) => s.reduced);
  const paused = useApp((s) => s.motionPaused);
  const hud = useApp((s) => s.hud);
  const faults = useApp((s) => s.faults);
  const stress = useApp((s) => s.stress);
  const [menu, setMenu] = useState(false);
  const busy = stage !== "idle";
  const feedText = { ok: "airport feed ok", down: "airport feed down", retrying: `retrying in ${Math.round(feed.waitMs / 1000)} s`, recovered: "airport feed recovered" }[feed.status];
  return (
    <header className="topbar">
      <span className="brand"><b>AETHER</b> <small>disruption recovery · {provider.kind === "api" ? "API mode" : "static sandbox"}</small></span>
      <span className={`pill feed-${feed.status}`} role="status">{feedText}</span>
      {faults.length ? <span className="pill warn-pill" title={faults.map((f) => `${f.code}${f.model ? ` on ${f.model}` : ""}${f.agent ? ` for ${f.agent}` : ""}`).join(", ")}>fault armed: {faults.map((f) => `${f.code}${f.model ? ` on ${f.model}` : ""}${f.agent ? ` for ${f.agent}` : ""}`).join(", ")}</span> : null}
      <nav aria-label="Workflow and views">
        <button className={disruption ? "" : "primary"} onClick={() => triggerDisruption()} disabled={busy}>{disruption ? "Re-trigger thunderstorm" : "Trigger thunderstorm"}</button>
        <button className={disruption && !analysis ? "primary" : ""} onClick={() => runAnalyze()} disabled={busy || !disruption}>{view === "analyzing" ? "Agents running…" : analysis ? "Re-run agents" : "Run agents"}</button>
        <button className={analysis && !options.length ? "primary" : ""} onClick={() => runOptimize()} disabled={busy || !analysis}>{view === "optimizing" ? "Solving…" : options.length ? "Re-generate plans" : "Generate plans"}</button>
        <button onClick={() => runAll()} disabled={busy} title="Trigger, run the agents and generate the plans (I)">Run full recovery</button>
        <button aria-pressed={panel === "agents"} onClick={() => set({ panel: panel === "agents" ? null : "agents" })}>Agent map</button>
        <button aria-pressed={panel === "costs"} onClick={() => set({ panel: panel === "costs" ? null : "costs" })}>Costs</button>
        <button aria-pressed={listView} onClick={() => set({ listView: !listView })}>List view</button>
        <button aria-pressed={reduced} onClick={() => set({ reduced: !reduced })}>Reduced motion</button>
        <button aria-pressed={paused} onClick={() => set({ motionPaused: !paused, playing: false })}>{paused ? "Resume motion" : "Pause motion"}</button>
        <button aria-pressed={hud} onClick={() => set({ hud: !hud })}>Telemetry</button>
        <span className="menu">
          <button aria-haspopup="menu" aria-expanded={menu} onClick={() => setMenu(!menu)}>Failure lab ▾</button>
          {menu ? (
            <div className="menu-pop" role="menu">
              <button role="menuitem" onClick={() => { setMenu(false); provider.feedDown = true; loadScenario(); }}>Cut the airport feed</button>
              <button role="menuitem" onClick={() => { setMenu(false); provider.feedDown = false; loadScenario(); }}>Restore the airport feed</button>
              <button role="menuitem" onClick={() => { setMenu(false); setFault("rate-limit-storm"); }}>Arm a 429 storm on haiku and sonnet</button>
              <button role="menuitem" onClick={() => { setMenu(false); setFault("ground-outage"); }}>Arm a ground-ops provider outage</button>
              <button role="menuitem" onClick={() => { setMenu(false); setFault("opus-timeout"); }}>Arm one opus timeout</button>
              <button role="menuitem" onClick={() => { setMenu(false); setFault(null); }}>Disarm faults</button>
              <button role="menuitem" onClick={() => { setMenu(false); setStress(!stress); }}>{stress ? "Stress test off" : "Stress test: 5,000 more aircraft"}</button>
            </div>
          ) : null}
        </span>
        <button onClick={() => set({ help: true })} aria-label="Keyboard help">?</button>
      </nav>
    </header>
  );
}

export function Banner() {
  const feed = useApp((s) => s.feed);
  const webgl = useApp((s) => s.webgl);
  const runError = useApp((s) => s.runError);
  const view = useApp((s) => s.view);
  if (runError) return <div className="banner warn" role="alert">Workflow problem: {runError}. <button onClick={() => (view === "analyzed" || view === "review" ? runOptimize() : runAnalyze())}>Retry</button></div>;
  if (feed.status === "retrying") return <div className="banner warn" role="alert">Airport feed unavailable ({feed.message}). Retry {feed.attempt} in {Math.round(feed.waitMs / 1000)} s. The last good schedule stays usable.</div>;
  if (feed.status === "down") return <div className="banner warn" role="alert">Airport feed is down. Showing the last good schedule. <button onClick={() => loadScenario()}>Retry now</button></div>;
  if (feed.status === "recovered") return <div className="banner ok" role="status">Airport feed recovered. <button onClick={() => set((s) => ({ feed: { ...s.feed, status: "ok" } }))}>Dismiss</button></div>;
  if (webgl === "lost") return <div className="banner warn" role="alert">The GPU context was lost; the list view carries every fact until it is restored.</div>;
  return null;
}

export function StageBar() {
  const stage = useApp((s) => s.stage);
  const log = useApp((s) => s.stageLog);
  const agents = useApp((s) => s.agents);
  const view = useApp((s) => s.view);
  const analysis = useApp((s) => s.analysis);
  const options = useApp((s) => s.options);
  const invocations = useApp((s) => s.invocations);
  const stages = ["weather", "constraints", "analyze", "optimize", "synthesize", "done"] as const;
  const done = options.length > 0;
  const at = done ? 5 : stages.indexOf(stage as (typeof stages)[number]);
  if (stage === "idle" && !analysis && !done) return null;
  const last = log.at(-1);
  const running = AGENT_ORDER.filter((a) => ["running", "retrying", "escalated"].includes(agents[a]?.status));
  const cost = invocations.reduce((a, i) => a + i.estimated_cost_usd, 0);
  return (
    <div className="stagebar" role="status" aria-live="polite" aria-label="Workflow progress">
      <ol>{stages.map((s, i) => <li key={s} className={i < at || (done && i <= at) ? "past" : i === at ? "now" : ""}>{s}</li>)}</ol>
      <p className="small">{done ? `plans ready in ${view === "approved" ? "approved state" : "review"} · ${options.length - 1} options + reference · ${invocations.length} agent calls · ${usd(cost)}` : stage === "idle" && analysis ? `analysis ${analysis.status} · ${analysis.findings.length} findings · ${usd(cost)} so far` : running.length ? running.map((a) => `${a} (${tier[agents[a].model]}${agents[a].status === "retrying" ? ", retry" : agents[a].status === "escalated" ? ", escalated" : ""})`).join(" · ") : last?.message ?? ""}</p>
    </div>
  );
}

export function FindingsPanel() {
  const findings = useApp((s) => s.findings);
  const sel = useApp((s) => s.selectedFinding);
  const stage = useApp((s) => s.stage);
  const scenario = useApp((s) => s.scenario);
  const disruption = useApp((s) => s.disruption);
  const preview = useApp((s) => s.preview);
  const [filter, setFilter] = useState<(typeof GROUPS)[number]>("all");
  const groups = useMemo(() => { const g: Record<string, typeof findings> = {}; for (const f of findings) (g[GROUP_OF(f.type)] ??= []).push(f); return g; }, [findings]);
  const late = preview ? preview.queued.filter((t) => t.delayMin > 15).length : 0;
  const pax = scenario ? scenario.itineraries.reduce((s, i) => s + i.pax, 0) : 0;
  return (
    <aside className="panel left" aria-label="Findings">
      <h2>Findings <i>{findings.length ? `${findings.length} from ${new Set(findings.flatMap((f) => f.evidence)).size} evidence items` : stage !== "idle" ? "…" : disruption ? `${late} movements over 15 min late` : `${scenario?.flights.length ?? 0} flights · ${n(pax)} connecting passengers`}</i></h2>
      <div className="chips" role="group" aria-label="Filter by agent">{GROUPS.map((k) => <button key={k} className="chip" aria-pressed={filter === k} onClick={() => setFilter(k)}>{k}</button>)}</div>
      {!findings.length ? <p className="empty">{!disruption ? "Press Trigger thunderstorm: runway capacity falls and the delays propagate through every aircraft rotation. Then run the agents." : stage !== "idle" ? "Agents are working. Findings appear as each one returns." : "The storm is declared and the delays are propagating. Run the agents: the weather agent turns the feed into capacity, then four analysts work in parallel."}</p> : null}
      <ul className="cj-list">
        {Object.entries(groups).filter(([k]) => filter === "all" || k === filter).flatMap(([k, fs]) => fs.map((f) => (
          <li key={f.id}><button className={`cj-row ${sel === f.id ? "active" : ""}`} aria-current={sel === f.id} onClick={() => selectFinding(f.id)}>
            <span className="who"><span className={`risk conf-${f.confidence >= 0.8 ? "high" : f.confidence >= 0.6 ? "medium" : "low"}`}>{pct(f.confidence)}</span> {words(f.type)} <i>· {k}</i></span>
            <span className="meta">{f.summary.slice(0, 74)}{f.summary.length > 74 ? "…" : ""}</span>
          </button></li>
        )))}
      </ul>
    </aside>
  );
}

function EvidencePacket({ id }: { id: string }) {
  const f = useApp((s) => s.findings.find((x) => x.id === id));
  const agents = useApp((s) => s.agents);
  if (!f) return null;
  const agent = AGENT_OF[f.type] ?? "optimizer-agent";
  const inv = agents[agent]?.invocation;
  return (
    <section aria-label="Evidence packet">
      <p className="risk big">{words(f.type)}</p>
      <p>{f.summary}</p>
      <dl className="kv">
        <dt>Agent</dt><dd>{agent} on <b>{agents[agent]?.model ?? "sonnet"}</b>{agents[agent]?.escalatedFrom ? ` (escalated from ${agents[agent].escalatedFrom})` : ""}</dd>
        <dt>Confidence</dt><dd>{pct(f.confidence)}</dd>
        {inv ? <><dt>Call</dt><dd>{n(inv.input_tokens)} in / {n(inv.output_tokens)} out tokens · {usd(inv.estimated_cost_usd)} · {inv.latency_ms} ms</dd></> : null}
        <dt>About</dt><dd>{f.entities.slice(0, 12).map((e) => <button key={e} className="link" onClick={() => (/^[A-Z][0-9]{1,2}$/.test(e) ? selectGate(e) : /^[A-Z0-9]{3,10}$/.test(e) && !e.startsWith("SN-") ? selectFlight(e) : undefined)}>{e}</button>)}</dd>
      </dl>
      {Object.keys(f.data).length ? <details><summary>Structured output</summary><pre className="small">{JSON.stringify(f.data, null, 1)}</pre></details> : null}
    </section>
  );
}

function FlightCard({ id }: { id: string }) {
  const fl = useApp((s) => s.flightById.get(id));
  const scenario = useApp((s) => s.scenario);
  const plan = useApp((s) => planOf(s));
  if (!fl || !scenario || !plan) return null;
  const t = plan.times.get(fl.id)!, ac = scenario.aircraft.find((a) => a.tail === fl.tail)!;
  const cs = connections(scenario, plan.times).filter((c) => c.itinerary.inbound === fl.id || c.itinerary.outbound === fl.id);
  const missed = cs.filter((c) => !c.made);
  return (
    <section aria-label="Flight">
      <p className="risk big">{fl.id} · {fl.kind} · {fl.tail}</p>
      <dl className="kv">
        <dt>Aircraft</dt><dd>{ac.type} ({ac.cls}, {ac.seats} seats, {ac.turnaroundMin} min turn)</dd>
        <dt>{fl.kind === "arrival" ? "From" : "To"}</dt><dd>{fl.city}</dd>
        <dt>Scheduled</dt><dd>{hhmm(fl.scheduled)} UTC</dd>
        <dt>In this plan</dt><dd>{hhmm(t.estimated)} UTC · {t.delayMin > 0 ? `${mins(t.delayMin)} late` : "on time"}</dd>
        <dt>Gate</dt><dd>{t.gate}{t.gate !== fl.gate ? ` (was ${fl.gate})` : ""}</dd>
        <dt>Passengers</dt><dd>{fl.pax} · {cs.reduce((s, c) => s + c.itinerary.pax, 0)} connecting · {missed.reduce((s, c) => s + c.itinerary.pax, 0)} misconnecting</dd>
        <dt>Remarks</dt><dd className="muted">{fl.remarks || "none"} <small>(untrusted text from the airline feed, shown as data)</small></dd>
      </dl>
      <div className="row">
        <button className="small" onClick={() => { set({ focus: "aircraft" }); jump(Date.parse(t.estimated)); }}>Follow aircraft</button>
        <button className="small" onClick={() => selectFlight(fl.other)}>Other leg: {fl.other}</button>
      </div>
      {missed.length ? <><h3>Connections lost in this plan</h3><ul className="mini">{missed.map((c) => <li key={c.itinerary.id}><button onClick={() => selectFlight(c.itinerary.inbound === fl.id ? c.itinerary.outbound : c.itinerary.inbound)}>{c.itinerary.pax} pax {c.itinerary.inbound} → {c.itinerary.outbound}: {c.gapMin} min, needs {c.neededMin}{c.itinerary.mobility || c.itinerary.minor ? " · vulnerable" : ""}</button></li>)}</ul></> : null}
    </section>
  );
}

function GateCard({ id }: { id: string }) {
  const g = useApp((s) => s.gateById.get(id));
  const s0 = useApp((s) => s);
  const plan = planOf(s0);
  if (!g || !plan) return null;
  const occ = s0.scenario ? poses(0, s0.rots, plan.times, s0.gateById) : [];
  void occ; void gateOccupancy;
  const rots = s0.rots.filter((r) => plan.times.get(r.arrival.id)!.gate === id).sort((a, b) => plan.times.get(a.arrival.id)!.estimated.localeCompare(plan.times.get(b.arrival.id)!.estimated));
  return (
    <section aria-label="Gate">
      <p className="risk big">Gate {g.id} · terminal {g.terminal === "R" ? "remote stands" : g.terminal}</p>
      <dl className="kv"><dt>Takes</dt><dd>{g.compatible.join(", ")}</dd><dt>Status</dt><dd>{g.maintenance ? "closed for maintenance" : g.remote ? "remote stand (bus)" : "contact gate"}</dd></dl>
      <h3>Rotations in this plan ({rots.length})</h3>
      <ul className="mini">{rots.map((r) => { const a = plan.times.get(r.arrival.id)!, d = plan.times.get(r.departure.id)!; return <li key={r.tail}><button onClick={() => { selectFlight(r.arrival.id); jump(Date.parse(a.estimated)); }}>{r.tail} {hhmm(a.estimated)}–{hhmm(d.estimated)}{r.arrival.gate !== id ? ` (from ${r.arrival.gate})` : ""}</button></li>; })}</ul>
    </section>
  );
}

export function Inspector() {
  const sel = useApp((s) => s.selectedFinding);
  const fl = useApp((s) => s.selectedFlight);
  const gate = useApp((s) => s.selectedGate);
  const focus = useApp((s) => s.focus);
  const options = useApp((s) => s.options);
  const disruption = useApp((s) => s.disruption);
  const analysis = useApp((s) => s.analysis);
  const warnings = analysis?.warnings ?? [];
  const back = () => { selectFinding(null); selectFlight(null); selectGate(null); };
  return (
    <aside className="panel right" aria-label="Inspector">
      <div className="chips" role="group" aria-label="Camera focus">{FOCI.map((f) => <button key={f} className="chip" aria-pressed={focus === f} onClick={() => set({ focus: f })}>{FOCUS_LABEL[f]}</button>)}</div>
      {sel ? <><button className="ghost small" onClick={back}>← all plans</button><EvidencePacket id={sel} /></>
        : fl ? <><button className="ghost small" onClick={back}>← all plans</button><FlightCard id={fl} /></>
        : gate ? <><button className="ghost small" onClick={back}>← all plans</button><GateCard id={gate} /></>
        : options.length ? <RecoveryPlans />
        : <p className="empty">{!disruption ? "Select an aircraft or a gate in the scene, or trigger the thunderstorm to start the demo." : !analysis ? "The storm is declared. Run the agents to get findings; then generate the plans." : "Analysis is ready. Generate plans: the optimizer calls the gate solver for three strategies and the synthesizer compares them."}{warnings.length ? <span className="challenge"><b>Analyst warnings:</b> {warnings.join("; ")}</span> : null}</p>}
    </aside>
  );
}

export function Timeline() {
  const w = useApp((s) => s.window);
  const cursor = useApp((s) => s.cursor);
  const playing = useApp((s) => s.playing);
  const speed = useApp((s) => s.speed);
  const reduced = useApp((s) => s.reduced);
  const scenario = useApp((s) => s.scenario);
  const disruption = useApp((s) => s.disruption);
  const analysis = useApp((s) => s.analysis);
  const preview = useApp((s) => s.preview);
  const options = useApp((s) => s.options);
  const sel = useApp((s) => s.selectedOption);
  const cap = useApp((s) => capacityAt(s, s.cursor));
  if (!w.end || !scenario) return null;
  const span = w.end - w.start;
  const x = (t: number) => ((t - w.start) / span) * 1000;
  const curve = analysis?.capacity ?? preview?.capacity ?? null;
  const nominal = scenario.airport.nominalMovementsPerHour / 12;
  const changes = options.find((o) => o.id === sel)?.operationalChanges.gateChanges ?? [];
  const stormEnd = disruption ? Date.parse(disruption.triggerPayload.start) + disruption.triggerPayload.durationMin * 60e3 : w.t0;
  const rel = Math.round((cursor - w.t0) / 60e3);
  const delayHist = useMemo(() => { const h = new Array(36).fill(0); const src = (analysis ? analysis.baseline : preview?.queued) ?? []; for (const t of src) { const b = Math.min(35, Math.max(0, Math.floor((Date.parse(t.estimated) - w.start) / (span / 36)))); h[b] += Math.max(0, t.delayMin); } const m = Math.max(1, ...h); return h.map((v) => v / m); }, [analysis, preview, w.start, span]);
  return (
    <div className="timeline" aria-label="Replay">
      <div className="transport">
        <button onClick={() => set({ playing: !playing, motionPaused: false })} disabled={reduced}>{playing ? "Pause" : "Play"}</button>
        <label className="small">Speed <select aria-label="Speed" value={speed} onChange={(e) => set({ speed: +e.target.value })}>{[60, 150, 300, 600].map((v) => <option key={v} value={v}>{v}×</option>)}</select></label>
        <button onClick={() => jump(w.start)}>Window start</button>
        <button onClick={() => jump(w.t0)}>Storm starts</button>
        <button onClick={() => jump(stormEnd)} disabled={!disruption}>Storm ends</button>
        <button onClick={() => jump(w.end)}>Window end</button>
        <span className="small muted cap" aria-live="off">{cap ? `runway: ${cap.capacity} of ${Math.round(nominal)} movements per 5 min (${Math.round((100 * cap.capacity) / nominal)}%)${cap.phase !== "normal" ? ` · ${cap.phase}` : ""}` : reduced ? "replay is a scrubber under reduced motion" : "trigger the storm to see capacity fall"}</span>
        <span className="clock">T{rel >= 0 ? "+" : "−"}{Math.abs(rel)} min · {utc(cursor)}</span>
      </div>
      <div className="track">
        <svg viewBox="0 0 1000 36" preserveAspectRatio="none" aria-hidden="true">
          {delayHist.map((v, i) => <rect key={i} className="hist" x={(i * 1000) / 36} y={36 - v * 34} width={1000 / 36 - 1} height={v * 34} />)}
          {disruption ? <rect className="stormband" x={x(Date.parse(disruption.triggerPayload.start))} y={0} width={x(stormEnd) - x(Date.parse(disruption.triggerPayload.start))} height={36} /> : null}
          {curve ? <polyline className="capline" fill="none" points={curve.map((c, i) => `${x(Date.parse(c.ts))},${34 - (c.capacity / nominal) * 30}`).join(" ")} /> : null}
          {changes.map((g) => { const t = options.find((o) => o.id === sel)?.times.find((q) => q.id === g.flight); return t ? <line key={g.flight} className="tick lit" x1={x(Date.parse(t.estimated))} x2={x(Date.parse(t.estimated))} y1={2} y2={36} /> : null; })}
          <line className="now" x1={x(w.t0)} x2={x(w.t0)} y1={0} y2={36} />
          <line className="cursor" x1={x(cursor)} x2={x(cursor)} y1={0} y2={36} />
        </svg>
        <input type="range" aria-label="Replay time" min={w.start} max={w.end} step={60000} value={Math.round(cursor / 60000) * 60000} onChange={(e) => { set({ playing: false }); jump(+e.target.value); }} />
        <div className="hours">{[-90, -60, -30, 0, 30, 60, 90].map((m) => <span key={m} style={{ left: `${((m + 90) / 180) * 100}%` }}>{hhmm(w.t0 + m * 60e3)}{m === 0 ? " storm" : ""}</span>)}</div>
      </div>
    </div>
  );
}

export { get };
