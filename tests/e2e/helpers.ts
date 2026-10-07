import { expect, type Page } from "@playwright/test";

export const state = (page: Page) => page.evaluate(() => {
  const h = (window as unknown as { __aether?: { state: () => Record<string, unknown> } }).__aether;
  if (!h) return { view: null, load: { status: "booting" } } as Record<string, unknown>;
  const s = h.state();
  const agents = s.agents as Record<string, { status: string; model: string; escalatedFrom?: string }>;
  const options = s.options as { id: string; status: string; passengerImpact: { misconnected: number }; operationalChanges: { gateChanges: unknown[]; holds: unknown[]; totalDelayMin: number } }[];
  return { view: s.view, load: s.load, feed: s.feed, stage: s.stage, analysisStatus: (s.analysis as { status: string } | null)?.status ?? null, findings: (s.findings as unknown[]).length, options: options.map((o) => ({ id: o.id, mis: o.passengerImpact.misconnected, changes: o.operationalChanges.gateChanges.length, holds: o.operationalChanges.holds.length, delay: o.operationalChanges.totalDelayMin })), recommended: (s.recommendation as { recommended: string } | null)?.recommended ?? null, selectedOption: s.selectedOption, approvedOption: s.approvedOption, compare: s.compare, agents: Object.fromEntries(Object.entries(agents).map(([k, v]) => [k, { status: v.status, model: v.model, from: v.escalatedFrom ?? null }])), invocations: (s.invocations as { agent_name: string; model_alias: string; status: string; retry_count: number; escalated_from: string | null }[]).map((i) => [i.agent_name, i.model_alias, i.status, i.retry_count, i.escalated_from]), selectedFlight: s.selectedFlight, selectedGate: s.selectedGate, selectedFinding: s.selectedFinding, cursor: s.cursor, t0: (s.window as { t0: number }).t0, reduced: s.reduced, listView: s.listView, webgl: s.webgl, approval: s.approval ? { by: (s.approval as { approvedBy: string }).approvedBy } : null, focus: s.focus, panel: s.panel, faults: s.faults, disruption: !!s.disruption };
});
export async function ready(page: Page, url = "/") {
  await page.goto(url);
  await expect.poll(async () => (await state(page)).load, { timeout: 30_000 }).toMatchObject({ status: "ready" });
}
/** Wait until the plans are ready (analysis and optimization done). */
export async function plansReady(page: Page, timeout = 90_000) {
  await expect.poll(async () => (await state(page)).options, { timeout }).toHaveLength(4);
}
export async function analyzed(page: Page, timeout = 90_000) {
  await expect.poll(async () => (await state(page)).analysisStatus, { timeout }).not.toBeNull();
}
