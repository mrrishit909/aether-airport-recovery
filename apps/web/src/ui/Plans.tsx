"use client";
// The recovery plans: option cards (reference + three solver-backed plans), the synthesizer's recommendation with its tradeoffs and
// falsifiable assumptions, the approval gate, and the compare table that sits under the synchronized split view.
import { jump, selectFlight, selectOption, set, toggleCompare, useApp } from "../store.ts";
const approveOpen = () => set({ approveOpen: true });
import { hhmm, mins, n, pct } from "./fmt.ts";

export function RecoveryPlans() {
  const options = useApp((s) => s.options);
  const rec = useApp((s) => s.recommendation);
  const sel = useApp((s) => s.selectedOption);
  const cmp = useApp((s) => s.compare);
  const approved = useApp((s) => s.approvedOption);
  const approval = useApp((s) => s.approval);
  const sens = useApp((s) => s.sensitivity);
  const view = useApp((s) => s.view);
  if (!options.length || !rec) return null;
  const maxMis = Math.max(1, ...options.map((o) => o.passengerImpact.misconnected));
  const o = options.find((x) => x.id === sel) ?? options[0];
  const tr = rec.tradeoffs.find((t) => t.optionId === o.id);
  return (
    <section aria-label="Recovery plans">
      <h2>Recovery plans <i>{rec.title}</i></h2>
      <ul className="plans">
        {options.map((x) => (
          <li key={x.id} className={`plan ${sel === x.id ? "on" : ""} ${approved === x.id ? "approved" : ""}`}>
            <button className="plan-main" aria-pressed={sel === x.id} onClick={() => selectOption(x.id)}>
              <span className="plan-head"><b>{x.id === "W" ? "Reference" : `Option ${x.id}`}</b> {x.name}{rec.recommended === x.id ? <em className="badge-rec">recommended</em> : null}{approved === x.id ? <em className="badge-ok">approved</em> : null}</span>
              <span className="plan-bar" aria-hidden="true"><i style={{ width: `${(100 * x.passengerImpact.misconnected) / maxMis}%` }} /></span>
              <span className="plan-meta">{x.passengerImpact.misconnected} misconnected ({x.passengerImpact.vulnerableMisconnected} vulnerable) · {n(x.operationalChanges.totalDelayMin)} delay min · {x.operationalChanges.gateChanges.length} gate changes · {x.operationalChanges.holds.length} holds</span>
            </button>
            <label className="small cmp"><input type="checkbox" checked={!!cmp?.includes(x.id)} onChange={() => toggleCompare(x.id)} aria-label={`Compare option ${x.id}`} /> compare</label>
          </li>
        ))}
      </ul>
      <h3>Why option {rec.recommended}</h3>
      <ul className="narr">{rec.narrative.map((t, i) => <li key={i}>{t}</li>)}</ul>
      <h3>Option {o.id}: {o.name}</h3>
      <dl className="kv">
        <dt>Strengths</dt><dd>{tr?.strengths.join("; ") || "none in a single category"}</dd>
        <dt>Costs</dt><dd>{tr?.costs.join("; ") || "none"}</dd>
        <dt>Solver</dt><dd>{o.id === "W" ? "no search: every aircraft waits for its own gate" : `${o.solverMetadata.optimal ? "proven optimal" : "best found, not proven optimal"} · ${n(o.solverMetadata.nodes)} nodes · ${o.solverMetadata.ms} ms · ${o.solverMetadata.rotations} rotations`}</dd>
        <dt>Weights</dt><dd>{o.id === "W" ? "—" : `change ${o.strategy.weights.change} · connections ${o.strategy.weights.walk} · remote ${o.strategy.weights.remote} · delay ${o.strategy.weights.delay}`}</dd>
        <dt>Bussed</dt><dd>{n(o.passengerImpact.onRemoteStand)} passengers on remote stands</dd>
        <dt>Late</dt><dd>{o.operationalChanges.delayedOver15} movements over 15 min, worst {mins(o.operationalChanges.maxDelayMin)}</dd>
      </dl>
      {tr?.policyFlags.length ? <><h3>Policy flags</h3><ul className="flags">{tr.policyFlags.map((f, i) => <li key={i}>{f}</li>)}</ul></> : null}
      {o.operationalChanges.gateChanges.length ? <><h3>Gate changes ({o.operationalChanges.gateChanges.length})</h3><ul className="mini">{o.operationalChanges.gateChanges.map((g) => <li key={g.flight}><button onClick={() => { selectFlight(g.flight); const t = o.times.find((x) => x.id === g.flight); if (t) jump(Date.parse(t.estimated)); }}>{g.flight}: {g.from} → {g.to}</button></li>)}</ul></> : null}
      {o.operationalChanges.holds.length ? <><h3>Holds ({o.operationalChanges.holds.length})</h3><ul className="mini">{o.operationalChanges.holds.map((h) => <li key={h.flight}><button onClick={() => selectFlight(h.flight)}>{h.flight}: hold {h.minutes} min</button></li>)}</ul></> : null}
      {o.passengerImpact.cohorts.length ? <><h3>Largest misconnection cohorts</h3><ul className="mini">{o.passengerImpact.cohorts.slice(0, 5).map((c) => <li key={c.outbound}><button onClick={() => selectFlight(c.outbound)}>{c.pax} miss {c.outbound} by {c.shortfallMin} min{c.vulnerable ? ` · ${c.vulnerable} vulnerable` : ""}</button></li>)}</ul></> : null}
      <h3>Assumptions to watch</h3>
      <ol className="assume">{rec.assumptions.map((a, i) => <li key={i}><b>{a.text}.</b> <span className="muted">Check: {a.check}.</span> <span>{a.sensitivity}.</span></li>)}</ol>
      {sens ? <p className="small muted">Sensitivity is a real re-run with the storm {sens.stormPlusMin} minutes longer.</p> : null}
      <h3>The dispatcher must confirm</h3>
      <ul className="flags">{rec.dispatcherMustConfirm.map((d, i) => <li key={i}>{d}</li>)}</ul>
      <p className="small muted">Confidence {pct(rec.confidence)} · {rec.impact.passengersAffected} passengers affected without action · best {rec.impact.misconnectedBest} / worst {rec.impact.misconnectedWorst} misconnected across the options</p>
      <div className="row">
        {approval ? <p className="ok-text" role="status">Option {approval.optionKey} approved by {approval.approvedBy} at {hhmm(approval.at)} UTC ({approval.mode}). <a download="dispatch-order.md" href={`data:text/markdown;charset=utf-8,${encodeURIComponent(approval.planMarkdown)}`}>Download the dispatch order</a></p>
          : <button className="primary" onClick={() => approveOpen()} disabled={view === "optimizing" || o.id === "W"} title={o.id === "W" ? "The reference is the do-nothing baseline, not a plan to approve" : undefined}>Approve option {o.id}{tr?.policyFlags.length ? ` (${tr.policyFlags.length} flags)` : ""}</button>}
      </div>
    </section>
  );
}

