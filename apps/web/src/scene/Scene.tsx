"use client";
// The airport at night. Everything drawn is a function of event time: aircraft and ground poses come from packages/domain/sim.ts
// (backend estimated times + gate positions), gate pads show occupancy at the cursor, the runway changes colour with the capacity
// at the cursor, the storm cell and rain follow the weather at the cursor, missed connections are arcs between the gates of the
// two flights. The camera follows the focus in the store through the orchestrator (reduced motion = instant). Split view renders
// the same scene twice, each with its own option's times, on the same clock and the same camera.
import { Canvas, useFrame, useThree, type ThreeEvent } from "@react-three/fiber";
import { useEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { applyDisruption, connections, gateOccupancy, poses, RUNWAY, type FlightTimes, type Pose, type WeatherObservation } from "@aether/domain";
import { capacityAt, get, planOf, selectFlight, selectGate, set, timesOfOption, type AppState } from "../store.ts";
import { advance, clock, orchestrator, telemetry } from "../runtime.ts";
import { isIntro, type Focus } from "../journey.ts";
import { delayClass } from "../ui/fmt.ts";

export const introScroll = { f: 0 };
const COLORS = { ok: new THREE.Color("#7fd6c2"), warn: new THREE.Color("#ffb454"), bad: new THREE.Color("#ff6b5a"), sel: new THREE.Color("#ffffff"), idle: new THREE.Color("#0f1d2e"), occ: new THREE.Color("#3f7fbf"), clash: new THREE.Color("#ff3b30"), maint: new THREE.Color("#3a1616"), remote: new THREE.Color("#1b3a52"), accent: new THREE.Color("#5ef2c2"), runOk: new THREE.Color("#12463b"), runBad: new THREE.Color("#7a1f1f") };
const CAM: Record<Exclude<Focus, "aircraft">, number[]> = { airport: [3, 38, 60, 3, 0, 1], runway: [-12, 9, 0, -6, 0, -14], gates: [3, 19, 36, 3, 0, 9], passengers: [3, 46, 24, 3, 0, 7] };
const INTRO_FOCUS: Focus[] = ["airport", "runway", "gates", "passengers"];
const CLS_SCALE = { regional: 0.8, narrow: 1, wide: 1.35 } as const;
const N_STRESS = 5000, MAX_LINES = 160, N_VEH = 40, N_RAIN = 420;
const STORM_C: [number, number, number] = [-6, 0, -10];

function hash(s: string | number) { const str = String(s); let h = 2166136261; for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); } return (h >>> 0) / 4294967296; }
function disc() {
  const c = document.createElement("canvas"); c.width = c.height = 64;
  const g = c.getContext("2d")!; const grd = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grd.addColorStop(0, "rgba(255,255,255,1)"); grd.addColorStop(0.4, "rgba(255,255,255,0.85)"); grd.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = grd; g.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(c);
}
function planeGeometry() {
  const fus = new THREE.BoxGeometry(2.2, 0.3, 0.3), wing = new THREE.BoxGeometry(0.5, 0.05, 2.1); wing.translate(0.1, 0, 0);
  const tail = new THREE.BoxGeometry(0.4, 0.45, 0.06); tail.translate(-1.0, 0.25, 0);
  const tailplane = new THREE.BoxGeometry(0.3, 0.04, 0.8); tailplane.translate(-1.0, 0.05, 0);
  return mergeGeometries([fus, wing, tail, tailplane])!;
}

const weatherCache = new WeakMap<object, WeatherObservation[]>();
function weatherAt(s: AppState, t: number): WeatherObservation | null {
  if (!s.scenario) return null;
  let w = s.disruption ? weatherCache.get(s.disruption) : undefined;
  if (s.disruption && !w) { w = applyDisruption(s.scenario.weather, s.disruption); weatherCache.set(s.disruption, w); }
  const arr = w ?? s.scenario.weather;
  return arr[Math.max(0, Math.min(arr.length - 1, Math.floor((t - Date.parse(s.scenario.start)) / 300e3)))];
}

type Role = "main" | "left" | "right";
function timesFor(role: Role, s: AppState) {
  if (role === "main" || !s.compare) return planOf(s);
  const key = s.compare[role === "left" ? 0 : 1];
  const t = timesOfOption(s, key);
  return t ? { key: `option:${key}`, times: t } : planOf(s);
}

