#!/usr/bin/env bash
#
# Verify the Sunrise release this tree CLAIMS is actually an ancestor of HEAD.
#
# Why this exists
# ---------------
# A fork that squash-merges its sync PR keeps every file but loses the second
# parent. Git then no longer knows the release tag is an ancestor, and the merge
# base against upstream silently reverts to the PREVIOUS release. Nothing looks
# wrong — until the next sync replays the whole preceding range and re-conflicts
# every file already resolved by hand.
#
# That happened to hce-website on the v0.8.0 sync. The content was perfect
# (`tree()` byte-identical to the merged branch tip); only the ancestry was
# gone. It was repaired with a zero-diff `git merge -s ours v0.8.0`, but only
# because it was caught within the hour. Caught six months later, mid-sync, it
# reads as "why is this merge conflicting on 342 files?" and the cause is long
# out of view.
#
# Neither obvious answer works. Repo rulesets can restrict merge methods, but
# only for EVERY PR into the branch — forks reasonably squash their own feature
# work, and forcing merge commits everywhere to protect one PR per release is
# the wrong trade. Documentation cannot intervene either: merging is a human
# click in the GitHub UI, months after anyone last read the sync guide.
# `CUSTOMIZATION.md` already documents the flow correctly, and it did not help.
#
# So this is DETECTION, not prevention. The goal is collapsing time-to-discovery
# from months to minutes, because the repair is trivial only while the context
# is fresh.
#
# It is a guaranteed no-op in Sunrise's own repository — Sunrise tags every
# release on `main`, so the tag is always an ancestor. It can only fire
# downstream, which is exactly where the hazard lives. And it is self-enforcing:
# a fork RECEIVES this guard by doing a sync merge, so squashing that sync makes
# it fire on the first run afterwards.
#
# Exit codes: 0 = intact or deliberately skipped, 1 = ancestry lost.
#
# See #539.

# NOTE: `-e` is deliberately absent. Several steps below are expected to fail
# (no version file, tag not fetchable) and are handled explicitly; `-e` would
# turn each into an unexplained non-zero exit, which for a guard is
# indistinguishable from a real finding.
set -uo pipefail

REF="${1:-HEAD}"
UPSTREAM_URL="${UPSTREAM_URL:-https://github.com/human-centric-engineering/sunrise.git}"

# Never print the URL raw. Git strips the userinfo component — everything
# between the scheme and the `@` — from its own error output, keeping just
# scheme and host. So a message echoing `$UPSTREAM_URL` verbatim would be the
# only place a token appeared in full, and `CUSTOMIZATION.md` allows the URL to
# be a repository VARIABLE, which GitHub does not mask.
#
# (Described rather than illustrated: a worked example here would itself be a
# credential-shaped URI, which is what TruffleHog's URI detector exists to
# find — and it duly failed the secret-scan job on the first version of this
# comment.)
SAFE_URL=$(printf '%s' "$UPSTREAM_URL" | sed -E 's#^([a-zA-Z][a-zA-Z0-9+.-]*://)[^/@]*@#\1#')

# A skip is the outcome that most needs to be VISIBLE. Three legitimate
# conditions below end in one, and a silent green tick on any of them is
# indistinguishable from a real pass — which for a guard whose whole premise is
# time-to-discovery would be the failure mode reappearing one level up. GitHub
# renders `::warning::` as an annotation on the run; a bare `echo` does not.
skip() {
  echo "notice: $1"
  echo "::warning title=Sunrise ancestry check skipped::$1"
  exit 0
}

# `::error::` is LINE-scoped: everything after the first newline would land in
# the log only, and the annotation — the surface an operator actually sees
# without expanding the job — would carry the diagnosis without the repair. So
# print the body plainly for the log, then again encoded onto one line.
fail() {
  local body="$1"
  printf '%s\n' "$body"
  printf '::error title=Sunrise sync ancestry lost::%s\n' \
    "$(printf '%s' "$body" | awk '{ gsub(/%/, "%25"); printf "%s%s", sep, $0; sep = "%0A" }')"
  exit 1
}

