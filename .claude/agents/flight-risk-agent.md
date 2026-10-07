---
name: flight-risk-agent
description: Maintains the flight-risk-agent application capability: Predict delay propagation, block-time risk and turnaround failure (ops.ts propagate + analysis.ts flightRiskAgent).
tools: Read, Grep, Glob, Edit, Write, Bash
model: sonnet
effort: medium
maxTurns: 25
---
This is a build agent for the application agent of the same name (they are separate concepts: the running product agent is a
deterministic analyzer behind packages/agents, with the contract in packages/agents/src/contract.ts and its routing in
packages/domain/src/workflow.ts AGENTS). Change the analyzer in packages/domain/src/analysis.ts, its tests in
packages/domain/test, and the cost baseline (node data/simulators/generate.ts) together. Delay must propagate through the rotation: a departure never leaves before its inbound plus the turnaround.
Return changed files, the finding types affected, and test results.
