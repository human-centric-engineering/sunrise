#!/usr/bin/env bash
#
# Fail if a Postgres connection string points at a host that isn't local.
#
# Why this exists
# ---------------
# TruffleHog's `Postgres` detector produced 27 unverified findings on this repo
# and zero verified ones — every hit a `localhost` / `db` fixture in a test, a
# doc, .env.example or the CI workflow itself. That noise failed the merge gate.
#
# The fix was a PATH allowlist: .trufflehog-exclude.txt exempts tests/,
# .context/, .claude/, docs/, .env.example and docker-compose*.yml. Note what
# that costs — exclusions are per-path, not per-detector, so EVERY detector goes
# quiet in those directories, which is exactly where someone is most likely to
# paste a real key. (An earlier version of this comment described that allowlist
# as the rejected alternative. It is what shipped.)
#
# This check is what buys that coverage back for the one credential class
# provably living in those paths. It ignores paths entirely — `git ls-files`,
# every tracked file — and it cannot be fooled into firing on a fixture, because
# it only cares whether the host is routable. A DSN pointing at localhost is a
# fixture by definition. A DSN pointing anywhere else in committed source is a
# leak until proven otherwise.
#
# It is narrower than the detector it supplements: it verifies nothing and only
# understands Postgres URIs. That is deliberate — it is a tripwire for the one
# class of finding the noise was drowning out, not a replacement for TruffleHog.
#
# See #453.

set -euo pipefail

# Hosts that can only ever be a fixture:
#   • loopback, and the Docker Compose service names this repo uses
#   • placeholder words documentation substitutes for a real host
#   • example.com / .net / .org — reserved by RFC 2606 for documentation, so they
#     can never resolve to a live database no matter what is committed alongside
readonly LOCAL_HOSTS='localhost|127\.0\.0\.1|0\.0\.0\.0|\[?::1\]?|db|postgres|postgres-test|pgvector|host\.docker\.internal|host|hostname|your-host|\[host\]|<host>|\$\{[^}]*\}|([a-z0-9-]+\.)*example\.(com|net|org)'

# Credentials that are self-evidently placeholders. Checked as well as the host,
# because deployment docs legitimately show a REAL provider hostname (a Neon
# pooler endpoint, an RDS endpoint) to make the example recognisable. Enumerating
# every such host would be an endless list; the password is the better signal,
# since what we actually care about is a real credential, not a real host.
readonly PLACEHOLDER_CREDS='(user|username|myuser|postgres|admin|USER|USERNAME):(pass|password|passwd|mypassword|secret|changeme|placeholder|postgres|PASS|PASSWORD|<[^>]*>|\[[^]]*\]|\$\{[^}]*\})'

# Matches scheme://userinfo@host, capturing userinfo and host separately so each
# can be tested against the two allowlists above.
#
# Deliberately NOT illustrated with a literal example DSN here. The original
# reason -- that this file is scanned like any other real source -- no longer
# holds: the same commit that removed the example also added this file to
# .trufflehog-exclude.txt, because the PR scan reads the whole commit range and
# the history still carried the string. So TruffleHog no longer scans this file
# and an example would not fail the job.
#
# It stays out anyway, as house style rather than as a gate: a realistic-looking
# DSN in the one file whose subject is committed DSNs is confusing to every
# later reader, and the tripwire below still scans this file like any other, so
# anything resembling a real credential here would fire it.
readonly DSN_RE='postgres(ql)?://[^:/@[:space:]]+:[^@[:space:]]+@[^:/[:space:]"'"'"']+'

fail=0

# Only tracked files; never scan node_modules or build output.
while IFS= read -r file; do
  while IFS= read -r match; do
    host="${match##*@}"
    # Strip the scheme, then take everything before the last '@'.
    userinfo="${match#*://}"
    userinfo="${userinfo%@*}"
    if [[ "$userinfo" =~ ^($PLACEHOLDER_CREDS)$ ]]; then
      continue
    fi
    if [[ ! "$host" =~ ^($LOCAL_HOSTS)$ ]]; then
      if [[ "$fail" -eq 0 ]]; then
        echo "::error::Postgres connection string with a non-local host found in committed source."
        echo ""
        echo "A DSN pointing anywhere other than localhost is treated as a leaked credential."
        echo "If this is documentation, use placeholder credentials (user:pass) or a local host."
        echo ""
      fi
      echo "  $file — host: $host"
      fail=1
    fi
  done < <(grep -oE "$DSN_RE" "$file" 2>/dev/null || true)
done < <(git ls-files -z | tr '\0' '\n' | grep -vE '^(node_modules|\.next|coverage|dist)/' || true)

if [[ "$fail" -ne 0 ]]; then
  echo ""
  echo "If the host is legitimately non-local and not a secret, add it to LOCAL_HOSTS"
  echo "in scripts/ci/check-postgres-dsn.sh with a comment explaining why."
  exit 1
fi

echo "No Postgres connection strings with non-local hosts."
