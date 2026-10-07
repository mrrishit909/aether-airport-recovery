"use client";
import dynamic from "next/dynamic";
import { useEffect, useRef } from "react";
import { prefersReducedMotion } from "@aether/motion";
import { get, jump, loadScenario, runAll, runAnalyze, runOptimize, selectFinding, selectFlight, selectGate, selectOption, send, set, setCompare, triggerDisruption, useApp } from "./store.ts";
import { readLink, writeLink } from "./url.ts";
import { FOCI, isIntro } from "./journey.ts";
import { telemetry } from "./runtime.ts";
import Intro from "./ui/Intro.tsx";
import { Banner, FindingsPanel, Inspector, StageBar, Timeline, TopBar } from "./ui/Sandbox.tsx";
import { ComparePanel } from "./ui/Plans.tsx";
import { ApproveDialog, Help, Palette } from "./ui/Dialogs.tsx";
import ListView from "./ui/ListView.tsx";
import AgentMap from "./ui/AgentMap.tsx";
import Costs from "./ui/Costs.tsx";
import Hud from "./ui/Hud.tsx";

const Scene = dynamic(() => import("./scene/Scene.tsx"), { ssr: false });
const SplitScene = dynamic(() => import("./scene/Scene.tsx").then((m) => m.SplitScene), { ssr: false });

function hasWebGL() { try { return !!document.createElement("canvas").getContext("webgl2"); } catch { return false; } }

function useKeyboard() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA" || (e.target as HTMLElement)?.closest?.("dialog")) return;
      const s = get();
      if ((e.key === "k" && (e.metaKey || e.ctrlKey)) || e.key === "/") { e.preventDefault(); set({ palette: true }); return; }
      if (isIntro(s.view) || e.altKey || e.metaKey || e.ctrlKey) return;
      const at = s.findings.findIndex((f) => f.id === s.selectedFinding);
      switch (e.key) {
        case " ": e.preventDefault(); set({ playing: !s.playing, motionPaused: false }); break;
        case "ArrowRight": jump((s.cursor || s.window.t0) + (e.shiftKey ? 30 : 5) * 60e3); break;
        case "ArrowLeft": jump((s.cursor || s.window.t0) - (e.shiftKey ? 30 : 5) * 60e3); break;
        case "]": if (s.findings.length) selectFinding(s.findings[(at + 1) % s.findings.length].id); break;
        case "[": if (s.findings.length) selectFinding(s.findings[(at - 1 + s.findings.length) % s.findings.length].id); break;
        case "t": case "T": triggerDisruption(); break;
        case "r": case "R": runAnalyze(); break;
        case "g": case "G": runOptimize(); break;
        case "i": case "I": runAll(); break;
        case "n": case "N": if (s.options.length) { const i = s.options.findIndex((o) => o.id === s.selectedOption); selectOption(s.options[(i + 1) % s.options.length].id); } break;
        case "v": case "V": if (s.options.length) setCompare(s.compare ? null : [s.options[0].id, s.recommendation?.recommended ?? s.options[1].id]); break;
        case "a": case "A": set({ panel: s.panel === "agents" ? null : "agents" }); break;
        case "c": case "C": set({ panel: s.panel === "costs" ? null : "costs" }); break;
        case "l": case "L": set({ listView: !s.listView }); break;
        case "m": case "M": set({ reduced: !s.reduced }); break;
        case "p": case "P": set({ motionPaused: !s.motionPaused, playing: false }); break;
        case "0": case "1": case "2": case "3": case "4": set({ focus: FOCI[+e.key] }); break;
        case "?": set({ help: true }); break;
        case "Escape": if (s.panel) set({ panel: null }); else if (s.compare) set({ compare: null }); else if (s.selectedFinding) selectFinding(null); else if (s.selectedFlight) selectFlight(null); else if (s.selectedGate) selectGate(null); else set({ focus: "airport" }); break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}

