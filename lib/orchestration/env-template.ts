/**
 * `${env:VAR_NAME}` template substitution for stringy orchestration
 * config fields whose values are themselves credentials (e.g. a Slack
 * incoming-webhook URL, an admin-set Authorization header).
 *
 * Resolution is **read-time** — the template literal stays in the DB
 * and is substituted on every outbound HTTP call against the running
 * process's `process.env`. This mirrors the `readSecret()` posture in
 * `lib/orchestration/http/auth.ts` (env-var **names** in DB, values
 * resolved on demand) and means rotation = change one env var, no
 * binding edit.
 *
 * Pattern: `${env:NAME}` where NAME matches `[A-Z][A-Z0-9_]*`. Multiple
 * occurrences in one string are supported and may be mixed freely with
 * literal text. Garbage like `${env:}`, `${env:lower}`, or
 * `${env:has space}` is left untouched (treated as literal) — the
 * pattern is intentionally strict so a typo can't accidentally match
 * and fail-close.
 *
 * Failure mode is fail-closed: an unset or empty env var raises
 * `EnvTemplateError` rather than silently producing an empty/literal
 * value. Callers map that to their domain error (`invalid_binding` for
 * the capability path, `missing_env_var` for the workflow step).
 *
 * Scope: by design only applied to a small number of named fields
 * (`call_external_api.forcedUrl` / `forcedHeaders`,
 * `external_call.url` / `headers`). A generic deep-walk would silently
 * rewrite every string the next contributor adds — substitution stays
 * explicit at each call site.
 *
 * **Whose env vars an org may name (§111 t-811).** The process
 * environment is the platform operator's: the session secret, the
 * database URL, every provider key. While only a platform admin could
 * author these configs, "env-var names in DB, admin-authored" was safe.
 * At `multi` an org OWNER/ADMIN authors them too, and naming
 * `${env:BETTER_AUTH_SECRET}` in a header sent to a host they can read
 * would hand them the operator's secret. So a config acting for a
 * customer org may name only the env vars the operator set aside for
 * that org: names starting {@link orgEnvVarPrefix} (`ORG_<ORG ID>_`).
 * The install org, a system scope, and every install at `single` name
 * anything, as before; a call stack with no context at `multi` names nothing. {@link envVarAvailableHere} is the
 * rule; this module and `readSecret` in `lib/orchestration/http/auth.ts`
 * apply it where the value is read, so it holds whichever write path
 * stored the config. Refused before the variable is looked up, so a
 * refusal says nothing about whether the operator's variable is set.
 */
import { z } from 'zod';
import { actsForPlatform, getTenantContext } from '@/lib/tenancy/context';

/**
 * The prefix of the env vars a customer org's configs may name: `ORG_`,
 * the org's id upper-cased, `_`. The id rather than the slug, because a
 * slug can be changed or reused and a secret must not follow it to
 * another org.
 */
export function orgEnvVarPrefix(orgId: string): string {
  return `ORG_${orgId.toUpperCase()}_`;
}

/**
 * May config acting for the org in context name this env var? Yes where the
 * call stack acts for the platform (`actsForPlatform`: `single`, the install
 * org, a system scope); for a customer org only a name under its
 * {@link orgEnvVarPrefix}; and none with no context at all at `multi`.
 */
export function envVarAvailableHere(name: string): boolean {
  if (actsForPlatform()) return true;
  // A customer org, or (at `multi`) no context at all — which is a bug, and
  // gets no env var rather than every one.
  const orgId = getTenantContext()?.orgId ?? null;
  return orgId !== null && name.startsWith(orgEnvVarPrefix(orgId));
}

/** The refusal's wording, shared with `readSecret` so both say the same thing. */
export function envVarNotAvailableMessage(name: string): string {
  const orgId = getTenantContext()?.orgId ?? null;
  return orgId === null
    ? `Env var "${name}" is not available: no organisation is in context.`
    : `Env var "${name}" is not available to this organisation. Its configs may name only env vars starting "${orgEnvVarPrefix(orgId)}".`;
}

export class EnvTemplateError extends Error {
  constructor(
    public readonly code: 'unresolved_env_var' | 'env_var_not_available',
    public readonly envVarName: string,
    message: string
  ) {
    super(message);
    this.name = 'EnvTemplateError';
  }
}

const ENV_TEMPLATE_PATTERN = /\$\{env:([A-Z][A-Z0-9_]*)\}/g;

/**
 * Cheap check — returns true if the string contains at least one
 * well-formed `${env:VAR}` reference. Use to skip the substitution
 * pass for plain literals.
 */
export function containsEnvTemplate(value: string): boolean {
  ENV_TEMPLATE_PATTERN.lastIndex = 0;
  return ENV_TEMPLATE_PATTERN.test(value);
}

/**
 * Returns every distinct env-var name referenced in the input, in
 * order of first appearance. Used by the binding-save warning to tell
 * the admin which env vars are not currently set.
 */
export function extractEnvTemplateNames(value: string): string[] {
  const seen = new Set<string>();
  const names: string[] = [];
  ENV_TEMPLATE_PATTERN.lastIndex = 0;
  for (const match of value.matchAll(ENV_TEMPLATE_PATTERN)) {
    const name = match[1];
    if (!seen.has(name)) {
      seen.add(name);
      names.push(name);
    }
  }
  return names;
}

