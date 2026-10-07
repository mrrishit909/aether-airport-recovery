"use client";
// Appendix C "Required Cost Dashboards" over every run this session: cost per run and per approved outcome, tokens by agent
// and model, escalation rate between tiers, retry waste by error class, cache hits and avoided calls, and the
// latency/cost/quality Pareto for the routing policy.
import { useMemo } from "react";
import { summarize, type Invocation } from "@aether/agents";
import { useApp } from "../store.ts";
import { n, pct, usd } from "./fmt.ts";

const COL: Record<string, string> = { haiku: "#8fa3bf", sonnet: "#7fb2ff", opus: "#c792ff" };

export default function Costs() {
  const runs = useApp((s) => s.runs);
  const approval = useApp((s) => s.approval);
  const recommendation = useApp((s) => s.recommendation);
  const rows = useMemo(() => runs.flat() as Invocation[], [runs]);
  const conf = useMemo(() => { const m = new Map<string, number>(); if (recommendation) for (const r of rows) if (r.agent_name === "recovery-synthesizer") m.set(r.id, recommendation.confidence); return m; }, [rows, recommendation]);
  const s = summarize(rows, conf);
  const outcomes = approval ? 1 : 0;
  if (!rows.length) return <section className="costs" aria-label="Cost dashboard"><h2>Costs</h2><p className="empty">No runs yet. Every agent call is recorded as an Appendix C row (model, effort, prompt version, tokens, cost, latency, retries, status, result hash); this view aggregates them.</p></section>;
  const maxC = Math.max(...s.pareto.map((p) => p.costUsd), 1e-6), maxL = Math.max(...s.pareto.map((p) => p.latencyMs), 1);
  return (
    <section className="costs" aria-label="Cost dashboard">
      <h2>Costs <i>{s.runs} run{s.runs === 1 ? "" : "s"} this session · {s.invocations} calls</i></h2>
      <div className="stats">
        <div><b>{usd(s.costPerRun)}</b><span>cost per run</span></div>
        <div><b>{outcomes ? usd(s.totalCostUsd / outcomes) : "—"}</b><span>cost per approved outcome</span></div>
        <div><b>{pct(s.escalations.rate)}</b><span>escalation rate ({s.escalations.haikuToSonnet} H→S, {s.escalations.sonnetToOpus} S→O)</span></div>
        <div><b>{s.retries.count}</b><span>retries · {n(s.retries.wastedMs)} ms wasted{Object.keys(s.retries.byError).length ? ` (${Object.entries(s.retries.byError).map(([k, v]) => `${k} ${v}`).join(", ")})` : ""}</span></div>
        <div><b>{pct(s.cache.hitRate)}</b><span>cache hits · {usd(s.cache.avoidedCostUsd)} avoided</span></div>
      </div>
      <div className="two">
        <div className="table-wrap"><table><caption>Tokens and cost by agent and model</caption><thead><tr><th>Agent</th><th>Model</th><th className="num">Calls</th><th className="num">In</th><th className="num">Out</th><th className="num">Cost</th><th className="num">p50 ms</th></tr></thead>
          <tbody>{s.byAgent.map((a) => <tr key={a.agent + a.model}><td>{a.agent}</td><td style={{ color: COL[a.model] }}>{a.model}</td><td className="num">{a.calls}</td><td className="num">{n(a.inputTokens)}</td><td className="num">{n(a.outputTokens)}</td><td className="num">{usd(a.costUsd)}</td><td className="num">{n(a.p50LatencyMs)}</td></tr>)}</tbody></table></div>
        <div>
          <table><caption>By model</caption><thead><tr><th>Model</th><th className="num">Calls</th><th className="num">In</th><th className="num">Out</th><th className="num">Cost</th></tr></thead>
            <tbody>{(["haiku", "sonnet", "opus"] as const).map((m) => <tr key={m}><td style={{ color: COL[m] }}>{m}</td><td className="num">{s.byModel[m].calls}</td><td className="num">{n(s.byModel[m].inputTokens)}</td><td className="num">{n(s.byModel[m].outputTokens)}</td><td className="num">{usd(s.byModel[m].costUsd)}</td></tr>)}</tbody></table>
          <svg viewBox="0 0 320 170" role="img" aria-label="Pareto: cost (x) against latency (y) per call, coloured by model" className="pareto">
            <line x1={34} x2={310} y1={140} y2={140} stroke="#1f2a3a" /><line x1={34} x2={34} y1={10} y2={140} stroke="#1f2a3a" />
            <text x={310} y={156} textAnchor="end" fontSize={10} fill="#9aa6b8">cost per call → {usd(maxC)}</text><text x={6} y={14} fontSize={10} fill="#9aa6b8">latency ↑ {n(maxL)} ms</text>
            {s.pareto.map((p, i) => <circle key={i} cx={34 + (p.costUsd / maxC) * 270} cy={140 - (p.latencyMs / maxL) * 125} r={4} fill={COL[p.model]} opacity={0.85}><title>{p.agent} on {p.model}: {usd(p.costUsd)}, {p.latencyMs} ms{p.confidence !== null ? `, confidence ${pct(p.confidence)}` : ""}</title></circle>)}
          </svg>
        </div>
      </div>
    </section>
  );
}
