"use client";
// The public story, four chapters long, scrolled over the live airport. Numbers are counted from the loaded airport and the cost
// baseline that ships with it.
import { useEffect, useRef, useState } from "react";
import { get, send, runAll, useApp } from "../store.ts";
import { introScroll } from "../scene/Scene.tsx";
import { n, usd } from "./fmt.ts";

interface Base { totalCostUsd: number; rawTokens: number; synthesisInputTokens: number; recommended: string; misconnectedBaseline: number; options: { id: string; name: string; misconnected: number; vulnerable: number; totalDelayMin: number; gateChanges: number; holds: number }[] }

export default function Intro() {
  const ref = useRef<HTMLDivElement>(null);
  const scenario = useApp((s) => s.scenario);
  const ready = useApp((s) => s.load.status === "ready");
  const view = useApp((s) => s.view);
  const [base, setBase] = useState<Base | null>(null);
  useEffect(() => { fetch(`${process.env.NEXT_PUBLIC_BASE_PATH ?? ""}/data/cost-baseline.json`).then((r) => r.json()).then(setBase).catch(() => {}); }, []);
  useEffect(() => {
    const el = ref.current; if (!el) return;
    const onScroll = () => {
      const secs = [...el.querySelectorAll<HTMLElement>("[data-chapter]")];
      const mid = el.scrollTop + el.clientHeight * 0.5;
      let f = 0;
      secs.forEach((s, i) => { const top = s.offsetTop, h = s.offsetHeight; if (mid >= top) f = Math.min(3, i + Math.min(1, (mid - top) / h)); });
      introScroll.f = Math.max(0, f - 0.5);
      const chapter = Math.min(3, Math.round(introScroll.f));
      if (get().view !== `intro${chapter}`) send({ type: "CHAPTER", n: chapter });
    };
    el.addEventListener("scroll", onScroll, { passive: true }); onScroll();
    return () => el.removeEventListener("scroll", onScroll);
  }, []);
  const fl = scenario?.flights ?? [];
  const pax = scenario ? scenario.itineraries.reduce((s, i) => s + i.pax, 0) : 0;
  const go = (k: number) => ref.current?.querySelectorAll<HTMLElement>("[data-chapter]")[k]?.scrollIntoView({ behavior: get().reduced ? "auto" : "smooth" });
  const W = base?.options.find((o) => o.id === "W"), R = base?.options.find((o) => o.id === base.recommended);
  return (
    <div className="intro" ref={ref} aria-label="Introduction" hidden={!view.startsWith("intro")}>
      <section data-chapter="0" className="chapter">
        <p className="kicker">AETHER · airport disruption recovery</p>
        <h1>A storm closes the runway. One model should not reschedule the airport.</h1>
        <p>{ready ? n(fl.length) : "90"} movements, {ready ? n(pax) : "1,797"} connecting passengers, {ready ? scenario!.gates.length : 30} gates and a ground fleet, on a synthetic night at Norrvik. Aircraft taxi, vehicles move. Scroll.</p>
        <p className="badge-line"><span className="badge">SYNTHETIC DATA</span> The airport, airlines, tails and passengers are generated. No model is called: agents are deterministic analyzers charged simulated tokens; the gate solver is a real search.</p>
        <button className="ghost" onClick={() => go(1)}>Start</button>
      </section>
      <section data-chapter="1" className="chapter">
        <h2>Capacity falls at the runway and ripples outward.</h2>
        <p>A thunderstorm cell takes runway capacity down to about a quarter for 45 minutes. A deterministic model queues every movement through the reduced slots and carries the delay through each aircraft's turnaround: late inbound, late outbound, a gate still occupied. The ripple reaches the gates, then the passengers.</p>
      </section>
      <section data-chapter="2" className="chapter">
        <h2>Specialists in parallel, a solver for the schedule.</h2>
        <p>The weather agent turns the feed into bounded capacity. Flight risk, gates, passengers and ground ops each read only their own slice. The optimizer agent never solves a schedule in prose: it calls a branch-and-bound gate solver. The synthesizer, the strongest model, reads {base ? n(base.synthesisInputTokens) : "1,780"} tokens of structured results, not the {base ? n(base.rawTokens) : "12,990"} of the window.</p>
        <ul className="facts">
          <li><b>haiku</b> weather constraints</li>
          <li><b>sonnet</b> four analysts and the optimizer</li>
          <li><b>opus</b> the synthesizer, and one escalated passenger subproblem</li>
        </ul>
      </section>
      <section data-chapter="3" className="chapter">
        <h2>Three plans, one clock, a human decision.</h2>
        <p>Doing nothing strands <b>{W ? W.misconnected : 101}</b> passengers. The recommended plan strands <b>{R ? R.misconnected : 17}</b>, at <b>{base ? usd(base.totalCostUsd) : "$0.43"}</b> of simulated model cost for the whole run. Compare the plans in a synchronized split view, scrub 90 minutes either side of the storm, and approve one: nothing moves until a dispatcher does.</p>
        <div className="cta">
          <button className="primary" onClick={() => send({ type: "ENTER" })}>Open the command center</button>
          <button className="ghost" onClick={() => { send({ type: "ENTER" }); runAll(); }}>Run the recovery now</button>
        </div>
      </section>
    </div>
  );
}
