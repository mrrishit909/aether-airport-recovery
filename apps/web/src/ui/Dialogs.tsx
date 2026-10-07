"use client";
// Approval gate, command palette and keyboard help. Native <dialog> for focus trapping and Escape.
import { useEffect, useMemo, useRef, useState } from "react";
import { approve, get, jump, runAll, selectFlight, selectGate, selectOption, set, triggerDisruption, useApp } from "../store.ts";
import { pct, words } from "./fmt.ts";

function useDialog(open: boolean, onClose: () => void) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current; if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
    const c = () => onClose();
    d.addEventListener("close", c);
    return () => d.removeEventListener("close", c);
  }, [open, onClose]);
  return ref;
}

export function ApproveDialog() {
  const open = useApp((s) => s.approveOpen);
  const sel = useApp((s) => s.selectedOption);
  const options = useApp((s) => s.options);
  const rec = useApp((s) => s.recommendation);
  const close = useMemo(() => () => set({ approveOpen: false }), []);
  const ref = useDialog(open, close);
  const [note, setNote] = useState("");
  const [ack, setAck] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const o = options.find((x) => x.id === sel);
  const flags = rec?.tradeoffs.find((t) => t.optionId === sel)?.policyFlags ?? [];
  return (
    <dialog ref={ref} aria-labelledby="approve-title" className="dialog">
      <form method="dialog" onSubmit={async (e) => { e.preventDefault(); setBusy(true); setError(""); try { await approve(note, ack); } catch (err) { setError((err as Error).message); } setBusy(false); }}>
        <h2 id="approve-title">Approve the recovery plan</h2>
        <p className="small">{o ? `Option ${o.id}, ${o.name}: ${o.operationalChanges.gateChanges.length} gate changes, ${o.operationalChanges.holds.length} holds, ${o.passengerImpact.misconnected} misconnected passengers.` : ""} Approval is the human gate: it records who approved which option, makes it the plan on the airport, hashes the dispatch order and writes the audit log (in the Docker stack). No agent can take this step.</p>
        {flags.length ? <><ul className="flags">{flags.map((f, i) => <li key={i}>{f}</li>)}</ul><label className="check"><input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} /> I confirm {flags.length} policy flag{flags.length > 1 ? "s" : ""}; the dispatch order will record them as acknowledged.</label></> : null}
        <label>Note <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="optional, goes into the dispatch order" maxLength={500} /></label>
        {error ? <p className="errors" role="alert">{error}</p> : null}
        <div className="row"><button className="primary" type="submit" disabled={busy}>{busy ? "Approving…" : "Approve and dispatch"}</button><button type="button" onClick={close}>Cancel</button></div>
      </form>
    </dialog>
  );
}

export function Palette() {
  const open = useApp((s) => s.palette);
  const close = useMemo(() => () => set({ palette: false }), []);
  const ref = useDialog(open, close);
  const [q, setQ] = useState("");
  const [k, setK] = useState(0);
  const findings = useApp((s) => s.findings);
  const options = useApp((s) => s.options);
  const flightById = useApp((s) => s.flightById);
  const gateById = useApp((s) => s.gateById);
  const items = useMemo(() => {
    const t = q.trim().toLowerCase();
    const actions = [
      { label: "Trigger the thunderstorm", run: () => triggerDisruption() },
      { label: "Run the full recovery workflow", run: () => runAll() },
      { label: "Open the agent map", run: () => set({ panel: "agents" }) },
      { label: "Open the cost dashboard", run: () => set({ panel: "costs" }) },
      { label: "Toggle list view", run: () => set((s) => ({ listView: !s.listView })) },
      { label: "Toggle reduced motion", run: () => set((s) => ({ reduced: !s.reduced })) },
      { label: "Jump to the start of the storm", run: () => jump(get().window.t0) },
      { label: "Approve the selected plan", run: () => set({ approveOpen: true }) },
    ].filter((a) => !t || a.label.toLowerCase().includes(t));
    const os = options.filter((o) => !t || `option ${o.id} ${o.name}`.toLowerCase().includes(t)).map((o) => ({ label: `Show option ${o.id} · ${o.name}`, run: () => selectOption(o.id) }));
    const fs = findings.filter((f) => !t || `${f.type} ${f.summary}`.toLowerCase().includes(t)).slice(0, 6).map((f) => ({ label: `${pct(f.confidence)} ${words(f.type)} · ${f.summary.slice(0, 70)}`, run: () => import("../store.ts").then((m) => m.selectFinding(f.id)) }));
    const fl = t.length < 2 ? [] : [...flightById.values()].filter((f) => f.id.toLowerCase().includes(t) || f.tail.toLowerCase().includes(t)).slice(0, 6).map((f) => ({ label: `${f.id} · ${f.kind} · ${f.tail}`, run: () => selectFlight(f.id) }));
    const gs = t.length < 2 ? [] : [...gateById.values()].filter((g) => g.id.toLowerCase().includes(t)).slice(0, 4).map((g) => ({ label: `Gate ${g.id}`, run: () => selectGate(g.id) }));
    return [...fs, ...fl, ...gs, ...os, ...actions];
  }, [q, findings, options, flightById, gateById]);
  const run = (i: number) => { items[i]?.run(); set({ palette: false }); setQ(""); };
  return (
    <dialog ref={ref} className="dialog palette" aria-label="Command palette">
      <input autoFocus placeholder="Search findings, flights, gates, plans, actions…" value={q} role="combobox" aria-expanded aria-controls="palette-list" aria-activedescendant={`pi-${k}`}
        onChange={(e) => { setQ(e.target.value); setK(0); }}
        onKeyDown={(e) => { if (e.key === "ArrowDown") { e.preventDefault(); setK(Math.min(items.length - 1, k + 1)); } if (e.key === "ArrowUp") { e.preventDefault(); setK(Math.max(0, k - 1)); } if (e.key === "Enter") { e.preventDefault(); run(k); } }} />
      <ul id="palette-list" role="listbox">{items.map((it, i) => <li key={i} id={`pi-${i}`} role="option" aria-selected={i === k}><button onClick={() => run(i)}>{it.label}</button></li>)}</ul>
    </dialog>
  );
}

export function Help() {
  const open = useApp((s) => s.help);
  const close = useMemo(() => () => set({ help: false }), []);
  const ref = useDialog(open, close);
  const keys = [["⌘K / Ctrl K / /", "search and commands"], ["T", "trigger the thunderstorm"], ["R", "run the agents"], ["G", "generate the plans"], ["I", "run the full recovery"], ["Space", "play / pause the replay"], ["← →", "scrub 5 minutes (Shift: 30)"], ["[ ]", "previous / next finding"], ["N", "next plan"], ["V", "split view of the recommended plan against the reference"], ["0 – 4", "camera: airport, runway, gates, aircraft, passengers"], ["A", "agent map"], ["C", "costs"], ["L", "list view"], ["M", "reduced motion"], ["P", "pause all motion"], ["Esc", "back"]];
  return (
    <dialog ref={ref} className="dialog" aria-labelledby="help-title">
      <h2 id="help-title">Keyboard</h2>
      <table><tbody>{keys.map(([a, b]) => <tr key={a}><th scope="row"><kbd>{a}</kbd></th><td>{b}</td></tr>)}</tbody></table>
      <button onClick={close}>Close</button>
    </dialog>
  );
}
