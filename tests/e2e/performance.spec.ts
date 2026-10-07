// Section 16: 5,000 more aircraft in simulation orbit the field (instanced, one draw call) while the workflow runs; the cost is
// reported, budgets are recorded, not enforced, on software GL.
import { expect, test } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { plansReady, ready, state } from "./helpers.ts";

test("5,000-aircraft stress scene renders, the workflow still runs, and the cost is reported", async ({ page }) => {
  await ready(page, "/?enter=1");
  await page.getByRole("button", { name: /Failure lab/ }).click();
  await page.getByRole("menuitem", { name: /Stress test: 5,000 more aircraft/ }).click();
  await page.getByRole("button", { name: "Telemetry" }).click();
  await page.waitForTimeout(3000);
  const t0 = performance.now();
  await page.getByRole("button", { name: "Run full recovery" }).click();
  await plansReady(page, 120_000);
  const recoverMs = Math.round(performance.now() - t0);
  await page.waitForTimeout(2000);
  const t = await page.evaluate(() => (window as unknown as { __aether: { telemetry: () => Record<string, unknown> } }).__aether.telemetry());
  expect(t.objects).toBe(5045);
  expect((t.render as { triangles: number }).triangles).toBeGreaterThanOrEqual(200_000);
  expect(t.fps as number).toBeGreaterThan(0);
  expect((await state(page)).recommended).toBe("B");
  const js = await page.evaluate(() => performance.getEntriesByType("resource").filter((r) => r.name.endsWith(".js")).reduce((s, r) => s + (r as PerformanceResourceTiming).encodedBodySize, 0));
  mkdirSync("docs", { recursive: true });
  writeFileSync("docs/performance-e2e.json", JSON.stringify({ note: "headless Chrome with SwiftShader (software GL): FPS here is a floor, not the desktop GPU figure", ...t, recoverMsWithSimulatedLatency: recoverMs, jsBytesTransferred: js }, null, 1));
});
