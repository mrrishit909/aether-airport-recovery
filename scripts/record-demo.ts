// Records the demo scenario as a captioned video (docs/video/demo.webm; convert with ffmpeg to mp4). Drives the static export
// served by scripts/serve.ts on :8549 (URL env to match). Captions are an overlay injected for the recording only.
import { chromium, type Page } from "@playwright/test";
import { mkdirSync, renameSync } from "node:fs";

const url = process.env.URL ?? "http://127.0.0.1:8549/";
const browser = await chromium.launch({ channel: "chrome", headless: process.env.HEADFUL !== "1", args: ["--use-angle=metal", "--enable-gpu", "--ignore-gpu-blocklist", "--enable-unsafe-swiftshader"] });
mkdirSync("docs/video", { recursive: true });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 }, recordVideo: { dir: "docs/video", size: { width: 1280, height: 720 } } });
const page = await ctx.newPage();
const wait = (ms: number) => page.waitForTimeout(ms);
async function caption(p: Page, text: string, ms = 3500) {
  await p.evaluate((t) => {
    let el = document.getElementById("rec-caption");
    if (!el) { el = document.createElement("div"); el.id = "rec-caption"; el.style.cssText = "position:fixed;left:50%;bottom:132px;transform:translateX(-50%);z-index:99;max-width:760px;padding:10px 16px;border-radius:10px;background:rgba(3,5,10,.9);border:1px solid #5ef2c2;color:#e6ebf2;font:15px/1.4 system-ui;text-align:center;pointer-events:none"; document.body.appendChild(el); }
    el.textContent = t;
  }, text);
  await wait(ms);
}
type S = { load: { status: string }; view: string; options: unknown[]; analysis: unknown; approvedOption: string | null };
const st = () => page.evaluate(() => (window as unknown as { __aether: { state: () => S } }).__aether.state());
const until = (fn: (s: S) => boolean, timeout = 90_000) => page.waitForFunction((src) => (new Function("s", `return (${src})(s)`))((window as unknown as { __aether: { state: () => S } }).__aether.state()), fn.toString(), { timeout });

