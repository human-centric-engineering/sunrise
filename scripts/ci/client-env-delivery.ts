/**
 * Every `NEXT_PUBLIC_*` variable the code reads must have a build-time delivery
 * path, because nothing can supply one afterwards.
 *
 * ## The defect this exists to prevent (#662)
 *
 * `NEXT_PUBLIC_*` is inlined by the compiler during `next build`. Setting it in
 * the runtime environment of a built image does nothing. `.dockerignore`
 * excludes `.env` and `.env.*`, so for a container build a `build-arg` is the
 * only channel there is.
 *
 * The Dockerfile forwarded four, under the comment *"required for Next.js build
 * and environment validation"* — and that comment states the rule that produced
 * the bug. **Forward what fails the build** is correct for every variable except
 * the one class whose absence fails SILENTLY. Client vars are all optional, so
 * they never tripped it: exactly one of twelve was forwarded, and only because
 * it happened to also be required for validation. Analytics and error reporting
 * were off on every self-hosted deploy regardless of configuration, with no
 * error, no warning above `debug`, and nothing visible in CI.
 *
 * ## Why a scan, and why it is sound
 *
 * A longer hand-maintained ARG list would go stale the same way the first one
 * did. This keys on **"is it `NEXT_PUBLIC_`"** rather than "is it required".
 *
 * The scan is co-extensive with what Next itself inlines, which is the unusual
 * part. Next's replacement is textual and needs the static member-expression
 * form `process.env.NEXT_PUBLIC_X`; bracket access is not inlined. So anything
 * this regex misses, the compiler also misses — and therefore was never
 * delivered to the client in the first place. Deriving the roster is sound here
 * rather than advisory, which is not usually true of a scan.
 *
 * Server-side secrets are deliberately out of scope and must NOT be added.
 * `RESEND_API_KEY` is read per call, AI provider keys resolve through
 * `process.env[apiKeyEnvVar]` (dynamic, uninlinable by construction), and
 * `docker-compose.prod.yml` supplies them at runtime via `env_file`. Baking a
 * secret into an image layer would be worse than the status quo.
 *
 * @see .context/deployment/platforms/docker-self-hosted.md
 */

/**
 * Remove comments so a documentation mention is not read as a real usage.
 *
 * `lib/errors/sentry.ts` carries three `@example` lines naming
 * `process.env.NEXT_PUBLIC_SENTRY_DSN`, and `lib/env.ts` one for
 * `NEXT_PUBLIC_APP_URL`. Today both are also read for real, so nothing is
 * mis-reported — but a fork that deletes the last real read and keeps the
 * docblock would be told to add a build arg for a variable nothing consumes,
 * with no way to silence it.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

/** A client variable and the delivery channels that do not carry it. */
export interface DeliveryGap {
  variable: string;
  missing: string[];
}

/** Where a variable has to appear, and how to recognise it there. */
export interface DeliveryTargets {
  /** `Dockerfile` contents, or `null` when the fork does not ship one. */
  dockerfile: string | null;
  /** `docker-compose.prod.yml` contents, or `null` when absent. */
  compose: string | null;
}

/**
 * Client variables referenced anywhere in `sources`.
 *
 * Matches the static member-expression form only — see the note above on why
 * that is exactly the set the compiler inlines.
 */
export function scanClientEnvVars(sources: string[]): string[] {
  const found = new Set<string>();
  for (const src of sources) {
    for (const m of stripComments(src).matchAll(/process\.env\.(NEXT_PUBLIC_[A-Z0-9_]+)/g)) {
      found.add(m[1]);
    }
  }
  return [...found].sort();
}

/**
 * Bracket-access reads, which Next does NOT inline.
 *
 * Reported separately rather than folded into the roster: forwarding a build arg
 * would not help, because the value is never substituted. The fix is to rewrite
 * the read, so it needs a different message.
 */
export function scanUninlinableReads(sources: string[]): string[] {
  const found = new Set<string>();
  for (const src of sources) {
    const matches = stripComments(src).matchAll(
      /process\.env\[\s*['"`](NEXT_PUBLIC_[A-Z0-9_]+)['"`]\s*\]/g
    );
    for (const m of matches) found.add(m[1]);
  }
  return [...found].sort();
}

/**
 * Which of `variables` lack a delivery path.
 *
 * A `null` target is SKIPPED, not failed: a fork that deploys only to a
 * dashboard-style platform may legitimately not ship a Dockerfile, and failing
 * it for the absence of a file it deleted on purpose would be one more core
 * check a fork cannot satisfy — the class this repo has spent a release
 * removing.
 */
export function findDeliveryGaps(variables: string[], targets: DeliveryTargets): DeliveryGap[] {
  const gaps: DeliveryGap[] = [];

  for (const variable of variables) {
    const missing: string[] = [];

    if (targets.dockerfile !== null) {
      // Both are needed and they do different jobs: ARG accepts the value,
      // ENV puts it in the environment `next build` actually reads. An ARG
      // without a matching ENV is the shape that looks wired and is not.
      if (!new RegExp(`^ARG\\s+${variable}\\s*$`, 'm').test(targets.dockerfile)) {
        missing.push('Dockerfile ARG');
      }
      // `$VAR` and `${VAR}` are both valid, and a trailing comment is legal.
      // The first version demanded `ENV VAR=$VAR` to end of line, which reported
      // a correctly-wired fork's Dockerfile as broken.
      const envForms = new RegExp(
        `^ENV\\s+${variable}=\\$(?:${variable}|\\{${variable}\\})(?:\\s|$)`,
        'm'
      );
      if (!envForms.test(targets.dockerfile)) {
        missing.push('Dockerfile ENV');
      }
    }

    if (targets.compose !== null) {
      // The closing brace is required. Without it, `- FOO=${FOO_BAR}` satisfies
      // the check for FOO while delivering FOO_BAR's value — the same
      // "looks wired and is not" shape the ARG/ENV split above exists to catch.
      if (!new RegExp(`-\\s*${variable}=\\$\\{${variable}\\}`, 'm').test(targets.compose)) {
        missing.push('docker-compose.prod.yml build arg');
      }
    }

    if (missing.length > 0) gaps.push({ variable, missing });
  }

  return gaps;
}
