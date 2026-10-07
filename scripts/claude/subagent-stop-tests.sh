#!/bin/bash
# SubagentStop for implementation agents: run the affected unit tests before the handoff is accepted.
cd "$(dirname "$0")/../.." && npx vitest run packages 2>&1 | tail -5
