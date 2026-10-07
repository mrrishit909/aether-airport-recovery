export const n = (x: number) => x.toLocaleString("en-US");
export const usd = (x: number) => (x < 0.01 ? `$${x.toFixed(4)}` : `$${x.toFixed(2)}`);
export const pct = (x: number) => `${Math.round(x * 100)}%`;
export const utc = (t: number | string) => { const d = new Date(t); return `${d.toISOString().slice(5, 10).replace("-", " ")} ${d.toISOString().slice(11, 19)} UTC`; };
export const hhmm = (t: number | string) => new Date(t).toISOString().slice(11, 16);
export const mins = (m: number) => (Math.abs(m) >= 60 ? `${Math.floor(m / 60)} h ${Math.abs(m) % 60} min` : `${m} min`);
export const tier = { haiku: "H", sonnet: "S", opus: "O" } as const;
export const sevIcon = { critical: "▲▲", high: "▲", medium: "◆", low: "●" } as const;
export const words = (s: string) => s.replace(/_/g, " ");
/** Which application agent produced a finding (for grouping and the evidence packet). */
export const AGENT_OF: Record<string, string> = { capacity_reduction: "weather-agent", capacity_recovery: "weather-agent", capacity_normal: "weather-agent", delay_propagation: "flight-risk-agent", turnaround_failure: "flight-risk-agent", holding_risk: "flight-risk-agent", gate_conflict: "gate-agent", gates_unavailable: "gate-agent", widebody_constraint: "gate-agent", misconnection_summary: "passenger-agent", misconnection_cohort: "passenger-agent", ramp_lightning_stop: "ground-ops-agent", resource_peak: "ground-ops-agent", resource_out_of_service: "ground-ops-agent" };
export const GROUP_OF = (type: string) => (AGENT_OF[type] ?? "optimizer-agent").replace("-agent", "");
export const delayClass = (d: number) => (d <= 5 ? "ok" : d <= 15 ? "warn" : "bad");
