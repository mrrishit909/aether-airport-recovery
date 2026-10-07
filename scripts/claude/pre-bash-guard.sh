#!/bin/bash
# PreToolUse(Bash): block destructive database/git commands; exit 2 refuses the tool call with the message on stderr.
if [ "$1" = "--self-test" ]; then
  for c in "rm -rf /" "git push --force origin main" "psql -c 'DROP TABLE incidents'" "docker compose down -v"; do
    echo "{\"tool_input\":{\"command\":\"$c\"}}" | bash "$0" 2>/dev/null && { echo "guard let through: $c"; exit 1; }
  done
  echo "guard self-test ok"; exit 0
fi
cmd=$(jq -r '.tool_input.command // empty' 2>/dev/null)
[ -z "$cmd" ] && exit 0
if echo "$cmd" | grep -Eq 'rm -rf +/( |$)|git push +(-f|--force)|DROP +(TABLE|DATABASE|SCHEMA)|TRUNCATE +[a-z_]+( |;|$)|docker compose down +-v|git reset +--hard'; then
  echo "blocked by scripts/claude/pre-bash-guard.sh: destructive command needs explicit human approval: $cmd" >&2
  exit 2
fi
exit 0