/** The synchronized split view's table: every metric of the two options on one clock, the better one marked. */
export function ComparePanel() {
  const cmp = useApp((s) => s.compare);
  const options = useApp((s) => s.options);
  const cursor = useApp((s) => s.cursor);
  const t0 = useApp((s) => s.window.t0);
  if (!cmp) return null;
  const [a, b] = cmp.map((k) => options.find((o) => o.id === k)!);
  if (!a || !b) return null;
  const rows: { label: string; va: number | string; vb: number | string; low?: boolean }[] = [
    { label: "Misconnected passengers", va: a.passengerImpact.misconnected, vb: b.passengerImpact.misconnected, low: true },
    { label: "…of them vulnerable", va: a.passengerImpact.vulnerableMisconnected, vb: b.passengerImpact.vulnerableMisconnected, low: true },
    { label: "Total delay (min)", va: a.operationalChanges.totalDelayMin, vb: b.operationalChanges.totalDelayMin, low: true },
    { label: "Movements over 15 min", va: a.operationalChanges.delayedOver15, vb: b.operationalChanges.delayedOver15, low: true },
    { label: "Worst delay (min)", va: a.operationalChanges.maxDelayMin, vb: b.operationalChanges.maxDelayMin, low: true },
    { label: "Gate changes", va: a.operationalChanges.gateChanges.length, vb: b.operationalChanges.gateChanges.length, low: true },
    { label: "Holds", va: a.operationalChanges.holds.length, vb: b.operationalChanges.holds.length, low: true },
    { label: "Passengers on remote stands", va: a.passengerImpact.onRemoteStand, vb: b.passengerImpact.onRemoteStand, low: true },
    { label: "Ground resource buckets over capacity", va: a.operationalChanges.resourcePeakOver, vb: b.operationalChanges.resourcePeakOver, low: true },
    { label: "Solver", va: a.id === "W" ? "none" : `${a.solverMetadata.optimal ? "optimal" : "best found"}, ${n(a.solverMetadata.nodes)} nodes`, vb: b.id === "W" ? "none" : `${b.solverMetadata.optimal ? "optimal" : "best found"}, ${n(b.solverMetadata.nodes)} nodes` },
  ];
  const mark = (r: (typeof rows)[number], side: "a" | "b") => typeof r.va === "number" && typeof r.vb === "number" && r.low && r.va !== r.vb && (side === "a" ? r.va < r.vb : r.vb < r.va) ? " ✓" : "";
  return (
    <section className="compare" aria-label="Plan comparison">
      <table>
        <caption>Option {a.id} against option {b.id}, same clock: T{cursor >= t0 ? "+" : "−"}{Math.abs(Math.round((cursor - t0) / 60e3))} min</caption>
        <thead><tr><th>Metric</th><th className="optA">{a.id} · {a.name}</th><th className="optB">{b.id} · {b.name}</th><th className="num">Difference</th></tr></thead>
        <tbody>{rows.map((r) => <tr key={r.label}><th scope="row">{r.label}</th><td className="num">{r.va}{mark(r, "a")}</td><td className="num">{r.vb}{mark(r, "b")}</td><td className="num muted">{typeof r.va === "number" && typeof r.vb === "number" ? (r.vb - r.va > 0 ? "+" : "") + (r.vb - r.va) : ""}</td></tr>)}</tbody>
      </table>
      <button className="small" onClick={() => set({ compare: null })}>Close split view</button>
    </section>
  );
}