page.on("pageerror", (e) => console.log("PAGEERROR", e.message));
try {
await page.goto(url);
await page.waitForFunction(() => (window as unknown as { __aether?: { state: () => S } }).__aether?.state().load.status === "ready", null, { timeout: 60_000 });
await caption(page, "AETHER: when a storm closes a runway, specialized agents and a real gate solver recover the airport, and one model never reschedules it.", 5500);
const intro = page.getByLabel("Introduction");
const scroll = async (n: number) => { for (let i = 0; i < n; i++) { await intro.evaluate((el) => el.scrollBy(0, 70)); await wait(110); } };
await caption(page, "A synthetic night at Norrvik: 90 movements, 1,797 connecting passengers, 30 gates. Aircraft taxi; ground vehicles move.", 200);
await scroll(30); await wait(3000);
await caption(page, "A thunderstorm cell takes runway capacity down to 27% for 45 minutes. A deterministic model carries the delay through every aircraft rotation.", 200);
await scroll(26); await wait(3500);
await caption(page, "The synthesizer will read 1,780 tokens of structured results, not the 12,990 of the window. The schedule itself is changed only by a solver.", 200);
await scroll(26); await wait(3500);
await page.getByRole("button", { name: "Open the command center" }).click();
await caption(page, "The command center: the same airport, now with findings, plans and a timeline covering 90 minutes either side of the storm.", 4000);
await page.getByRole("button", { name: "Trigger thunderstorm" }).click();
await caption(page, "Trigger the storm. A ripple runs from the runway to the gates and the passenger network; the runway turns red and capacity falls to 1 movement per 5 minutes.", 6500);
await page.getByRole("button", { name: "Play", exact: true }).click();
await caption(page, "Replay forward: aircraft stack up in the holding pattern, rotations leave late, 19 movements run more than 15 minutes late. Nothing has been optimized yet.", 8000);
await page.getByRole("button", { name: "Pause", exact: true }).click();
await page.getByRole("button", { name: "Run agents" }).click();
await caption(page, "Run the agents. The weather agent (haiku) turns the feed into bounded capacity; then four analysts (sonnet) work in parallel on their own slices.", 5000);
await page.getByRole("button", { name: "Agent map" }).click();
await until((s) => !!s.analysis);
await caption(page, "One escalation: the passenger agent was only 55% sure about cross-terminal connections, so that subproblem (4,443 tokens, not 9,582) went to opus, which also found the 5 passengers the cheap tier missed.", 7000);
await page.getByRole("button", { name: "Agent map" }).click();
await page.getByRole("complementary", { name: "Findings" }).getByRole("button", { name: /gate conflict/ }).first().click();
await caption(page, "An evidence packet: 13 gate conflicts after the delays, each with the agent, model, tokens, cost and the flights behind it.", 6000);
await page.getByRole("complementary", { name: "Inspector" }).getByRole("button", { name: "← all plans" }).click();
await page.getByRole("button", { name: "Generate plans" }).click();
await caption(page, "Generate plans. The optimizer agent never solves a schedule in prose: it calls a branch-and-bound gate solver for three strategies, then the synthesizer compares them.", 6500);
await until((s) => s.options.length === 4);
await caption(page, "Doing nothing strands 101 passengers (the cheap tier said 96). A: least delay (1,088 min) strands 128. B: protect connections strands 17. C: one gate change, 121.", 8000);
await page.getByRole("button", { name: "Storm ends" }).click();
await page.getByLabel("Compare option A").check();
await page.getByLabel("Compare option B").check();
await caption(page, "Compare in a synchronized split view: one clock, one camera, two plans. The arcs are lost connections: A strands 128 passengers, B only 17, for 185 more delay minutes.", 9000);
await page.getByRole("button", { name: "Play", exact: true }).click();
await caption(page, "Scrub or play: both airports move on the same event time.", 5000);
await page.getByRole("button", { name: "Pause", exact: true }).click();
await page.getByRole("button", { name: "Close split view" }).click();
await page.getByRole("complementary", { name: "Inspector" }).evaluate((el) => el.scrollTo({ top: 520, behavior: "smooth" }));
await caption(page, "Option B is recommended, with its tradeoffs, policy flags and falsifiable assumptions. Each carries a check and a real re-run: with the storm 15 minutes longer, doing nothing strands 104.", 8000);
await page.getByRole("complementary", { name: "Inspector" }).evaluate((el) => el.scrollTo({ top: 9999, behavior: "smooth" }));
await page.getByRole("button", { name: /Approve option B/ }).click();
await caption(page, "Approval is a human gate. It refuses until the policy flags are confirmed.", 3500);
await page.getByRole("dialog").getByRole("button", { name: "Approve and dispatch" }).click();
await wait(1500);
await page.getByRole("dialog").getByRole("checkbox").check();
await page.getByRole("dialog").getByRole("button", { name: "Approve and dispatch" }).click();
await page.getByRole("button", { name: "Window start" }).click();
await page.getByRole("button", { name: "Play", exact: true }).click();
await caption(page, "Approved: 11 gate changes and 19 holds become the plan. The aircraft and gates update, and the replay now runs the approved schedule.", 9000);
await page.getByRole("button", { name: "Pause", exact: true }).click();
await page.getByRole("button", { name: "Costs" }).click();
await caption(page, "Costs: $0.43 for the whole run at list prices, 1 escalation in 7 agents. Opus read 6,223 tokens in all: 48% of the window, mostly the escalated subproblem.", 6500);
await page.getByRole("button", { name: "Costs" }).click();
await page.getByRole("button", { name: /Failure lab/ }).click();
await page.getByRole("menuitem", { name: /429 storm/ }).click();
await page.getByRole("button", { name: "Run full recovery" }).click();
await page.getByRole("button", { name: "Agent map" }).click();
await caption(page, "Failure: a 429 storm on the cheap tiers. Retries with backoff, then the narrow subproblem escalates; the run still completes.", 9000);
await until((s) => s.options.length === 4, 120_000);
await caption(page, "Same recommendation, more cost: the dashboard shows the retry waste and the escalation rate.", 4500);
await page.keyboard.press("l");
await caption(page, "Every fact is also in tables: the list view works without WebGL or motion.", 4500);
await page.keyboard.press("l");
await page.getByRole("button", { name: "Reduced motion" }).click();
await caption(page, "Reduced motion: camera travel, rain and replay become instant state changes; information and tasks stay the same.", 4500);
await caption(page, "Synthetic data, simulated models, real routing and a real solver. Code, tests and the write-up: mrrishit909/aether-airport-recovery.", 4500);
} catch (e) {
  mkdirSync(".scratch", { recursive: true });
  await page.screenshot({ path: ".scratch/record-fail.png" });
  console.log("FAILED at", await page.evaluate(() => document.body.innerText.slice(0, 200)));
  throw e;
}
console.log(JSON.stringify(await page.evaluate(() => (window as unknown as { __aether: { telemetry: () => unknown } }).__aether.telemetry())));
const v = page.video();
await ctx.close();
await browser.close();
if (v) renameSync(await v.path(), "docs/video/demo.webm");
console.log("wrote docs/video/demo.webm");
