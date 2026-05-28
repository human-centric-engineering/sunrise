/**
 * The Sunrise platform version this checkout corresponds to.
 *
 * SOURCE OF TRUTH for the Sunrise version. Do NOT derive this from
 * `package.json.version` — forks edit that with their own app's version, and
 * Sunrise's version would silently follow the fork's. See `VERSIONING.md` for
 * the full rationale and the public-surface contract this version commits to.
 *
 * Bumped by Sunrise maintainers as part of cutting a release (one-line edit
 * + git tag + CHANGELOG entry — see CONTRIBUTING.md "Cutting a release").
 * Forks merge this file along with the rest of upstream; they do NOT edit it.
 *
 * PHASE-1 PLACEHOLDER: `'0.0.0'` indicates the versioning infrastructure has
 * landed but no Sunrise release has been tagged yet. Phase 2 (post-migration-
 * squash) flips this to `'0.0.1'`, dates the CHANGELOG entry, and tags
 * `v0.0.1`. See `.instructions/versioning-proposal.md` for the rollout plan.
 */
export const SUNRISE_VERSION = '0.0.0';