/**
 * Substitutes every `${env:NAME}` occurrence in `value` with
 * `process.env.NAME`. Throws `EnvTemplateError` when any referenced
 * env var is unset or empty — never silently downgrades.
 */
export function resolveEnvTemplate(value: string): string {
  if (!containsEnvTemplate(value)) return value;
  ENV_TEMPLATE_PATTERN.lastIndex = 0;
  return value.replace(ENV_TEMPLATE_PATTERN, (_full, name: string) => {
    if (!envVarAvailableHere(name)) {
      throw new EnvTemplateError('env_var_not_available', name, envVarNotAvailableMessage(name));
    }
    const resolved = process.env[name];
    if (!resolved) {
      throw new EnvTemplateError(
        'unresolved_env_var',
        name,
        `Env var "${name}" referenced by \${env:${name}} is not set`
      );
    }
    return resolved;
  });
}

/**
 * Convenience wrapper — resolves every value in a header-shaped record.
 * Returns `undefined` when the input is `undefined`, otherwise a new
 * object with the same keys (header keys are not template-substituted;
 * they are admin-typed identifiers, not credentials).
 */
export function resolveEnvTemplatesInRecord(
  record: Record<string, string> | undefined
): Record<string, string> | undefined {
  if (!record) return undefined;
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(record)) {
    out[key] = resolveEnvTemplate(value);
  }
  return out;
}

/**
 * Scans the supplied values for `${env:VAR}` references and returns
 * the deduplicated names of any referenced env vars that are not
 * currently set in `process.env`. Used by the binding-save warning to
 * tell the admin which env vars they still need to deploy.
 *
 * Soft check — empty result does NOT prove the call will succeed
 * (env vars can be unset between save and call); non-empty result
 * means at least one referenced var is definitely missing right now.
 *
 * Mirrors the `apiKeyPresent` posture in
 * `lib/orchestration/llm/provider-manager.ts` — presence check only,
 * never returns the resolved value.
 */
export function findUnsetEnvVarReferences(
  ...values: ReadonlyArray<string | Record<string, string> | undefined | null>
): string[] {
  return classifyEnvVarReferences(...values).missing;
}

/** What a config's `${env:VAR}` references come to, for the org in context. */
export interface EnvVarReferenceClasses {
  /** Usable here but not set on the host. Presence check only. */
  missing: string[];
  /**
   * Not usable here at all (§111 t-811), never looked up — so the list says
   * nothing about the operator's env. Empty for the platform.
   */
  unavailable: string[];
  /** The prefix that would make an unavailable name usable; `null` for the platform. */
  prefix: string | null;
}

/**
 * Sort every distinct `${env:VAR}` name in `values` into what will not
 * resolve here and why, in one pass: unset on the host, or a name this org
 * may not use. A name the org may not use is never looked up.
 */
export function classifyEnvVarReferences(
  ...values: ReadonlyArray<string | Record<string, string> | undefined | null>
): EnvVarReferenceClasses {
  const names = new Set<string>();
  for (const value of values) {
    if (value == null) continue;
    for (const str of typeof value === 'string' ? [value] : Object.values(value)) {
      if (typeof str === 'string') for (const name of extractEnvTemplateNames(str)) names.add(name);
    }
  }
  const missing: string[] = [];
  const unavailable: string[] = [];
  for (const name of names) {
    if (!envVarAvailableHere(name)) unavailable.push(name);
    else if (!process.env[name]) missing.push(name);
  }
  const orgId = actsForPlatform() ? null : (getTenantContext()?.orgId ?? null);
  return { missing, unavailable, prefix: orgId === null ? null : orgEnvVarPrefix(orgId) };
}

/**
 * The capability-binding save warning (`meta.warnings`) for a `customConfig`,
 * or `null` when there is nothing to warn about. Scans the two fields that
 * take templates — `forcedUrl` and `forcedHeaders`; the route-layer config is
 * an open record, so a malformed shape warns about nothing rather than
 * failing the save.
 */
export function bindingEnvVarWarnings(customConfig: unknown): {
  missingEnvVars?: string[];
  unavailableEnvVars?: string[];
  envVarPrefix?: string;
} | null {
  const parsed = bindingScanSchema.safeParse(customConfig);
  if (!parsed.success) return null;
  const { missing, unavailable, prefix } = classifyEnvVarReferences(
    parsed.data.forcedUrl,
    parsed.data.forcedHeaders
  );
  if (missing.length === 0 && unavailable.length === 0) return null;
  return {
    ...(missing.length > 0 ? { missingEnvVars: missing } : {}),
    ...(unavailable.length > 0 ? { unavailableEnvVars: unavailable } : {}),
    ...(unavailable.length > 0 && prefix ? { envVarPrefix: prefix } : {}),
  };
}

const bindingScanSchema = z
  .object({
    forcedUrl: z.string().optional(),
    forcedHeaders: z.record(z.string(), z.string()).optional(),
  })
  .partial();
