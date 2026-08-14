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

# Read the claim from the TREE, not the working directory — the question is
# what this commit says it is, which is what a reader six months later will see.
# Tolerates either quote style: prettier enforces single, but a fork's editor
# may not, and a parse miss here would silently skip the check.
VERSION=$(git show "$REF:lib/sunrise-version.ts" 2>/dev/null |
  sed -n "s/.*SUNRISE_VERSION *= *['\"]\([^'\"]*\)['\"].*/\1/p" | head -1)

if [ -z "$VERSION" ]; then
  echo "notice: no SUNRISE_VERSION found at $REF — skipping"
  exit 0
fi
TAG="v$VERSION"

# Ancestry cannot be computed on a shallow clone: `merge-base --is-ancestor`
# would answer from truncated history and report a loss that has not happened.
# Skip loudly rather than fail — a fork that copies this workflow and lowers
# `fetch-depth` should get a fixable notice, not a red build it cannot explain.
if [ "$(git rev-parse --is-shallow-repository 2>/dev/null)" = "true" ]; then
  echo "notice: shallow clone — skipping (ancestry needs 'fetch-depth: 0')"
  exit 0
fi

# Resolve the tag into a PRIVATE ref rather than trusting `refs/tags/$TAG`.
#
# A fork tags its own app releases, and `lib/app-version.ts` is versioned
# independently of Sunrise — so a fork sitting at Sunrise 0.9.0 may well have
# its OWN `v0.9.0` tag pointing at its own history. Reusing `refs/tags/` would
# then compare against the wrong object, and because a fork's own tag is
# normally an ancestor of its own main, the check would PASS. A guard that
# silently reports success on the exact repository it exists to protect is
# worse than no guard, so upstream's tag is fetched into a namespace nothing
# else writes to.
readonly PRIVATE_REF="refs/sunrise-ancestry/$TAG"
git fetch --quiet --no-tags --force "$UPSTREAM_URL" "refs/tags/$TAG:$PRIVATE_REF" 2>/dev/null || true

RESOLVED="$PRIVATE_REF"
if ! git rev-parse -q --verify "$PRIVATE_REF" >/dev/null 2>&1; then
  # Upstream unreachable (private remote without a token, or offline). Fall back
  # to a local tag — correct and authoritative in Sunrise's OWN repo, where the
  # tag is created locally and no collision is possible.
  RESOLVED="refs/tags/$TAG"
fi

# Still unresolvable => mid-release (the commit bumping SUNRISE_VERSION lands
# BEFORE the tag is pushed) or an unreachable private upstream. Never fail on
# that: a hard failure here would red-line every Sunrise release at the moment
# of cutting it.
if ! git rev-parse -q --verify "$RESOLVED" >/dev/null 2>&1; then
  echo "notice: $TAG not resolvable — skipping (mid-release, or upstream unreachable)"
  exit 0
fi

if git merge-base --is-ancestor "$RESOLVED" "$REF"; then
  echo "ok: $TAG is an ancestor of $REF — sync history intact"
  exit 0
fi

cat <<EOF
::error::Sunrise $TAG is NOT an ancestor of $REF.

The tree claims Sunrise $VERSION, but $TAG is missing from this branch's
ancestry. That is the signature of a sync PR merged with "Squash and merge":
the content is kept, the second parent is discarded.

Consequence: the merge base against upstream silently reverts to the PREVIOUS
release, so the next 'git merge vNEXT' replays the whole range again and
re-conflicts every file already resolved by hand.

Repair (changes no files):
  git fetch upstream --tags
  git checkout main
  git merge -s ours $TAG -m "chore: record Sunrise $VERSION as merged (ancestry repair)"
  git push origin main

'-s ours' is only safe once you have confirmed the content is already present:
  git diff --stat <tip-of-the-squashed-PR-branch> main   # must be empty
EOF
exit 1
