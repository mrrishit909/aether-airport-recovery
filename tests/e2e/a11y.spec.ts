// Reduced motion keeps every fact and task; keyboard alone can run the core flow; the list view replaces the canvas.
import { expect, test } from "@playwright/test";
import { plansReady, ready, state } from "./helpers.ts";

test.use({ reducedMotion: "reduce" });

test("reduced motion: instant states, no travel, same information, same workflow", async ({ page }) => {
  await ready(page);
  expect((await state(page)).reduced).toBe(true);
  await page.getByRole("button", { name: "Run the recovery now" }).click();
  await plansReady(page);
  const s = await state(page);
  expect(s.recommended).toBe("B"); expect(s.findings).toBe(35);
  await expect(page.getByRole("button", { name: "Play", exact: true })).toBeDisabled();
  const inspector = page.getByRole("complementary", { name: "Inspector" });
  await expect(inspector).toContainText("recommended");
  await page.getByRole("button", { name: "Gates", exact: true }).click();
  expect((await state(page)).focus).toBe("gates");
  await page.getByRole("button", { name: "Passengers", exact: true }).click();
  expect((await state(page)).focus).toBe("passengers");
  await expect(page.getByRole("complementary", { name: "Findings" })).toContainText("35 from");
  // the scrubber still moves time; the capacity readout follows it
  await page.getByRole("button", { name: "Storm starts" }).click();
  await expect(page.locator(".cap")).toContainText("1 of 4");
});

test("keyboard only: trigger, run, generate, step plans, split view, camera, agent map, list view, back out", async ({ page }) => {
  await ready(page, "/?enter=1");
  await expect.poll(async () => (await state(page)).view).toBe("explore");
  await page.keyboard.press("t");
  await expect.poll(async () => (await state(page)).view).toBe("disrupted");
  await page.keyboard.press("r");
  await expect.poll(async () => (await state(page)).analysisStatus, { timeout: 60_000 }).toBe("complete");
  await page.keyboard.press("g");
  await plansReady(page);
  const first = (await state(page)).selectedOption;
  await page.keyboard.press("n");
  await expect.poll(async () => (await state(page)).selectedOption).not.toBe(first);
  await page.keyboard.press("v");
  await expect.poll(async () => (await state(page)).compare).not.toBeNull();
  await page.keyboard.press("Escape");
  await expect.poll(async () => (await state(page)).compare).toBeNull();
  await page.keyboard.press("2");
  expect((await state(page)).focus).toBe("gates");
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("]");
  await expect.poll(async () => (await state(page)).selectedFinding).not.toBeNull();
  await page.keyboard.press("a");
  await expect(page.getByRole("region", { name: "Agent map" })).toBeVisible();
  await page.keyboard.press("Escape");
  await page.keyboard.press("l");
  const list = page.getByRole("main", { name: "List view" });
  await expect(list.getByRole("table").first()).toBeVisible();
  await expect(list).toContainText("Recovery plans: option B recommended");
  await expect(list).toContainText("Flights in the plan on screen (90)");
  await page.keyboard.press("l");
  await page.keyboard.press("Escape");
  await expect.poll(async () => (await state(page)).selectedFinding).toBeNull();
  const unnamed = await page.locator("button:visible").evaluateAll((bs) => bs.filter((b) => !(b.textContent ?? "").trim() && !b.getAttribute("aria-label")).length);
  expect(unnamed).toBe(0);
  await page.keyboard.press("?");
  await expect(page.getByRole("dialog", { name: "Keyboard" })).toBeVisible();
});
