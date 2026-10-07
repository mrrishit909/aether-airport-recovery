// The Agent Contract Standard (build book section 9). Every application agent returns this shape; nothing is persisted or
// handed to another agent until it validates. The JSON schema is published (docs/openapi.json components) and the checker
// below is hand-written so the browser does not bundle a schema library; a test proves both agree.

export type AgentStatus = "success" | "partial" | "failed";

export interface Finding {
  id: string;
  type: string;
  summary: string;
  confidence: number;
  evidence: string[];          // event ids
  entities: string[];          // entity ids
  data: Record<string, unknown>;
  technique?: string;          // ATT&CK-style technique id, filled by threat intel
}

export interface AgentResult<F = Finding> {
  agent: string;
  run_id: string;
  status: AgentStatus;
  confidence: number;
  findings: F[];
  evidence_refs: string[];
  assumptions: string[];
  warnings: string[];
  metrics: { latency_ms: number; input_tokens: number; output_tokens: number; estimated_cost_usd: number };
}

export const AGENT_RESULT_SCHEMA = {
  $id: "https://aether.local/schemas/agent-result.json",
  type: "object",
  required: ["agent", "run_id", "status", "confidence", "findings", "evidence_refs", "assumptions", "warnings", "metrics"],
  additionalProperties: false,
  properties: {
    agent: { type: "string", minLength: 1, maxLength: 64, pattern: "^[a-z0-9-]+$" },
    run_id: { type: "string", minLength: 8, maxLength: 64 },
    status: { type: "string", enum: ["success", "partial", "failed"] },
    confidence: { type: "number", minimum: 0, maximum: 1 },
    findings: { type: "array", maxItems: 500, items: {
      type: "object", required: ["id", "type", "summary", "confidence", "evidence", "entities", "data"], additionalProperties: false,
      properties: { id: { type: "string", minLength: 1 }, type: { type: "string", minLength: 1, maxLength: 64 }, summary: { type: "string", maxLength: 1000 },
        confidence: { type: "number", minimum: 0, maximum: 1 }, evidence: { type: "array", items: { type: "string" }, maxItems: 1000 },
        entities: { type: "array", items: { type: "string" }, maxItems: 1000 }, data: { type: "object" }, technique: { type: "string", maxLength: 32 } } } },
    evidence_refs: { type: "array", items: { type: "string" }, maxItems: 10000 },
    assumptions: { type: "array", items: { type: "string", maxLength: 500 }, maxItems: 100 },
    warnings: { type: "array", items: { type: "string", maxLength: 500 }, maxItems: 100 },
    metrics: { type: "object", required: ["latency_ms", "input_tokens", "output_tokens", "estimated_cost_usd"], additionalProperties: false,
      properties: { latency_ms: { type: "number", minimum: 0 }, input_tokens: { type: "integer", minimum: 0 }, output_tokens: { type: "integer", minimum: 0 }, estimated_cost_usd: { type: "number", minimum: 0 } } },
  },
} as const;

const isObj = (x: unknown): x is Record<string, unknown> => !!x && typeof x === "object" && !Array.isArray(x);
const num01 = (x: unknown) => typeof x === "number" && Number.isFinite(x) && x >= 0 && x <= 1;
const strs = (x: unknown, max: number, len = 500) => Array.isArray(x) && x.length <= max && x.every((s) => typeof s === "string" && s.length <= len);

/** Returns the list of violations (empty = valid). Mirrors AGENT_RESULT_SCHEMA exactly. */
export function validateContract(x: unknown): string[] {
  const e: string[] = [];
  if (!isObj(x)) return ["result is not an object"];
  const keys = ["agent", "run_id", "status", "confidence", "findings", "evidence_refs", "assumptions", "warnings", "metrics"];
  for (const k of keys) if (!(k in x)) e.push(`missing ${k}`);
  for (const k of Object.keys(x)) if (!keys.includes(k)) e.push(`unexpected key ${k}`);
  if (typeof x.agent !== "string" || !/^[a-z0-9-]+$/.test(x.agent) || x.agent.length > 64) e.push("agent must be a kebab-case name");
  if (typeof x.run_id !== "string" || x.run_id.length < 8 || x.run_id.length > 64) e.push("run_id must be 8..64 chars");
  if (!["success", "partial", "failed"].includes(x.status as string)) e.push("status must be success|partial|failed");
  if (!num01(x.confidence)) e.push("confidence must be a number in [0,1]");
  if (!Array.isArray(x.findings) || x.findings.length > 500) e.push("findings must be an array (max 500)");
  else x.findings.forEach((f, i) => {
    if (!isObj(f)) return e.push(`findings[${i}] is not an object`);
    const fk = ["id", "type", "summary", "confidence", "evidence", "entities", "data", "technique"];
    for (const k of Object.keys(f)) if (!fk.includes(k)) e.push(`findings[${i}] has unexpected key ${k}`);
    if (typeof f.id !== "string" || !f.id) e.push(`findings[${i}].id missing`);
    if (typeof f.type !== "string" || !f.type || f.type.length > 64) e.push(`findings[${i}].type missing`);
    if (typeof f.summary !== "string" || f.summary.length > 1000) e.push(`findings[${i}].summary must be a string (max 1000)`);
    if (!num01(f.confidence)) e.push(`findings[${i}].confidence must be in [0,1]`);
    if (!strs(f.evidence, 1000, 1e9)) e.push(`findings[${i}].evidence must be string ids`);
    if (!strs(f.entities, 1000, 1e9)) e.push(`findings[${i}].entities must be string ids`);
    if (!isObj(f.data)) e.push(`findings[${i}].data must be an object`);
    if (f.technique !== undefined && (typeof f.technique !== "string" || f.technique.length > 32)) e.push(`findings[${i}].technique must be a short string`);
  });
  if (!strs(x.evidence_refs, 10000, 1e9)) e.push("evidence_refs must be string ids");
  if (!strs(x.assumptions, 100)) e.push("assumptions must be strings (max 500 chars)");
  if (!strs(x.warnings, 100)) e.push("warnings must be strings (max 500 chars)");
  const m = x.metrics;
  if (!isObj(m)) e.push("metrics missing");
  else {
    for (const k of ["latency_ms", "input_tokens", "output_tokens", "estimated_cost_usd"]) if (typeof m[k] !== "number" || !(m[k] as number >= 0)) e.push(`metrics.${k} must be a non-negative number`);
    for (const k of ["input_tokens", "output_tokens"]) if (typeof m[k] === "number" && !Number.isInteger(m[k])) e.push(`metrics.${k} must be an integer`);
    for (const k of Object.keys(m)) if (!["latency_ms", "input_tokens", "output_tokens", "estimated_cost_usd"].includes(k)) e.push(`metrics has unexpected key ${k}`);
  }
  return e;
}

export class ContractError extends Error {
  violations: string[];
  constructor(agent: string, violations: string[]) { super(`${agent} returned an invalid contract: ${violations.slice(0, 3).join("; ")}`); this.violations = violations; }
}
