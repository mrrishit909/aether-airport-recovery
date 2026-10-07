// The expensive end of the workflow: the recovery synthesizer (opus tier) compares the solver's options on compact structured
// results only, names the tradeoffs, flags policy violations, and states the assumptions as checks a dispatcher can falsify.
import type { Finding } from "@aether/agents";
import type { Sensitivity } from "./analysis.ts";
import type { RecoveryOption, Recommendation, Tradeoff } from "./types.ts";

export type CompactOption = Omit<RecoveryOption, "times">;
export interface SynthesisInput { options: CompactOption[]; sensitivity: Sensitivity; stormMinutes: number; capacityFactor: number; analystWarnings: string[]; misconnectedBaseline: number; vulnerableBaseline: number; delayedBaseline: number }

/** Dispatcher policy, as a harm score: a vulnerable misconnection costs far more than a gate change. */
export const harm = (o: CompactOption) => o.passengerImpact.misconnected * 3 + o.passengerImpact.vulnerableMisconnected * 20 + o.operationalChanges.totalDelayMin / 10 + o.operationalChanges.gateChanges.length * 2 + o.operationalChanges.holds.length * 4;

export function synthesize(i: SynthesisInput): { recommendation: Recommendation; confidence: number; assumptions: string[] } {
  const O = i.options;
  const best = (k: (o: CompactOption) => number) => O.reduce((b, o) => (k(o) < k(b) ? o : b), O[0]);
  const byHarm = [...O].sort((a, b) => harm(a) - harm(b) || a.id.localeCompare(b.id));
  const rec = byHarm[0];
  const tradeoffs: Tradeoff[] = O.map((o) => {
    const strengths: string[] = [], costs: string[] = [], flags: string[] = [];
    if (o === best((x) => x.passengerImpact.misconnected)) strengths.push(`fewest misconnections (${o.passengerImpact.misconnected})`);
    if (o === best((x) => x.operationalChanges.totalDelayMin)) strengths.push(`least total delay (${o.operationalChanges.totalDelayMin} min)`);
    if (o === best((x) => x.operationalChanges.gateChanges.length)) strengths.push(`fewest gate changes (${o.operationalChanges.gateChanges.length})`);
    if (o === best((x) => x.passengerImpact.onRemoteStand)) strengths.push(`fewest passengers bussed (${o.passengerImpact.onRemoteStand})`);
    if (o.passengerImpact.misconnected > best((x) => x.passengerImpact.misconnected).passengerImpact.misconnected) costs.push(`${o.passengerImpact.misconnected - best((x) => x.passengerImpact.misconnected).passengerImpact.misconnected} more misconnected than the best option`);
    if (o.operationalChanges.totalDelayMin > best((x) => x.operationalChanges.totalDelayMin).operationalChanges.totalDelayMin) costs.push(`${o.operationalChanges.totalDelayMin - best((x) => x.operationalChanges.totalDelayMin).operationalChanges.totalDelayMin} more delay minutes`);
    if (o.operationalChanges.gateChanges.length > best((x) => x.operationalChanges.gateChanges.length).operationalChanges.gateChanges.length) costs.push(`${o.operationalChanges.gateChanges.length} gate changes to brief`);
    if (o.operationalChanges.holds.length) costs.push(`${o.operationalChanges.holds.length} aircraft held ${Math.max(...o.operationalChanges.holds.map((h) => h.minutes))} min or less for a gate`);
    if (o.passengerImpact.vulnerableMisconnected > 0) flags.push(`${o.passengerImpact.vulnerableMisconnected} vulnerable passengers misconnect: assistance must be arranged before approval`);
    if (o.operationalChanges.maxDelayMin > 60) flags.push(`a movement is delayed ${o.operationalChanges.maxDelayMin} min: crew duty limits need checking`);
    if (!o.solverMetadata.optimal) flags.push(`solver stopped at ${o.solverMetadata.nodes} nodes: best found, not proven optimal (bound ${o.solverMetadata.bound})`);
    if (o.operationalChanges.resourcePeakOver > 0) flags.push(`ground resources over capacity in ${o.operationalChanges.resourcePeakOver} five-minute buckets`);
    return { optionId: o.id, strengths, costs, policyFlags: flags };
  });
  const sens = i.sensitivity;
  const assumptions = [
    { text: `the storm ends after ${i.stormMinutes} minutes as declared`, check: `if the cell is still over the field at +${i.stormMinutes} min, re-run optimize with the longer duration`, sensitivity: `with ${sens.stormPlusMin} more minutes of storm, misconnections become ${O.map((o) => `${o.id} ${sens.misconnected[o.id]}`).join(", ")} (now ${O.map((o) => `${o.id} ${o.passengerImpact.misconnected}`).join(", ")})` },
    { text: `runway capacity recovers to ${Math.round(i.capacityFactor * 100)}% during the cell and one movement per 5 minutes afterwards`, check: "compare the first 15 minutes of actual movements against the curve", sensitivity: "every 10% of capacity not recovered adds roughly a bucket of queue to every later movement" },
    { text: "passengers connect when the gap covers the minimum connection time for the gate pair", check: "spot-check two cross-terminal cohorts with the ground handler", sensitivity: "a 5-minute longer transfer moves the cohorts judged within 10 minutes of the MCT" },
  ];
  const confidence = +Math.max(0.3, Math.min(0.9, 0.9 - 0.1 * tradeoffs.find((t) => t.optionId === rec.id)!.policyFlags.length - (i.analystWarnings.length ? 0.05 : 0))).toFixed(2);
  const narrative = [
    `${i.stormMinutes}-minute capacity reduction to ${Math.round(i.capacityFactor * 100)}%: doing nothing (every aircraft waits for its own gate) ${i.misconnectedBaseline} connecting passengers (${i.vulnerableBaseline} vulnerable) miss their flight and ${i.delayedBaseline} movements run over 15 minutes late.`,
    `Recommended: option ${rec.id}, ${rec.name}: ${rec.passengerImpact.misconnected} misconnected, ${rec.operationalChanges.totalDelayMin} delay minutes, ${rec.operationalChanges.gateChanges.length} gate changes, ${rec.operationalChanges.holds.length} holds (harm score ${harm(rec).toFixed(0)} against ${byHarm.slice(1).map((o) => `${o.id} ${harm(o).toFixed(0)}`).join(", ")}).`,
    ...tradeoffs.filter((t) => t.optionId !== rec.id).map((t) => `Option ${t.optionId}: ${t.strengths.join("; ") || "no category win"}; costs ${t.costs.join("; ") || "none"}.`),
  ];
  return {
    recommendation: {
      title: `Recover from the ${i.stormMinutes}-minute storm with option ${rec.id}`, recommended: rec.id, confidence, narrative, tradeoffs, assumptions,
      dispatcherMustConfirm: [...new Set([...tradeoffs.find((t) => t.optionId === rec.id)!.policyFlags, ...(rec.operationalChanges.gateChanges.length ? [`brief ${rec.operationalChanges.gateChanges.length} gate changes to the ground handler and the airline`] : []), ...i.analystWarnings.map((w) => `analyst warning: ${w}`)])],
      impact: { flights: O[0].operationalChanges.delayedOver15, passengersAffected: i.misconnectedBaseline, misconnectedBest: Math.min(...O.map((o) => o.passengerImpact.misconnected)), misconnectedWorst: Math.max(...O.map((o) => o.passengerImpact.misconnected)), delayBestMin: Math.min(...O.map((o) => o.operationalChanges.totalDelayMin)), delayWorstMin: Math.max(...O.map((o) => o.operationalChanges.totalDelayMin)) },
    },
    confidence, assumptions: assumptions.map((a) => a.text),
  };
}

