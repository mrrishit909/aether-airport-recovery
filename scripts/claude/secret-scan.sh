#!/bin/bash
# Stop hook / CI: refuse obvious secrets and .env files in the tree.
cd "$(dirname "$0")/../.."
if git ls-files | grep -Eq '(^|/)\.env$'; then echo "a .env file is tracked" >&2; exit 2; fi
if git grep -nE '(sk-ant-[A-Za-z0-9_-]{20,}|sk-proj-[A-Za-z0-9_-]{20,}|github_pat_[A-Za-z0-9_]{20,}|gh[pousr]_[A-Za-z0-9]{30,}|AKIA[A-Z0-9]{16}|-----BEGIN [A-Z ]*PRIVATE KEY)' -- . ':!*.md' 2>/dev/null | grep -v SYNTHETIC; then echo "something looks like a secret" >&2; exit 2; fi
echo "secret scan clean"
