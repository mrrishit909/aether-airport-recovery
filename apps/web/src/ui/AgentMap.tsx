"use client";
// The orchestration view: which agents ran, on which tier, what they received and returned, where the workflow escalated or
// retried, and what each call cost. Drawn as a small SVG graph plus a per-invocation table; nothing here is decorative.
import { AGENT_ORDER, useApp } from "../store.ts";
import { n, usd } from "./fmt.ts";

const TIER_Y = { haiku: 150, sonnet: 95, opus: 40 } as const;
const COL: Record<string, string> = { haiku: "#8fa3bf", sonnet: "#7fb2ff", opus: "#c792ff" };

export default function AgentMap() {
  const agents = useApp((s) => s.agents);
  const inv = useApp((s) => s.invocations);
  const rawTokens = useApp((s) => s.rawTokens);
  const synth = useApp((s) => s.synthesisInputTokens);
  const X = Object.fromEntries(AGENT_ORDER.map((a, i) => [a, 70 + i * 143]));
  const rows = inv.length ? inv : [];
  return (
    <section className="agentmap" aria-label="Agent map">
      <h2>Agent map <i>{rows.length ? `${rows.length} calls · ${usd(rows.reduce((s, r) => s + r.estimated_cost_usd, 0))} · raw window ${n(rawTokens)} tokens${synth ? `, synthesizer input ${n(synth)}` : ""}` : "idle: nothing has run yet"}</i></h2>
      <svg viewBox="0 0 1000 190" role="img" aria-label="Agents by model tier; arrows show escalation">
        {(["opus", "sonnet", "haiku"] as const).map((t) => <g key={t}><line x1={20} x2={980} y1={TIER_Y[t]} y2={TIER_Y[t]} stroke="#1f2a3a" /><text x={22} y={TIER_Y[t] - 6} fill={COL[t]} fontSize={11} fontFamily="monospace">{t}</text></g>)}
        {AGENT_ORDER.slice(0, -1).map((a, i) => { const b = AGENT_ORDER[i + 1]; const ya = TIER_Y[agents[a]?.model ?? "sonnet"], yb = TIER_Y[agents[b]?.model ?? "sonnet"]; return <line key={a} x1={X[a] + 22} x2={X[b] - 22} y1={ya} y2={yb} stroke="#2a3a52" strokeDasharray={i === 0 || i === 5 ? "" : "3 3"} />; })}
        {AGENT_ORDER.map((a) => {
          const st = agents[a]; const m = st?.model ?? "sonnet"; const y = TIER_Y[m];
          const from = st?.escalatedFrom; const status = st?.status ?? "idle";
          return (
            <g key={a}>
              {from ? <g><line x1={X[a]} x2={X[a]} y1={TIER_Y[from]} y2={y + 12} stroke="#ffb454" strokeWidth={2} markerEnd="url(#arrow)" /><text x={X[a] + 16} y={(TIER_Y[from] + y) / 2 + 4} fill="#ffb454" fontSize={10}>escalated from {from}</text></g> : null}
              <circle cx={X[a]} cy={y} r={status === "running" || status === "retrying" ? 14 : 11} fill={status === "idle" ? "#0d1320" : status === "failed" ? "#3a1b1b" : COL[m]} stroke={status === "failed" ? "#ff6b5a" : status === "running" ? "#fff" : COL[m]} strokeWidth={status === "running" ? 3 : 1.5} />
              <text x={X[a]} y={y + 4} textAnchor="middle" fontSize={10} fill={status === "idle" ? "#9aa6b8" : "#03050a"} fontWeight={700}>{m[0].toUpperCase()}</text>
              <text x={X[a]} y={178} textAnchor="middle" fontSize={10.5} fill="#e6ebf2">{a.replace("-agent", "").replace("recovery-", "")}</text>
              <text x={X[a]} y={y + 28} textAnchor="middle" fontSize={9.5} fill="#9aa6b8">{status === "retrying" ? `retry ${st.attempt}` : status === "cache" ? "cache hit" : status}</text>
            </g>
          );
        })}
        <defs><marker id="arrow" markerWidth="6" markerHeight="6" refX="5" refY="3" orient="auto"><path d="M0,0 L6,3 L0,6 z" fill="#ffb454" /></marker></defs>
      </svg>
      <div className="table-wrap">
        <table>
          <caption>Every call this run (Appendix C row: model, effort, tokens, cost, latency, retries, status)</caption>
          <thead><tr><th>Agent</th><th>Model</th><th>Effort</th><th className="num">In</th><th className="num">Out</th><th className="num">Cost</th><th className="num">ms</th><th className="num">Retries</th><th>Status</th><th>Note</th></tr></thead>
          <tbody>{rows.map((r) => <tr key={r.id} className={r.escalated_from ? "esc" : ""}><td>{r.agent_name}</td><td>{r.model_alias}</td><td>{r.effort}</td><td className="num">{n(r.input_tokens)}</td><td className="num">{n(r.output_tokens)}</td><td className="num">{usd(r.estimated_cost_usd)}</td><td className="num">{n(r.latency_ms)}</td><td className="num">{r.retry_count}</td><td>{r.status}</td><td className="muted">{r.escalated_from ? `escalated from ${r.escalated_from}` : r.error_code ?? ""}</td></tr>)}</tbody>
        </table>
      </div>
    </section>
  );
}
