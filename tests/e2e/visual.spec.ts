// Visual regression on key motion states (not just the first frame): the storm over the field in chapter 1, the split view at
// T+40 with the passenger arcs, the replay track with the capacity curve, and the agent map after the run.
import { expect, test } from "@playwright/test";
import { plansReady, ready, state } from "./helpers.ts";

test.use({ reducedMotion: "reduce" }); // states land instantly, so each screenshot is of a settled state

test("intro storm, split view at T+40, replay track, agent map", async ({ page }) => {
  await ready(page);
  await page.getByLabel("Introduction").evaluate((el) => el.querySelectorAll("[data-chapter]")[1].scrollIntoView());
  await expect.poll(async () => (await state(page)).view).toBe("intro1");
  await page.waitForTimeout(1500);
  await expect(page).toHaveScreenshot("intro-storm.png", { mask: [page.locator(".chapter")] });
  await ready(page, "/?run=1&opt=B&cmp=A,B&t=2026-10-07T09:40:00Z&rm=1");
  await plansReady(page);
  await page.waitForTimeout(1800);
  await expect(page.locator(".split")).toHaveScreenshot("split-view.png");
  await expect(page.locator(".timeline")).toHaveScreenshot("replay-track.png", { mask: [page.locator(".clock")] });
  await page.getByRole("button", { name: "Agent map" }).click();
  await page.waitForTimeout(500);
  await expect(page.locator(".agentmap svg")).toHaveScreenshot("agent-map.png");
});