function AirportView({ role }: { role: Role }) {
  const scenario = useApp0((s) => s.scenario);
  const stress = useApp0((s) => s.stress);
  const { gl, camera } = useThree();
  const sprite = useMemo(disc, []);
  const rots = useApp0((s) => s.rots);
  const gates = scenario?.gates ?? [];
  const planeGeo = useMemo(planeGeometry, []);
  const planes = useRef<THREE.InstancedMesh>(null!), pads = useRef<THREE.InstancedMesh>(null!), stressMesh = useRef<THREE.InstancedMesh>(null!);
  const runArr = useRef<THREE.MeshStandardMaterial>(null!), stormMat = useRef<THREE.MeshBasicMaterial>(null!), stormLight = useRef<THREE.PointLight>(null!);
  const halo = useRef<THREE.Points>(null!), veh = useRef<THREE.Points>(null!), rain = useRef<THREE.Points>(null!), lines = useRef<THREE.LineSegments>(null!);
  const rings = useRef<(THREE.Mesh | null)[]>([]);
  const haloGeo = useMemo(() => { const g = new THREE.BufferGeometry(); g.setAttribute("position", new THREE.Float32BufferAttribute(new Float32Array(120 * 3).fill(99), 3)); g.setAttribute("color", new THREE.Float32BufferAttribute(new Float32Array(120 * 3), 3)); return g; }, []);
  const vehGeo = useMemo(() => { const g = new THREE.BufferGeometry(); g.setAttribute("position", new THREE.Float32BufferAttribute(new Float32Array(N_VEH * 3), 3)); return g; }, []);
  const rainGeo = useMemo(() => { const g = new THREE.BufferGeometry(); g.setAttribute("position", new THREE.Float32BufferAttribute(new Float32Array(N_RAIN * 3).fill(99), 3)); return g; }, []);
  const lineGeo = useMemo(() => { const g = new THREE.BufferGeometry(); g.setAttribute("position", new THREE.Float32BufferAttribute(new Float32Array(MAX_LINES * 12), 3)); g.setAttribute("color", new THREE.Float32BufferAttribute(new Float32Array(MAX_LINES * 12), 3)); return g; }, []);
  const conn = useRef<{ key: string; list: { a: [number, number]; b: [number, number]; ta: number; td: number; made: boolean; slack: number; inb: string; out: string }[] }>({ key: "", list: [] });
  const blend = useRef({ key: "", from: null as Map<string, FlightTimes> | null, t0: -1e9 });
  const lastSample = useRef(0);
  const tmp = useMemo(() => ({ m: new THREE.Matrix4(), q: new THREE.Quaternion(), e: new THREE.Euler(), p: new THREE.Vector3(), s: new THREE.Vector3(), c: new THREE.Color() }), []);

  // GPU context loss: keep the canvas mounted (or "restored" never fires) and tell the store
  useEffect(() => {
    const c = gl.domElement;
    const lost = (e: Event) => { e.preventDefault(); telemetry.contextLost(); set({ webgl: "lost" }); };
    const restored = () => set({ webgl: "ok" });
    c.addEventListener("webglcontextlost", lost); c.addEventListener("webglcontextrestored", restored);
    const t0 = performance.now(); telemetry.mark("sceneLoadMs", performance.now() - t0 + 1);
    return () => { c.removeEventListener("webglcontextlost", lost); c.removeEventListener("webglcontextrestored", restored); };
  }, [gl]);

  useFrame((st, dt) => {
    const s = get();
    const now = st.clock.elapsedTime * 1000;
    const driver = role !== "right";
    if (driver) { telemetry.frame(now); orchestrator.policy.reduced = s.reduced; orchestrator.policy.paused = s.motionPaused; orchestrator.tick(Math.min(100, dt * 1000)); advance(Math.min(100, dt * 1000), now); }
    if (!s.scenario) return;
    const intro = isIntro(s.view);
    const chapter = intro ? Math.min(3, Math.round(introScroll.f)) : 0;
    const t = intro && chapter >= 1 ? s.window.t0 + 14 * 60e3 : clock.t || s.cursor;
    const P = timesFor(role, s);
    if (!P) return;
    // ---- plan switch (an approval, a different option): blend from the previous plan's poses to the new one's ----
    const B = blend.current;
    if (role === "main" && B.key !== P.key) { const prev = B.key ? (B as unknown as { cur: Map<string, FlightTimes> }).cur : null; B.from = prev; B.t0 = now; B.key = P.key; }
    (B as unknown as { cur: Map<string, FlightTimes> }).cur = P.times;
    const bp = role === "main" && B.from && !s.reduced ? Math.min(1, (now - B.t0) / 1600) : 1;
    // ---- camera ----
    const focus: Focus = intro ? INTRO_FOCUS[chapter] : s.focus;
    const gateOf = (id: string) => s.gateById.get(id)!;
    const ps = poses(t, s.rots, P.times, s.gateById);
    let target: number[];
    if (focus === "aircraft" && s.selectedFlight) { const fl = s.flightById.get(s.selectedFlight); const hit = fl && ps.find((x) => x.rot.tail === fl.tail && x.pose.visible); target = hit ? [hit.pose.pos[0] + 7, hit.pose.pos[1] + 5, hit.pose.pos[2] + 8, hit.pose.pos[0], hit.pose.pos[1], hit.pose.pos[2]] : CAM.airport; }
    else target = CAM[focus === "aircraft" ? "airport" : focus];
    const cur = orchestrator.get("cam");
    if (!cur) orchestrator.set("cam", target);
    else if (focus === "aircraft") orchestrator.set("cam", cur.map((v, i) => v + (target[i] - v) * 0.12));
    else if (!orchestrator.busy("cam") && cur.some((v, i) => Math.abs(v - target[i]) > 1e-3)) orchestrator.to("cam", target, 1400);
    const c = orchestrator.get("cam")!;
    // a narrower canvas (the split view) pulls the camera back along its line of sight so the same airport fits
    const asp = st.size.width / Math.max(1, st.size.height), k = Math.min(1.6, Math.max(1, 0.75 / asp));
    camera.position.set(c[3] + (c[0] - c[3]) * k, c[4] + (c[1] - c[4]) * k, c[5] + (c[2] - c[5]) * k); camera.lookAt(c[3], c[4], c[5]);

    // ---- aircraft ----
    const occ = gateOccupancy(ps);
    let hn = 0;
    const hp = haloGeo.attributes.position as THREE.BufferAttribute, hc = haloGeo.attributes.color as THREE.BufferAttribute;
    const fromPs = bp < 1 && B.from ? poses(t, s.rots, B.from, s.gateById) : null;
    ps.forEach(({ rot, pose }, i) => {
      let p: Pose = pose;
      const f = fromPs?.[i].pose;
      let pos = pose.pos;
      if (f && (f.visible && pose.visible)) { const k = bp * bp * (3 - 2 * bp); pos = [f.pos[0] + (pose.pos[0] - f.pos[0]) * k, f.pos[1] + (pose.pos[1] - f.pos[1]) * k, f.pos[2] + (pose.pos[2] - f.pos[2]) * k]; }
      const tm = P.times.get(rot.arrival.id)!, td = P.times.get(rot.departure.id)!;
      const atGateOrAfter = p.phase === "gate" || p.phase === "pushback" || p.phase === "taxi_out" || p.phase === "takeoff" || p.phase === "climb";
      const delay = atGateOrAfter ? td.delayMin : tm.delayMin;
      const cls = s.scenario!.aircraft.find((a) => a.tail === rot.tail)?.cls ?? "narrow";
      const sel = s.selectedFlight && (s.selectedFlight === rot.arrival.id || s.selectedFlight === rot.departure.id);
      if (!p.visible) { tmp.m.makeScale(0, 0, 0); planes.current.setMatrixAt(i, tmp.m); return; }
      const k = CLS_SCALE[cls] * (sel ? 1.3 : 1);
      tmp.e.set(0, -p.heading, p.phase === "approach" ? -0.08 : p.phase === "climb" ? 0.18 : 0);
      tmp.q.setFromEuler(tmp.e); tmp.p.set(pos[0], pos[1] + 0.25, pos[2]); tmp.s.set(k, k, k);
      tmp.m.compose(tmp.p, tmp.q, tmp.s); planes.current.setMatrixAt(i, tmp.m);
      tmp.c.copy(sel ? COLORS.sel : COLORS[delayClass(delay) as "ok" | "warn" | "bad"]); planes.current.setColorAt(i, tmp.c);
      // size, not colour alone: a halo around every aircraft more than 15 minutes late (and the selected one)
      if ((delay > 15 || sel) && hn < 120) { const hcol = sel ? COLORS.accent : COLORS.bad; hp.setXYZ(hn, pos[0], pos[1] + 0.1, pos[2]); hc.setXYZ(hn, hcol.r, hcol.g, hcol.b); hn++; }
    });
    planes.current.instanceMatrix.needsUpdate = true; if (planes.current.instanceColor) planes.current.instanceColor.needsUpdate = true;
    for (let k = hn; k < 120; k++) hp.setXYZ(k, 99, 99, 99);
    halo.current.geometry.setDrawRange(0, hn); hp.needsUpdate = true; hc.needsUpdate = true;
    // ---- gates ----
    gates.forEach((g, i) => {
      const n = occ.get(g.id)?.length ?? 0;
      tmp.c.copy(g.id === s.selectedGate ? COLORS.accent : g.maintenance ? COLORS.maint : n > 1 ? COLORS.clash : n === 1 ? COLORS.occ : g.remote ? COLORS.remote : COLORS.idle);
      pads.current.setColorAt(i, tmp.c);
    });
    if (pads.current.instanceColor) pads.current.instanceColor.needsUpdate = true;
    // ---- weather: runway colour from the capacity bucket, storm cell and rain, lightning, ramp stop ----
    const cap = capacityAt(s, t), nominal = s.scenario.airport.nominalMovementsPerHour / 12;
    const w = weatherAt(s, t);
    const inStorm = intro ? (chapter >= 1 ? 1 : 0) : cap?.phase === "storm" ? 1 : cap?.phase === "recovery" ? 0.35 : s.disruption && w?.convective ? 0.5 : 0;
    const factor = cap ? Math.min(1, cap.capacity / nominal) : intro && chapter >= 1 ? 0.25 : 1;
    runArr.current.color.copy(COLORS.runOk).lerp(COLORS.runBad, 1 - factor); runArr.current.emissive.copy(runArr.current.color).multiplyScalar(0.4);
    stormMat.current.opacity += ((0.3 * inStorm) - stormMat.current.opacity) * 0.1;
    const flash = inStorm >= 1 && (w?.lightningWithin5nm || intro) && hash(Math.floor(now / 140)) > 0.8 && !s.reduced;
    stormLight.current.intensity = flash ? 400 : 0;
    const rp = rain.current.geometry.attributes.position as THREE.BufferAttribute;
    if (inStorm > 0 && !s.reduced) { for (let i = 0; i < N_RAIN; i++) { const r = 13 * Math.sqrt(hash(`r${i}`)), a = hash(`a${i}`) * 6.283; rp.setXYZ(i, STORM_C[0] + r * Math.cos(a), 11 - ((hash(`y${i}`) * 11 + now * 0.012) % 11), STORM_C[2] + r * Math.sin(a)); } rain.current.geometry.setDrawRange(0, N_RAIN); } else rain.current.geometry.setDrawRange(0, 0);
    rp.needsUpdate = true;
    // ---- ground vehicles: along the apron lane; the ramp is closed while lightning is within 5 nm, so they stop ----
    const rampClosed = !!w?.lightningWithin5nm && !!s.disruption;
    const vp = veh.current.geometry.attributes.position as THREE.BufferAttribute;
    for (let i = 0; i < N_VEH; i++) { const lane = i % 3; const x = ((hash(`v${i}`) * 60 + (rampClosed || s.reduced ? 0 : now * 0.0006 * (1 + (i % 4)) * (i % 2 ? 1 : -1))) % 60 + 60) % 60 - 30; vp.setXYZ(i, x, 0.2, lane === 0 ? 8.5 + (i % 5) * 0.2 : lane === 1 ? 9.4 : 4.6); }
    vp.needsUpdate = true;
    // ---- ripple from the runway to the gates and the passenger network ----
    const rpr = s.reduced ? 1.2 : (performance.now() - s.rippleAt) / 2800;
    rings.current.forEach((m, i) => { if (!m) return; const p = Math.min(1.2, Math.max(0, rpr - i * 0.14)); m.visible = rpr < 1.2 && p > 0; m.scale.setScalar(Math.max(0.01, p * 48)); (m.material as THREE.MeshBasicMaterial).opacity = Math.max(0, (1 - p / 1.1)) * 0.55; });
    // ---- missed connections: arcs between the two gates, live at the cursor ----
    if (conn.current.key !== P.key) {
      const list = connections(s.scenario, P.times).filter((c) => !c.made || c.gapMin - c.neededMin <= 5).map((c) => { const gi = gateOf(P.times.get(c.itinerary.inbound)!.gate), go = gateOf(P.times.get(c.itinerary.outbound)!.gate); return { a: gi.pos, b: go.pos, ta: Date.parse(c.inboundAt), td: Date.parse(c.outboundAt), made: c.made, slack: c.gapMin - c.neededMin, inb: c.itinerary.inbound, out: c.itinerary.outbound }; });
      conn.current = { key: P.key, list };
    }
    const lp = lineGeo.attributes.position as THREE.BufferAttribute, lc = lineGeo.attributes.color as THREE.BufferAttribute;
    let ln = 0; const pf = focus === "passengers";
    for (const c of conn.current.list) {
      if (ln >= MAX_LINES) break;
      const mine = s.selectedFlight && (c.inb === s.selectedFlight || c.out === s.selectedFlight);
      if (!pf && !mine && !(role !== "main" || s.disruption)) continue;
      if (!pf && !mine && (t < c.ta || t > c.td)) continue;
      if (pf && !mine && (t < c.ta - 20 * 60e3 || t > c.td + 5 * 60e3)) continue;
      const col = c.made ? COLORS.warn : COLORS.bad, mid: [number, number, number] = [(c.a[0] + c.b[0]) / 2, 3.5 + Math.abs(c.a[0] - c.b[0]) * 0.12, (c.a[1] + c.b[1]) / 2];
      const o = ln * 4;
      lp.setXYZ(o, c.a[0], 0.5, c.a[1]); lp.setXYZ(o + 1, mid[0], mid[1], mid[2]); lp.setXYZ(o + 2, mid[0], mid[1], mid[2]); lp.setXYZ(o + 3, c.b[0], 0.5, c.b[1]);
      for (let k = 0; k < 4; k++) lc.setXYZ(o + k, col.r, col.g, col.b);
      ln++;
    }
    lineGeo.setDrawRange(0, ln * 4); lp.needsUpdate = true; lc.needsUpdate = true;
    (lines.current.material as THREE.LineBasicMaterial).opacity = pf ? 0.95 : 0.55;
    // ---- stress: 5,000 more aircraft in simulation orbiting the field ----
    if (stress && stressMesh.current) {
      for (let i = 0; i < N_STRESS; i++) { const r = 30 + hash(i) * 60, a = hash(`s${i}`) * 6.283 + now * 0.00003 * (1 + (i % 7)); tmp.p.set(Math.cos(a) * r, 6 + (i % 17), Math.sin(a) * r - 10); tmp.e.set(0, -a - 1.57, 0); tmp.q.setFromEuler(tmp.e); tmp.s.set(0.6, 0.6, 0.6); tmp.m.compose(tmp.p, tmp.q, tmp.s); stressMesh.current.setMatrixAt(i, tmp.m); }
      stressMesh.current.instanceMatrix.needsUpdate = true;
    }
    if (driver && now - lastSample.current > 500) { lastSample.current = now; const i = gl.info; telemetry.sample({ calls: i.render.calls, triangles: i.render.triangles, points: i.render.points, geometries: i.memory.geometries, textures: i.memory.textures, programs: i.programs?.length ?? 0 }, s.rots.length + (stress ? N_STRESS : 0)); }
  });

  const onPlane = (e: ThreeEvent<MouseEvent>) => { e.stopPropagation(); const r = rots[e.instanceId ?? -1]; if (r) selectFlight(r.arrival.id); };
  const onPad = (e: ThreeEvent<MouseEvent>) => { e.stopPropagation(); const g = gates[e.instanceId ?? -1]; if (g) selectGate(g.id); };
  const padM = useMemo(() => new THREE.Matrix4(), []);
  useEffect(() => { gates.forEach((g, i) => { padM.makeScale(g.remote ? 1.5 : 1.7, 1, g.remote ? 1.5 : 1.9).setPosition(g.pos[0], 0.03, g.pos[1]); pads.current?.setMatrixAt(i, padM); }); if (pads.current) pads.current.instanceMatrix.needsUpdate = true; }, [gates, padM]);
  return (
    <>
      <hemisphereLight args={["#2a3a5a", "#05070c", 0.9]} />
      <directionalLight position={[10, 30, 10]} intensity={0.35} color="#8fb0e0" />
      <pointLight ref={stormLight} position={[-6, 12, -10]} intensity={0} color="#c9b6ff" distance={90} decay={1.4} />
      <mesh position={[0, -0.03, -2]} rotation={[-Math.PI / 2, 0, 0]}><planeGeometry args={[160, 120]} /><meshStandardMaterial color="#070b12" roughness={1} /></mesh>
      {[RUNWAY.arrZ, RUNWAY.depZ].map((z) => (
        <group key={z}>
          <mesh position={[0, 0.0, z]}><boxGeometry args={[RUNWAY.x1 - RUNWAY.x0, 0.05, 1.7]} /><meshStandardMaterial ref={z === RUNWAY.arrZ ? runArr : undefined} color="#12463b" roughness={0.9} /></mesh>
          <mesh position={[0, 0.04, z]}><boxGeometry args={[RUNWAY.x1 - RUNWAY.x0 - 6, 0.01, 0.08]} /><meshBasicMaterial color="#9fb2c8" /></mesh>
        </group>
      ))}
      <mesh position={[-28, 0.0, -2]}><boxGeometry args={[0.7, 0.04, 20]} /><meshStandardMaterial color="#0d1626" /></mesh>
      <mesh position={[28, 0.0, -2]}><boxGeometry args={[0.7, 0.04, 20]} /><meshStandardMaterial color="#0d1626" /></mesh>
      <mesh position={[0, 0.0, 8.5]}><boxGeometry args={[60, 0.04, 0.8]} /><meshStandardMaterial color="#0d1626" /></mesh>
      {[[-6, 3.2, 24], [16, 3.2, 20], [-6, 13.8, 24]].map(([x, z, w], i) => <mesh key={i} position={[x, 0.7, z]}><boxGeometry args={[w, 1.4, 1.8]} /><meshStandardMaterial color="#16233a" emissive="#0c2a44" emissiveIntensity={0.7} /></mesh>)}
      <instancedMesh ref={pads} args={[undefined, undefined, Math.max(1, gates.length)]} onClick={onPad} frustumCulled={false}><boxGeometry args={[1, 0.05, 1]} /><meshBasicMaterial toneMapped={false} /></instancedMesh>
      <instancedMesh ref={planes} args={[planeGeo, undefined, Math.max(1, rots.length)]} onClick={onPlane} frustumCulled={false}><meshBasicMaterial toneMapped={false} /></instancedMesh>
      <points ref={halo} geometry={haloGeo} frustumCulled={false}><pointsMaterial size={2.4} vertexColors map={sprite} transparent opacity={0.55} depthWrite={false} /></points>
      <points ref={veh} geometry={vehGeo} frustumCulled={false}><pointsMaterial size={0.45} color="#ffb454" map={sprite} transparent depthWrite={false} /></points>
      <points ref={rain} geometry={rainGeo} frustumCulled={false}><pointsMaterial size={0.14} color="#8fb0e0" map={sprite} transparent opacity={0.7} depthWrite={false} /></points>
      <lineSegments ref={lines} geometry={lineGeo} frustumCulled={false}><lineBasicMaterial vertexColors transparent opacity={0.6} /></lineSegments>
      <mesh position={[STORM_C[0], 6, STORM_C[2]]}><cylinderGeometry args={[14, 14, 12, 40, 1, true]} /><meshBasicMaterial ref={stormMat} color="#5a3aa8" transparent opacity={0} side={THREE.DoubleSide} depthWrite={false} /></mesh>
      {[0, 1, 2].map((i) => <mesh key={i} ref={(m) => { rings.current[i] = m; }} position={[0, 0.08, RUNWAY.arrZ]} rotation={[-Math.PI / 2, 0, 0]} visible={false}><ringGeometry args={[0.97, 1, 72]} /><meshBasicMaterial color="#ff8a5a" transparent opacity={0} depthWrite={false} /></mesh>)}
      {stress ? <instancedMesh ref={stressMesh} args={[planeGeo, undefined, N_STRESS]} frustumCulled={false}><meshBasicMaterial color="#2a3a52" /></instancedMesh> : null}
    </>
  );
}
// the scene reads the store directly; this tiny hook avoids importing the React hook name twice
import { useApp as useApp0 } from "../store.ts";

const canvasProps = { className: "globe", dpr: [1, 1.5] as [number, number], camera: { fov: 42, near: 0.1, far: 300, position: [3, 38, 60] as [number, number, number] }, gl: { antialias: true, powerPreference: "high-performance" as const, alpha: false } };
const onCreated = ({ gl }: { gl: THREE.WebGLRenderer }) => { gl.setClearColor("#03050a"); };

export default function Scene() {
  return <Canvas {...canvasProps} onCreated={onCreated}><AirportView role="main" /></Canvas>;
}

/** Two synchronized views of the same airport: option on the left, option on the right, one clock, one camera. */
export function SplitScene() {
  return (
    <>
      <Canvas {...canvasProps} onCreated={onCreated} aria-label="Left plan"><AirportView role="left" /></Canvas>
      <Canvas {...canvasProps} onCreated={onCreated} aria-label="Right plan"><AirportView role="right" /></Canvas>
    </>
  );
}
