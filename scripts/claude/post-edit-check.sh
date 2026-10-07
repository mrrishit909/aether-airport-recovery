#!/bin/bash
# PostToolUse(Edit|Write): typecheck the package the edited file belongs to. Fast, deterministic, no reasoning tokens.
f=$(jq -r '.tool_input.file_path // empty' 2>/dev/null)
[ -z "$f" ] && exit 0
case "$f" in
  */apps/web/*) (cd "$(dirname "$0")/../../apps/web" && npx tsc --noEmit -p . 2>&1 | head -20) ;;
  */apps/api/migrations/*.sql) grep -q "tenant_id" "$f" || echo "warning: migration $f has no tenant_id column" ;;
  *.ts) (cd "$(dirname "$0")/../.." && npx tsc -p . 2>&1 | grep -F "$(basename "$f")" | head -20) ;;
esac
exit 0