# Read the claim from the TREE, not the working directory — the question is
# what this commit says it is, which is what a reader six months later will see.
# Tolerates either quote style: prettier enforces single, but a fork's editor
# may not, and a parse miss here would silently skip the check.
VERSION=$(git show "$REF:lib/sunrise-version.ts" 2>/dev/null |
  sed -n "s/.*SUNRISE_VERSION *= *['\"]\([^'\"]*\)['\"].*/\1/p" | head -1)

if [ -z "$VERSION" ]; then
  skip "no SUNRISE_VERSION found at $REF"
fi
TAG="v$VERSION"

# Ancestry cannot be computed on a shallow clone: `merge-base --is-ancestor`
# would answer from truncated history and report a loss that has not happened.
if [ "$(git rev-parse --is-shallow-repository 2>/dev/null)" = "true" ]; then
  skip "shallow clone — ancestry needs 'fetch-depth: 0'"
fi

# Resolve the tag into a PRIVATE ref, and use ONLY that.
#
# `refs/tags/$TAG` cannot be trusted, in either direction. A fork versions its
# app independently of Sunrise, so a fork sitting at Sunrise 0.9.0 may hold its
# OWN `v0.9.0` pointing at its own history:
#
#   - if that tag IS an ancestor of the fork's main (the normal case for a
#     fork's own release), a check reading it reports SUCCESS on a repository
#     whose Sunrise ancestry is genuinely broken;
#   - if it is not, the check fails and tells the operator to
#     `git merge -s ours` the fork's unrelated release branch into main —
#     recording a claim that is false.
#
# An earlier revision of this script fell back to the local tag when the fetch
# failed, which reintroduced both. Verified: with the fetch unreachable and a
# fork-owned `v0.8.0` present, a squash-merged repository reported
# "sync history intact". There is no fallback now — if upstream cannot be
# reached, the honest answer is that we could not look.
# Namespaced by PID. Two runs in one working copy — which the manual-use case
# makes real — would otherwise share a ref, and one run's EXIT trap would delete
# it out from under the other between its fetch and its merge-base.
readonly PRIVATE_REF="refs/sunrise-ancestry/$$/$TAG"

# The ref is an implementation detail of one run. Left behind it accumulates one
# per version, keeps the fetched objects permanently reachable from gc, and
# shows up in `git log --all` — which matters because this script is also meant
# to be run by hand against a working copy.
cleanup() { git update-ref -d "$PRIVATE_REF" 2>/dev/null || true; }
trap cleanup EXIT

# `--` before the URL: without it a value beginning with `-` is parsed as an
# option, and `--upload-pack=<cmd>` is arbitrary command execution on the
# runner. Setting the repo variable already requires write access (which implies
# workflow-edit rights), so this is defence in depth rather than a boundary —
# but it costs one token.
#
# stderr is CAPTURED rather than discarded. A fork that mistypes the URL or
# supplies a token with the wrong scope would otherwise get the same opaque skip
# forever, indistinguishable from Sunrise's normal mid-release skip — and for a
# guard whose premise is that skips must be visible and actionable, git's reason
# is the actionable half. GitHub masks secrets in logs, so a tokenised URL in
# git's output is not leaked by this.
fetch_err=$(git fetch --quiet --no-tags --force -- "$UPSTREAM_URL" "refs/tags/$TAG:$PRIVATE_REF" 2>&1 >/dev/null)
fetch_status=$?

