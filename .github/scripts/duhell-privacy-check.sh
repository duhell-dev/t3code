#!/usr/bin/env bash
# The fork is public. Lines it adds on top of upstream must not carry private details:
# private network addresses, tailnet hosts, home-directory paths, mail addresses or tokens.
set -euo pipefail
base="${1:-origin/main}"
pattern='(\b(10|192\.168)\.[0-9]{1,3}\.[0-9]{1,3}\b|\b172\.(1[6-9]|2[0-9]|3[01])\.[0-9]{1,3}\.[0-9]{1,3}\b|[a-z0-9-]+\.ts\.net\b|/home/[a-z_][a-z0-9_-]*/|[A-Za-z]:\\Users\\|[A-Za-z0-9._%+-]+@(gmail|googlemail|outlook|hotmail|gmx|web|icloud)\.[a-z]+|ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-(ant|or|proj)-[A-Za-z0-9_-]{10,}|xox[abp]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY-----)'
hits=$(git diff --unified=0 "$base...HEAD" -- . ':(exclude).github/scripts/duhell-privacy-check.sh' |
  awk '/^\+\+\+ b\//{file=substr($0,7)} /^\+[^+]/{print file": "substr($0,2)}' |
  grep -E -i "$pattern" || true)
if [ -n "$hits" ]; then
  echo "Private details in lines this fork adds (public repository):"
  echo "$hits"
  exit 1
fi
echo "No private details in the fork's own changes."
