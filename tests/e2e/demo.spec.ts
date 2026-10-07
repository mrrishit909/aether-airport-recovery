// Blueprint 02, section 17: the demo scenario, end to end, as a dispatcher would do it.
import { expect, test } from "@playwright/test";
import { analyzed, plansReady, ready, state } from "./helpers.ts";

test("story -> trigger the storm -> capacity falls and delays propagate -> parallel agents -> three solver-backed plans -> split-view comparison -> approve and watch the airport update -> scrub the 90-minute timeline", async ({ page }) => {
  await ready(page);
  // 0. the story scrolls over the live airport; the chapters hand the camera from the airport to the runway, gates and passengers
  await expect(page.getByRole("heading", { name: /One model should not reschedule the airport/ })).toBeVisible();
  await expect(page.getByText(/connecting passengers, 30 gates/)).toContainText("90 movements");
  const intro = page.getByLabel("Introduction");
  for (const n of [1, 2, 3]) {
    await intro.evaluate((el, k) => el.querySelectorAll("[data-chapter]")[k].scrollIntoView(), n);
    await expect.poll(async () => (await state(page)).view).toBe(`intro${n}`);
  }
  await expect(page.getByText(/Doing nothing strands/)).toContainText("101");
  await page.getByRole("button", { name: "Open the command center" }).click();
  await expect.poll(async () => (await state(page)).view).toBe("explore");

  // 1. trigger the simulated thunderstorm: runway capacity falls to a quarter, delays propagate before any agent runs
  await page.getByRole("button", { name: "Trigger thunderstorm" }).click();
  await expect.poll(async () => (await state(page)).view).toBe("disrupted");
  const s1 = await state(page);
  expect(s1.cursor).toBe(s1.t0);
  await expect(page.locator(".cap")).toContainText("runway: 1 of 4 movements per 5 min (27%)");
  await expect(page.getByRole("complementary", { name: "Findings" })).toContainText("19 movements over 15 min late");

  // 2. run the parallel agents: weather on haiku, four analysts on sonnet, the passenger agent's uncertain cohorts escalated to opus
  await page.getByRole("button", { name: "Run agents" }).click();
  await expect.poll(async () => (await state(page)).view).toBe("analyzing");
  await expect(page.getByRole("status", { name: "Workflow progress" })).toBeVisible();
  await analyzed(page);
  const s2 = await state(page);
  expect(s2.analysisStatus).toBe("complete"); expect(s2.findings).toBe(35);
  const agents = s2.agents as Record<string, { status: string; model: string; from: string | null }>;
  expect(agents["weather-agent"]).toMatchObject({ status: "done", model: "haiku" });
  for (const a of ["flight-risk-agent", "gate-agent", "ground-ops-agent"]) expect(agents[a]).toMatchObject({ status: "done", model: "sonnet" });
  expect(agents["passenger-agent"]).toMatchObject({ status: "done", model: "opus", from: "sonnet" }); // the only escalation: cross-terminal cohorts at 0.55
  await page.getByRole("complementary", { name: "Findings" }).getByRole("button", { name: /gate conflict/ }).first().click();
  await expect(page.getByRole("complementary", { name: "Inspector" })).toContainText("gate-agent on sonnet");
  await page.getByRole("complementary", { name: "Inspector" }).getByRole("button", { name: "← all plans" }).click();

  // 3. generate three solver-backed plans (plus the do-nothing reference)
  await page.getByRole("button", { name: "Generate plans" }).click();
  await plansReady(page);
  const s3 = await state(page);
  expect(s3.recommended).toBe("B");
  const o = Object.fromEntries((s3.options as { id: string; mis: number; changes: number; holds: number; delay: number }[]).map((x) => [x.id, x]));
  expect(o.W).toMatchObject({ mis: 101, changes: 0 });
  expect(o.B.mis).toBeLessThan(o.W.mis / 3);
  expect(o.A.delay).toBeLessThan(o.W.delay);
  expect(o.C.changes).toBeLessThan(o.A.changes);
  const inspector = page.getByRole("complementary", { name: "Inspector" });
  await expect(inspector).toContainText("recommended");
  await expect(inspector).toContainText("Assumptions to watch");
  await expect(inspector).toContainText("The dispatcher must confirm");

  // 4. compare passenger and operational impact in a synchronized split view
  await page.getByLabel("Compare option A").check();
  await page.getByLabel("Compare option B").check();
  await expect(page.getByRole("group", { name: "Synchronized split view" })).toBeVisible();
  expect((await state(page)).compare).toEqual(["A", "B"]);
  await expect(page.locator(".split canvas")).toHaveCount(2); // the split scene is a dynamic import: wait for both canvases
  const table = page.getByRole("region", { name: "Plan comparison" });
  await expect(table).toContainText("Option A against option B");
  await expect(table.getByRole("row", { name: /Misconnected passengers/ })).toContainText("✓");
  await page.getByRole("button", { name: "Close split view" }).click();

  // 5. approve one: the human gate refuses until the policy flags are confirmed, then the airport updates
  await page.getByRole("button", { name: /Approve option B/ }).click();
  const dialog = page.getByRole("dialog", { name: "Approve the recovery plan" });
  await dialog.getByRole("button", { name: "Approve and dispatch" }).click();
  await expect(dialog.getByRole("alert")).toContainText("policy flag");
  await dialog.getByRole("checkbox").check();
  await dialog.getByRole("button", { name: "Approve and dispatch" }).click();
  await expect(inspector).toContainText("Option B approved by sandbox-dispatcher");
  expect((await state(page)).approvedOption).toBe("B");
  const href = await inspector.getByRole("link", { name: "Download the dispatch order" }).getAttribute("href");
  const md = decodeURIComponent(href!.split(",")[1]);
  expect(md).toContain("# Dispatch order: option B"); expect(md).toMatch(/- \w+: [A-C]\d+ → [A-CR]\d+/); expect(md).toContain("Synthetic airport");
  await expect.poll(async () => (await state(page)).view).toBe("approved");

  // the agent map and the cost dashboard aggregate every call of the run (a crash here was a real bug once: keep it covered)
  await page.getByRole("button", { name: "Agent map" }).click();
  await expect(page.getByRole("region", { name: "Agent map" })).toContainText("8 calls");
  await expect(page.getByRole("region", { name: "Agent map" }).locator("tr.esc")).toContainText("escalated from sonnet");
  await page.getByRole("button", { name: "Costs" }).click();
  const costs = page.getByRole("region", { name: "Cost dashboard" });
  await expect(costs).toContainText("cost per run"); await expect(costs).toContainText("1 S→O"); await expect(costs).toContainText("cost per approved outcome");
  await page.getByRole("button", { name: "Costs" }).click();

  // 6. replay: the scrubber covers 90 minutes before and after the storm, and the scene is a function of its time
  const slider = page.getByRole("slider", { name: "Replay time" });
  const t0 = (await state(page)).t0 as number;
  await expect(slider).toHaveAttribute("min", String(t0 - 90 * 60e3)); await expect(slider).toHaveAttribute("max", String(t0 + 90 * 60e3));
  await page.getByRole("button", { name: "Window start" }).click();
  await expect(page.locator(".clock")).toContainText("T−90 min");
  await expect(page.locator(".cap")).toContainText("runway: 4 of 4");
  await page.getByRole("button", { name: "Storm starts" }).click();
  await expect(page.locator(".cap")).toContainText("1 of 4");
  await page.getByRole("button", { name: "Play", exact: true }).click();
  await expect.poll(async () => (await state(page)).cursor as number, { timeout: 30_000 }).toBeGreaterThan(t0 + 10 * 60e3);
  await page.getByRole("button", { name: "Pause", exact: true }).click();

  // the deep link restores the run, the plan, the split view, the time and the camera
  await ready(page, "/?run=1&opt=A&cmp=A,B&t=2026-10-07T09:20:00Z&cam=gates&rm=1");
  await plansReady(page);
  await expect.poll(async () => (await state(page)).compare).toEqual(["A", "B"]);
  const r = await state(page);
  expect(r.selectedOption).toBe("A"); expect(r.focus).toBe("gates"); expect(new Date(r.cursor as number).toISOString()).toBe("2026-10-07T09:20:00.000Z");
});
