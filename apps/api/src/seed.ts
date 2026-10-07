// Loads the synthetic airport (data/fixtures, made by data/simulators/generate.ts) into Postgres as the owner. Idempotent:
// `make reset` truncates first. Demo tokens are local-only and printed in the README.
import { readFileSync } from "node:fs";
import pg from "pg";
import { uuidFor, type Scenario } from "../../../packages/domain/src/index.ts";
import { sha256 } from "./db.ts";

export const ORGS = [
  { id: uuidFor(9, 1), slug: "norrvik", name: "Norrvik Airport Operations (synthetic)", plan: "enterprise" },
  { id: uuidFor(9, 2), slug: "halden", name: "Halden Regional Airport (synthetic)", plan: "operator_pro" },
] as const;
export const TOKENS = [
  { token: "norrvik-dispatcher-demo", org: "norrvik", role: "operator" },
  { token: "norrvik-viewer-demo", org: "norrvik", role: "viewer" },
  { token: "halden-dispatcher-demo", org: "halden", role: "operator" },
] as const;
export const gateId = (code: string) => uuidFor(11, [...code].reduce((s, c) => s * 31 + c.charCodeAt(0), 7) >>> 0);
export const flightId = (no: string) => uuidFor(12, Number(no.replace(/\D/g, "")) + [...no].reduce((s, c) => s + c.charCodeAt(0), 0) * 100000);

export async function seed(url = process.env.OWNER_DATABASE_URL ?? "postgresql://aether:owner-dev-only@127.0.0.1:55540/aether", reset = false) {
  const sc: Scenario = JSON.parse(readFileSync(new URL("../../../data/fixtures/scenario.json", import.meta.url), "utf8"));
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  await c.query("BEGIN");
  if (reset) await c.query("TRUNCATE gate_assignments, recovery_options, disruption_scenarios, itineraries, weather_observations, resources, flights, gates, aircraft, airports, agent_invocations, api_tokens, idempotency_keys, audit_log, client_telemetry, organizations CASCADE");
  const have = (await c.query("SELECT count(*)::int AS n FROM flights")).rows[0].n;
  if (have > 0 && !reset) { await c.query("ROLLBACK"); await c.end(); console.log(JSON.stringify({ msg: "already seeded", flights: have })); return; }
  for (const o of ORGS) await c.query("INSERT INTO organizations (id, slug, name, plan) VALUES ($1,$2,$3,$4)", [o.id, o.slug, o.name, o.plan]);
  for (const t of TOKENS) await c.query("INSERT INTO api_tokens (token_sha256, organization_id, role, label) VALUES ($1,$2,$3,$4)", [sha256(t.token), ORGS.find((o) => o.slug === t.org)!.id, t.role, t.token]);
  const tenant = ORGS[0].id;
  await c.query("INSERT INTO airports (tenant_id, code, name, config, window_start, window_end, t0) VALUES ($1,$2,$3,$4,$5,$6,$7)", [tenant, sc.airport.code, sc.airport.name, { ...sc.airport, planted: sc.planted }, sc.start, sc.end, sc.t0]);
  for (const a of sc.aircraft) await c.query("INSERT INTO aircraft (tenant_id, tail, aircraft_type, class, seats, turnaround_min) VALUES ($1,$2,$3,$4,$5,$6)", [tenant, a.tail, a.type, a.cls, a.seats, a.turnaroundMin]);
  for (const g of sc.gates) await c.query("INSERT INTO gates (id, tenant_id, terminal, gate_code, compatible_aircraft_types, constraints) VALUES ($1,$2,$3,$4,$5,$6)", [gateId(g.id), tenant, g.terminal, g.id, g.compatible, { remote: g.remote, maintenance: g.maintenance, pos: g.pos }]);
  const type = new Map(sc.aircraft.map((a) => [a.tail, a.type]));
  for (const f of sc.flights) {
    const arr = f.kind === "arrival";
    await c.query("INSERT INTO flights (id, tenant_id, flight_no, origin, destination, scheduled_arrival, scheduled_departure, estimated_arrival, estimated_departure, aircraft_type, status, kind, tail, other_flight_no, home_gate, pax, remarks, last_of_day) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'scheduled',$11,$12,$13,$14,$15,$16,$17)",
      [flightId(f.id), tenant, f.id, arr ? f.city : "NVK", arr ? "NVK" : f.city, arr ? f.scheduled : null, arr ? null : f.scheduled, arr ? f.estimated : null, arr ? null : f.estimated, type.get(f.tail), f.kind, f.tail, f.other, f.gate, f.pax, f.remarks, f.lastOfDay]);
    await c.query("INSERT INTO gate_assignments (flight_id, tenant_id, gate_id, start_ts, end_ts, assignment_source) VALUES ($1,$2,$3,$4,$5,'schedule')", [flightId(f.id), tenant, gateId(f.gate), f.scheduled, new Date(Date.parse(f.scheduled) + 40 * 60e3).toISOString()]);
  }
  for (const i of sc.itineraries) await c.query("INSERT INTO itineraries (id, tenant_id, seq, inbound_flight_no, outbound_flight_no, pax, mobility, minor) VALUES ($1,$2,$8,$3,$4,$5,$6,$7)", [uuidFor(13, Number(i.id.replace(/\D/g, ""))), tenant, i.inbound, i.outbound, i.pax, i.mobility, i.minor, Number(i.id.replace(/\D/g, ""))]);
  let rn = 0;
  for (const r of sc.resources) await c.query("INSERT INTO resources (id, tenant_id, resource_type, location, status, capabilities, code) VALUES ($1,$2,$3,$4,$5,$6,$7)", [uuidFor(14, ++rn), tenant, r.type, r.location, r.status, {}, r.id]);
  for (const w of sc.weather) await c.query("INSERT INTO weather_observations (tenant_id, ts, payload) VALUES ($1,$2,$3)", [tenant, w.ts, w]);
  await c.query("COMMIT");
  await c.end();
  console.log(JSON.stringify({ msg: "seeded", flights: sc.flights.length, gates: sc.gates.length, itineraries: sc.itineraries.length, observations: sc.weather.length }));
}

if (import.meta.url === `file://${process.argv[1]}`) await seed(undefined, process.argv.includes("--reset"));
