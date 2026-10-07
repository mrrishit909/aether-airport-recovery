// The realistic failure cases are demonstrable and recover: a 429 storm on the cheap tiers (retries, then escalation), a ground-ops
// provider outage (partial analysis, plans still produced), the airport feed going down, and GPU context loss.
import { expect, test } from "@playwright/test";
import { plansReady, ready, state } from "./helpers.ts";

test("429 storm on haiku and sonnet: retries, escalation, the run still completes", async ({ page }) => {
  await ready(page, "/?enter=1");
  await page.getByRole("button", { name: /Failure lab/ }).click();
  await page.getByRole("menuitem", { name: /429 storm/ }).click();
  await expect(page.getByText(/fault armed: rate_limited on haiku/)).toBeVisible();
  await page.getByRole("button", { name: "Run full recovery" }).click();
  await plansReady(page, 120_000);
  const s = await state(page);
  expect(s.findings).toBe(35); expect(s.recommended).toBe("B");
  const inv = s.invocations as [string, string, string, number, string | null][];
  expect(inv.some(([, , status, retries]) => status === "failed" && retries >= 1)).toBe(true);   // the weather agent on haiku gave up after 2 attempts
  expect(inv.some(([, , status, , from]) => status === "success" && from !== null)).toBe(true);     // and the escalated call answered
  await page.getByRole("button", { name: "Agent map" }).click();
  await expect(page.getByRole("region", { name: "Agent map" })).toContainText("rate_limited");
});

test("ground-ops outage: a partial analysis that still produces plans, and recovers on the next run", async ({ page }) => {
  await ready(page, "/?enter=1");
  await page.getByRole("button", { name: /Failure lab/ }).click();
  await page.getByRole("menuitem", { name: /ground-ops provider outage/ }).click();
  await page.getByRole("button", { name: "Trigger thunderstorm" }).click();
  await page.getByRole("button", { name: "Run agents" }).click();
  await expect.poll(async () => (await state(page)).analysisStatus, { timeout: 90_000 }).toBe("partial");
  const s = await state(page);
  expect((s.agents as Record<string, { status: string; model: string }>)["ground-ops-agent"]).toMatchObject({ status: "failed", model: "opus" }); // every tier failed
  expect(s.findings).toBe(30);                                                                                                                  // 35 minus the 5 ground-ops findings
  await expect(page.getByRole("status", { name: "Workflow progress" })).toContainText("analysis partial");
  await page.getByRole("button", { name: "Generate plans" }).click();
  await plansReady(page);
  expect((await state(page)).recommended).toBe("B");
  await page.getByRole("button", { name: /Failure lab/ }).click();
  await page.getByRole("menuitem", { name: "Disarm faults" }).click();
  await expect(page.getByText(/fault armed/)).toHaveCount(0);
  await page.getByRole("button", { name: "Re-run agents" }).click();
  await expect.poll(async () => (await state(page)).analysisStatus, { timeout: 90_000 }).toBe("complete");
});

test("airport feed outage: backoff retries, the last good schedule stays usable, recovery", async ({ page }) => {
  await ready(page, "/?enter=1");
  await page.getByRole("button", { name: /Failure lab/ }).click();
  await page.getByRole("menuitem", { name: "Cut the airport feed" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "Airport feed unavailable" })).toBeVisible({ timeout: 10_000 });
  await expect.poll(async () => ((await state(page)).feed as { status: string }).status).toBe("retrying");
  await page.getByRole("button", { name: "Trigger thunderstorm" }).click(); // still usable while down
  await expect.poll(async () => (await state(page)).view).toBe("disrupted");
  await page.getByRole("button", { name: /Failure lab/ }).click();
  await page.getByRole("menuitem", { name: "Restore the airport feed" }).click();
  await expect(page.getByText(/Airport feed recovered/).first()).toBeVisible({ timeout: 40_000 });
  expect(((await state(page)).load as { status: string }).status).toBe("ready");
  expect((await state(page)).disruption).toBe(true); // the declared storm survived the reload
});

test("GPU context loss falls back to the list view and comes back", async ({ page }) => {
  await ready(page, "/?enter=1");
  const ok = await page.evaluate(() => !!document.querySelector<HTMLCanvasElement>(".globe canvas")?.getContext("webgl2")?.getExtension("WEBGL_lose_context"));
  test.skip(!ok, "no WEBGL_lose_context in this browser");
  await page.evaluate(() => { (window as unknown as { __lose: unknown }).__lose = document.querySelector<HTMLCanvasElement>(".globe canvas")!.getContext("webgl2")!.getExtension("WEBGL_lose_context"); (window as unknown as { __lose: { loseContext(): void } }).__lose.loseContext(); });
  await expect.poll(async () => (await state(page)).webgl).toBe("lost");
  await expect(page.getByRole("main", { name: "List view" })).toContainText("GPU context was lost");
  await page.evaluate(() => (window as unknown as { __lose: { restoreContext(): void } }).__lose.restoreContext());
  await expect.poll(async () => (await state(page)).webgl).toBe("ok");
});