# Branch on the FETCH, not on whether the ref exists. Testing existence made a
# leftover `refs/sunrise-ancestry/*` — from a killed run, or a second concurrent
# hand-run in the same working copy — into exactly the silent fallback the
# comment above says was removed. Reproduced: a pre-created private ref pointing
# at the fork's own HEAD, with upstream unreachable, reported "sync history
# intact".
#
# A failure here is mid-release (the commit bumping SUNRISE_VERSION lands BEFORE
# the tag is pushed) or an unreachable upstream. Never fail on either: the first
# would red-line every Sunrise release at the moment of cutting it, and on the
# second the guard cannot tell "ancestry lost" from "cannot look".
if [ "$fetch_status" -ne 0 ] || ! git rev-parse -q --verify "$PRIVATE_REF" >/dev/null 2>&1; then
  detail=$(printf '%s' "$fetch_err" | tr '\n' ' ' | sed 's/  */ /g')
  skip "$TAG not fetchable from upstream — mid-release, or upstream unreachable${detail:+ (git: $detail)}"
fi

# Confirm the tag we fetched is SUNRISE's release, not a same-named release
# belonging to whatever `UPSTREAM_URL` points at.
#
# This closes the collision one level up from the private ref. `CUSTOMIZATION.md`
# tells a leaf fork of a framework-tier fork (Daybreak) to point `UPSTREAM_URL`
# at that intermediate — which versions itself independently, so its own
# `v0.8.1` is an unrelated release that IS an ancestor of the leaf fork's main.
# Without this the guard would print "sync history intact" on a repository whose
# Sunrise ancestry is genuinely lost: the same false negative the private ref
# exists to prevent, arriving through the escape hatch.
#
# Every Sunrise release tag points at the commit that bumped the file, so the
# claim and the tag always agree — verified against v0.5.0 through v0.8.1.
TAG_VERSION=$(git show "$PRIVATE_REF:lib/sunrise-version.ts" 2>/dev/null |
  sed -n "s/.*SUNRISE_VERSION *= *['\"]\([^'\"]*\)['\"].*/\1/p" | head -1)
if [ "$TAG_VERSION" != "$VERSION" ]; then
  skip "$TAG at $SAFE_URL claims Sunrise '${TAG_VERSION:-none}', not '$VERSION' — that is not Sunrise's release tag, so ancestry cannot be judged from it"
fi

git merge-base --is-ancestor "$PRIVATE_REF" "$REF"
ancestry_status=$?
if [ "$ancestry_status" -eq 0 ]; then
  echo "ok: $TAG is an ancestor of $REF — sync history intact"
  exit 0
fi

# ONLY exit 1 means "not an ancestor". A missing or unreadable ref exits 128,
# and treating that as a finding would announce a lost merge base — with the
# repair below — for a corrupt object, an I/O error, or a ref that vanished
# mid-run. Verified: `merge-base --is-ancestor` on a missing ref exits 128.
if [ "$ancestry_status" -ne 1 ]; then
  skip "could not evaluate ancestry for $TAG (git exit $ancestry_status) — not treating that as a finding"
fi

fail "Sunrise $TAG is NOT an ancestor of $REF.

The tree claims Sunrise $VERSION, but $TAG is missing from this branch's
ancestry. That is the signature of a sync PR merged with \"Squash and merge\":
the content is kept, the second parent is discarded.

Consequence: the merge base against upstream silently reverts to the PREVIOUS
release, so the next 'git merge vNEXT' replays the whole range again and
re-conflicts every file already resolved by hand.

Repair (changes no files). The refspec is explicit on purpose: plain
'git fetch upstream --tags' is REJECTED when you already hold a tag of that
name ('would clobber existing tag'), leaving $TAG pointing at your own
release — so the merge below would record a claim that is false.

  git fetch upstream --force \"refs/tags/$TAG:refs/sunrise-upstream/$TAG\"
  git checkout main
  git merge -s ours refs/sunrise-upstream/$TAG -m \"chore: record Sunrise $VERSION as merged (ancestry repair)\"
  git update-ref -d refs/sunrise-upstream/$TAG
  git push origin main

'-s ours' is only safe once you have confirmed the content is already present:
  git diff --stat <tip-of-the-squashed-PR-branch> main   # must be empty"