export function recommendationFinding(r: Recommendation): Finding {
  return { id: "recommendation", type: "recovery_recommendation", summary: r.title, confidence: r.confidence, evidence: [], entities: [r.recommended], data: r as unknown as Record<string, unknown> };
}

/** The dispatch order as a text document (what "approve" exports). */
export function dispatchMarkdown(rec: Recommendation, opt: RecoveryOption, approvedBy: string, at: string) {
  const lines = [`# Dispatch order: option ${opt.id}, ${opt.name}`, "", `Approved by ${approvedBy} at ${at} · synthesizer confidence ${rec.confidence}`, "", "## Why", ...rec.narrative.map((n) => `- ${n}`), "", "## Gate changes"];
  for (const g of opt.operationalChanges.gateChanges) lines.push(`- ${g.flight}: ${g.from} → ${g.to}`);
  if (!opt.operationalChanges.gateChanges.length) lines.push("- none");
  lines.push("", "## Holds");
  for (const h of opt.operationalChanges.holds) lines.push(`- ${h.flight}: hold ${h.minutes} min for a gate`);
  if (!opt.operationalChanges.holds.length) lines.push("- none");
  lines.push("", "## Passengers", `- ${opt.passengerImpact.misconnected} misconnected (${opt.passengerImpact.vulnerableMisconnected} vulnerable), ${opt.passengerImpact.onRemoteStand} bussed from remote stands`);
  for (const c of opt.passengerImpact.cohorts.slice(0, 10)) lines.push(`  - ${c.pax} miss ${c.outbound} by ${c.shortfallMin} min${c.vulnerable ? ` (${c.vulnerable} vulnerable)` : ""}`);
  lines.push("", "## Dispatcher confirmed");
  for (const d of rec.dispatcherMustConfirm) lines.push(`- ${d}`);
  lines.push("", "## Assumptions to watch");
  for (const a of rec.assumptions) lines.push(`- ${a.text}. Check: ${a.check}. ${a.sensitivity}.`);
  lines.push("", "_Synthetic airport generated by AETHER; no real airport, airline or flight is involved._");
  return lines.join("\n");
}