/** Restore state from the URL once data is loaded, then keep the URL in step with the state. */
function useDeepLink() {
  const ready = useApp((s) => s.load.status === "ready");
  const applied = useRef(false);
  useEffect(() => {
    if (!ready || applied.current) return;
    applied.current = true;
    const l = readLink(location.search);
    if (l.rm) set({ reduced: true });
    if (l.view) set({ listView: true });
    if (l.panel) set({ panel: l.panel });
    if (l.cam) set({ focus: l.cam });
    const after = () => { if (l.opt) selectOption(l.opt); if (l.cmp) setCompare(l.cmp); if (l.f) selectFlight(l.f); else if (l.g) selectGate(l.g); if (l.t !== undefined) jump(l.t); if (l.cam) set({ focus: l.cam }); if (l.stage === "approved") set({ approveOpen: true }); };
    if (l.enter || l.trig || l.run || l.stage) send({ type: "ENTER" });
    if (l.run || l.stage) runAll().then(after);
    else if (l.trig) triggerDisruption().then(after);
    else after();
    let last = "";
    setInterval(() => {
      const s = get();
      if (isIntro(s.view)) return;
      const ran = s.options.length > 0;
      const link = writeLink({ enter: true, trig: !!s.disruption, run: ran, stage: s.view === "approved" ? "approved" : undefined, opt: ran ? s.selectedOption ?? undefined : undefined, cmp: s.compare ?? undefined, f: s.selectedFlight ?? undefined, g: s.selectedGate ?? undefined, t: s.playing ? undefined : s.cursor || undefined, cam: s.focus, panel: s.panel ?? undefined, view: s.listView ? "list" : undefined, rm: s.reduced || undefined }) || "?enter=1";
      if (link !== last) { last = link; history.replaceState(null, "", link); }
    }, 400);
  }, [ready]);
}

export default function App() {
  const view = useApp((s) => s.view);
  const listView = useApp((s) => s.listView);
  const panel = useApp((s) => s.panel);
  const webgl = useApp((s) => s.webgl);
  const load = useApp((s) => s.load);
  const announce = useApp((s) => s.announce);
  const reduced = useApp((s) => s.reduced);
  const loaded = useApp((s) => s.scenario !== null);
  const compare = useApp((s) => s.compare);
  useKeyboard();
  useDeepLink();
  useEffect(() => {
    const mq = matchMedia("(prefers-reduced-motion: reduce)");
    set({ reduced: prefersReducedMotion() || readLink(location.search).rm === true, webgl: hasWebGL() ? "ok" : "unsupported" });
    const onChange = () => set({ reduced: mq.matches });
    mq.addEventListener("change", onChange);
    telemetry.start();
    loadScenario();
    (window as unknown as { __aether: unknown }).__aether = { state: get, telemetry: () => telemetry.s }; // read-only handle for e2e + recorder
    return () => mq.removeEventListener("change", onChange);
  }, []);
  useEffect(() => { document.documentElement.dataset.reduced = reduced ? "1" : "0"; }, [reduced]);
  const intro = isIntro(view);
  const show3d = !listView && webgl === "ok";
  const split = !intro && !!compare && show3d;
  return (
    <div className={`app view-${view} ${intro ? "is-intro" : "is-sandbox"}`}>
      <a className="skip" href="#main-panels">Skip to the panels</a>
      {webgl !== "unsupported" && !split ? <div className="globe-wrap" aria-hidden={!show3d} style={{ visibility: show3d || intro ? "visible" : "hidden" }}><Scene /></div> : null}
      {split ? <div className="split" role="group" aria-label="Synchronized split view"><div className="split-grid"><SplitScene /></div><span className="split-label left">{compare![0]} · {get().options.find((o) => o.id === compare![0])?.name}</span><span className="split-label right">{compare![1]} · {get().options.find((o) => o.id === compare![1])?.name}</span></div> : null}
      <div className="sr-only" role="status" aria-live="polite">{announce}</div>
      {load.status === "error" ? <div className="banner warn" role="alert">Could not load the airport: {load.message}. <button onClick={() => loadScenario()}>Retry</button></div> : null}
      {load.status === "loading" && !intro && !loaded ? <div className="loading" role="status">Loading airport…</div> : null}
      <Intro />
      {!intro ? (
        <>
          <TopBar />
          <Banner />
          <StageBar />
          <div id="main-panels" className="panels">
            {listView || webgl !== "ok" ? <ListView /> : panel === "agents" ? <AgentMap /> : panel === "costs" ? <Costs /> : split ? <ComparePanel /> : null}
            <FindingsPanel />
            <Inspector />
          </div>
          <Timeline />
          <Hud />
        </>
      ) : null}
      <ApproveDialog />
      <Palette />
      <Help />
    </div>
  );
}
