/**
 * MCP Resource Registry
 *
 * Maps registered resource URIs to internal handler functions. No
 * user-supplied URI ever reaches fetch() — all handlers call internal
 * functions only.
 *
 * Sunrise's own resources use the `sunrise://` scheme; a fork registers its
 * own scheme and types through `registerMcpResourceHandler`, wired from
 * `lib/app/mcp-resources.ts` (#563).
 *
 * Platform-agnostic: no Next.js imports.
 */

import { prisma } from '@/lib/db/client';
import { logger } from '@/lib/logging';
import { createAppInitGate, restoreMap } from '@/lib/fork-init';
import { McpResourceType } from '@/types/mcp';
import type { McpResourceDefinition, McpResourceContent, McpResourceTemplate } from '@/types/mcp';
import { handleKnowledgeSearch } from '@/lib/orchestration/mcp/resources/knowledge-search';
import { handlePatternDetail } from '@/lib/orchestration/mcp/resources/pattern-detail';
import { handleAgentList } from '@/lib/orchestration/mcp/resources/agent-list';
import { handleWorkflowList } from '@/lib/orchestration/mcp/resources/workflow-list';
import { initAppMcpResources } from '@/lib/app/mcp-resources';

/** Auth-derived context passed from the protocol handler through to resource handlers. */
export interface ResourceCallContext {
  /** Bound agent for this API key, or null for unscoped service keys. */
  scopedAgentId: string | null;
  /** ID of the calling key — useful for audit-side logging inside handlers. */
  apiKeyId: string;
}

/** Resource handler function signature */
type ResourceHandler = (
  uri: string,
  config: Record<string, unknown> | null,
  callContext: ResourceCallContext
) => Promise<McpResourceContent>;

/** Safely narrow a Prisma JsonValue to a record or null */
function toRecordOrNull(value: unknown): Record<string, unknown> | null {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return null;
}

/**
 * Built-in handler map keyed by resourceType.
 *
 * Keyed by `McpResourceType` rather than `string` so the constant in
 * `types/mcp.ts` and this map cannot drift: adding a value there without a
 * handler here fails type-check, which is the failure the old validation enum
 * could not see.
 */
const BUILT_IN_HANDLERS: Record<McpResourceType, ResourceHandler> = {
  [McpResourceType.KNOWLEDGE_SEARCH]: handleKnowledgeSearch,
  [McpResourceType.PATTERN_DETAIL]: handlePatternDetail,
  [McpResourceType.AGENT_LIST]: handleAgentList,
  [McpResourceType.WORKFLOW_LIST]: handleWorkflowList,
};

/** The scheme Sunrise's own resource URIs use, without the `://`. */
const CORE_URI_SCHEME = 'sunrise';

/**
 * Schemes a resource URI may never use. The URI is echoed to MCP clients in
 * `resources/list`, and a client that treats a resource URI as a fetchable
 * address should never be handed one that looks like the open web. Handlers
 * themselves never fetch, so this is defence in depth rather than the only line.
 */
const FORBIDDEN_URI_SCHEMES = new Set([
  'http',
  'https',
  'file',
  'data',
  'blob',
  'javascript',
  'vbscript',
  'ftp',
  'ws',
  'wss',
]);

/** Shape of a `resourceType`, mirroring `createExposedResourceSchema`. */
const RESOURCE_TYPE_NAME = /^[a-z][a-z0-9_]{0,63}$/;

/** Shape of a URI scheme, without the `://`. */
const URI_SCHEME_NAME = /^[a-z][a-z0-9+.-]{0,31}$/;

/** A fork's registration of one resource type. */
export interface AppMcpResourceRegistration {
  /**
   * Value stored in `McpExposedResource.resourceType`. Snake case, and it must
   * not collide with a built-in type.
   */
  resourceType: string;
  /**
   * URI scheme this type's resources use, written WITHOUT `://` — `hub` for
   * `hub://projects/{id}/plan`. Pass `'sunrise'` to extend the platform's own
   * scheme rather than introducing one.
   *
   * Required rather than defaulted: a fork resource that silently inherited
   * `sunrise://` would advertise the starter's identity to every MCP client
   * that lists it, which is the leak class #519 was about.
   */
  uriScheme: string;
  handler: ResourceHandler;
}

/** App-registered handlers, keyed by resourceType. */
const appHandlers = new Map<string, ResourceHandler>();
/**
 * The scheme each app resourceType is registered under, lowercased.
 *
 * Keyed by type rather than a flat set so the create route can check that a
 * row's URI scheme is the one registered FOR THAT TYPE. Independent checks
 * would let a fork file `sunrise://projects/x/plan` under its own
 * `project_plan` handler — the exact inheritance `uriScheme` exists to prevent.
 */
const appUriSchemes = new Map<string, string>();

/**
 * Register an app-owned MCP resource handler. Call at module-import time from
 * `lib/app/mcp-resources.ts`.
 *
 * Idempotent by `resourceType` — re-registering the same type replaces the
 * prior handler (safe under HMR / repeated module imports), mirroring
 * `registerAppJob` and `registerGrader`.
 *
 * **A built-in type cannot be overridden.** Sunrise seeds rows for its own
 * types, and `resourceType` is the only thing tying a seeded row to its
 * handler — so an app registration shadowing `agent_list` would silently
 * change what `sunrise://agents` returns to an external MCP client. That is a
 * data-exposure shape rather than a customisation, so it is refused and
 * logged. A fork that genuinely wants to replace a built-in edits the map
 * above and carries a visible divergence.
 */
export function registerMcpResourceHandler(registration: AppMcpResourceRegistration): void {
  const { resourceType, uriScheme, handler } = registration;

  if (isBuiltInResourceType(resourceType)) {
    logger.error('mcp-resources: refusing to override a built-in resource type', { resourceType });
    return;
  }

  // The same shape `createExposedResourceSchema` enforces. Checked here too
  // because otherwise a registration of `projectPlan` succeeds, reports
  // dispatchable, and then every attempt to create the row 400s at Zod with a
  // message that never mentions the registration.
  if (!RESOURCE_TYPE_NAME.test(resourceType)) {
    logger.error('mcp-resources: refusing to register a malformed resourceType', {
      resourceType,
      expected: 'lower snake_case, max 64 chars',
    });
    return;
  }

  const scheme = uriScheme.toLowerCase();
  if (!URI_SCHEME_NAME.test(scheme) || FORBIDDEN_URI_SCHEMES.has(scheme)) {
    logger.error('mcp-resources: refusing to register an unusable URI scheme', {
      resourceType,
      uriScheme,
    });
    return;
  }

  appHandlers.set(resourceType, handler);
  appUriSchemes.set(resourceType, scheme);
}

/**
 * Run the fork's auto-wired init exactly once, lazily, before the first read,
 * rolling a partial init back — see `lib/fork-init.ts` for the shared contract.
 * An init failure degrades to "no app resources" rather than failing an MCP
 * call.
 */
const appInit = createAppInitGate({
  label: 'mcp-resources: initAppMcpResources',
  // This registry has the most to lose from a partial apply: a half-registered
  // handler still dispatches, and its scheme is still accepted at create — so a
  // fork could expose a resource it never finished configuring, while the log
  // claims none were registered.
  subject: 'app MCP resources',
  init: initAppMcpResources,
  snapshot: () => ({ handlers: new Map(appHandlers), schemes: new Map(appUriSchemes) }),
  restore: (before) => {
    restoreMap(appHandlers, before.handlers);
    restoreMap(appUriSchemes, before.schemes);
  },
});

/**
 * Narrow a DB-sourced `resourceType` string to a built-in type.
 *
 * `Object.hasOwn` rather than a bare lookup: `resourceType` comes off a row, and
 * indexing an object literal with `'constructor'` would otherwise resolve to
 * something inherited rather than to a handler.
 */
function isBuiltInResourceType(resourceType: string): resourceType is McpResourceType {
  return Object.hasOwn(BUILT_IN_HANDLERS, resourceType);
}

/**
 * Resolve a handler for `resourceType`: built-ins first, then app registrations.
 *
 * The app init runs even when a built-in answers. It is one-shot and cheap, and
 * running it unconditionally is what makes the "cannot shadow a built-in"
 * refusal deterministic — otherwise an install whose only reads are of core
 * types would never load the fork's registrations and so never log the refusal.
 */
function resolveHandler(resourceType: string): ResourceHandler | undefined {
  appInit.ensure();
  if (isBuiltInResourceType(resourceType)) return BUILT_IN_HANDLERS[resourceType];
  return appHandlers.get(resourceType);
}

/**
 * Whether `resourceType` has a handler that could actually serve a read.
 *
 * The admin create route calls this instead of validating against a closed
 * enum, so a fork type dispatches — and a type with no handler is rejected at
 * creation rather than becoming a row that logs "no handler for type" the
 * first time a client reads it.
 */
export function isDispatchableMcpResourceType(resourceType: string): boolean {
  return resolveHandler(resourceType) !== undefined;
}

/**
 * Whether a resource URI uses an allowed scheme — `sunrise://`, or one a fork
 * contributed via `registerMcpResourceHandler`.
 *
 * **Case-sensitive, deliberately.** An earlier version matched the scheme with
 * `/i` and lowercased it, which accepted `SUNRISE://agents` — a row that stores
 * verbatim and then never dispatches, because `readMcpResource` looks the URI up
 * by exact match. That is precisely the "row that could never serve a read"
 * this check exists to reject (#540), so accepting it here would have made the
 * check's own promise false. `registerMcpResourceHandler` still lowercases the
 * scheme a fork *registers*: forgiving about config, exact about stored data.
 */
export function isAllowedMcpResourceUri(uri: string): boolean {
  const scheme = uriScheme(uri);
  if (scheme === null) return false;
  if (scheme === CORE_URI_SCHEME) return true;
  appInit.ensure();
  return [...appUriSchemes.values()].includes(scheme);
}

/** The scheme of `uri` (no `://`), or null when it is not a well-formed URI. */
function uriScheme(uri: string): string | null {
  const match = /^([a-z][a-z0-9+.-]*):\/\//.exec(uri);
  return match ? match[1] : null;
}

/**
 * The URI scheme a resource of `resourceType` must use — `sunrise` for a
 * built-in, whatever the fork registered for an app type, `undefined` if the
 * type has no handler.
 */
export function mcpResourceUriSchemeFor(resourceType: string): string | undefined {
  appInit.ensure();
  if (isBuiltInResourceType(resourceType)) return CORE_URI_SCHEME;
  return appUriSchemes.get(resourceType);
}

/**
 * Whether `uri`'s scheme is the one registered for `resourceType`.
 *
 * Checking the two independently is not enough: with `project_plan` registered
 * under `hub`, `{ uri: 'sunrise://projects/x/plan', resourceType: 'project_plan' }`
 * passes both and then serves fork data under the platform's own scheme to
 * every MCP client that lists it. That inheritance is the thing `uriScheme` is
 * required for, so it has to be enforced as a PAIR.
 */
export function isUriSchemeValidForResourceType(uri: string, resourceType: string): boolean {
  const expected = mcpResourceUriSchemeFor(resourceType);
  return expected !== undefined && uriScheme(uri) === expected;
}

/**
 * Resource types a fork has registered. Core's own types are the values of
 * `McpResourceType`; this is the other half, for error messages, an admin
 * picker, and the seam's own default-empty guard.
 */
export function listAppMcpResourceTypes(): string[] {
  appInit.ensure();
  return [...appHandlers.keys()];
}

/** Every URI scheme a resource may currently use — for error messages and docs. */
export function listAllowedMcpResourceUriSchemes(): string[] {
  appInit.ensure();
  return [...new Set([CORE_URI_SCHEME, ...appUriSchemes.values()])];
}

/**
 * Test-only: drop app registrations and re-arm the one-shot init so each test
 * starts from a known state. Built-ins are untouched.
 */
export function __resetAppMcpResourcesForTests(): void {
  appHandlers.clear();
  appUriSchemes.clear();
  appInit.reset();
}

const CACHE_TTL_MS = 5 * 60 * 1000;
let cachedResources: McpResourceDefinition[] | null = null;
let cachedAt = 0;

/**
 * List all MCP-exposed resources that are enabled.
 */
export async function listMcpResources(): Promise<McpResourceDefinition[]> {
  const now = Date.now();
  if (cachedResources && now - cachedAt < CACHE_TTL_MS) {
    return cachedResources;
  }

  const rows = await prisma.mcpExposedResource.findMany({
    where: { isEnabled: true },
  });

  cachedResources = rows.map((r) => ({
    uri: r.uri,
    name: r.name,
    description: r.description,
    mimeType: r.mimeType,
  }));

  cachedAt = Date.now();
  return cachedResources;
}

/**
 * Read a specific MCP resource by URI.
 *
 * Pattern-matches against registered resources. Returns null if the
 * URI doesn't match any enabled resource or if no handler exists.
 */
export async function readMcpResource(
  uri: string,
  callContext: ResourceCallContext
): Promise<McpResourceContent | null> {
  const row = await prisma.mcpExposedResource.findUnique({
    where: { uri },
  });

  if (!row || !row.isEnabled) {
    // Try pattern matching for parameterized URIs
    return readMcpResourceByPattern(uri, callContext);
  }

  const handler = resolveHandler(row.resourceType);
  if (!handler) {
    logger.warn('MCP resource: no handler for type', {
      resourceType: row.resourceType,
      uri,
    });
    return null;
  }

  try {
    const config = toRecordOrNull(row.handlerConfig);
    return await handler(uri, config, callContext);
  } catch (err) {
    logger.error('MCP resource handler failed', {
      uri,
      resourceType: row.resourceType,
      error: err instanceof Error ? err.message : String(err),
    });
    return {
      uri,
      mimeType: row.mimeType ?? 'text/plain',
      text: 'Resource handler error',
    };
  }
}

/** Escape a literal so it can be spliced into a RegExp source. */
function escapeRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Does `uri` fill in the `{param}` placeholders of a registered `template`?
 *
 * The prefix test below (strip the placeholders, then `startsWith`) only ever
 * worked when the placeholder was the LAST path segment:
 * `hub://projects/{id}/plan` collapses to `hub://projects//plan`, which
 * `hub://projects/p1/plan` does not start with. Every core template happens to
 * be trailing, so nothing noticed — but a mid-path template is the shape #563
 * asked for by name, and it returned null.
 *
 * Kept ALONGSIDE the prefix test rather than replacing it: the prefix test also
 * matches URIs a strict template never would (extra trailing segments, a value
 * containing `/`), and core resources have been reachable that way since they
 * shipped.
 */
function matchesUriTemplate(uri: string, template: string): boolean {
  if (!/\{[^}]+\}/.test(template)) return false;
  // A RUN of adjacent placeholders splits as one. `{a}{b}` would otherwise
  // compile to `[^/]+[^/]+` — two unbounded quantifiers with nothing between
  // them, which backtracks polynomially against a long non-matching URI. An
  // admin writing that template is careless rather than hostile, but the URI
  // side comes from an MCP client, so the hang would be theirs to trigger.
  const source = template
    .split(/(?:\{[^}]+\})+/)
    .map(escapeRegExp)
    .join('[^/]+');
  return new RegExp(`^${source}$`).test(uri);
}

/**
 * Pattern-match parameterized URIs against registered resources.
 * For example, `sunrise://knowledge/patterns/5` matches a resource
 * with resourceType `pattern_detail`.
 */
async function readMcpResourceByPattern(
  uri: string,
  callContext: ResourceCallContext
): Promise<McpResourceContent | null> {
  const rows = await prisma.mcpExposedResource.findMany({
    where: { isEnabled: true },
  });

  for (const row of rows) {
    // Check if the requested URI is a parameterized version of a registered URI
    const prefixMatch = uri.startsWith(row.uri.replace(/\{[^}]+\}/g, '').replace(/\?.*$/, ''));
    if (prefixMatch || matchesUriTemplate(uri, row.uri)) {
      const handler = resolveHandler(row.resourceType);
      if (handler) {
        try {
          const config = toRecordOrNull(row.handlerConfig);
          return await handler(uri, config, callContext);
        } catch (err) {
          logger.error('MCP resource handler failed (pattern match)', {
            uri,
            resourceType: row.resourceType,
            error: err instanceof Error ? err.message : String(err),
          });
          return {
            uri,
            mimeType: row.mimeType ?? 'text/plain',
            text: 'Resource handler error',
          };
        }
      }
    }
  }

  return null;
}

/**
 * List resource templates — resources whose URIs contain {param} placeholders.
 * Per MCP spec `resources/templates`.
 */
export async function listMcpResourceTemplates(): Promise<McpResourceTemplate[]> {
  const rows = await prisma.mcpExposedResource.findMany({
    where: { isEnabled: true },
  });

  return rows
    .filter((r) => /\{[^}]+\}/.test(r.uri) || r.uri.includes('?'))
    .map((r) => ({
      uriTemplate: r.uri,
      name: r.name,
      description: r.description,
      mimeType: r.mimeType,
    }));
}

/** Clear resource cache (after admin mutations) */
export function clearMcpResourceCache(): void {
  cachedResources = null;
  cachedAt = 0;
}

/**
 * Check whether a concrete URI is registered (exactly or as the
 * concrete instance of a parameterised template).
 *
 * Used by `resources/subscribe` to reject ghost subscriptions — the spec
 * lets a client subscribe to any URI, but accepting subs for URIs that
 * have no handler is misleading (the client will never get an `updated`
 * notification). Reject early instead.
 *
 * Returns true when:
 *   - the URI matches an enabled resource exactly, OR
 *   - it is a concrete instance of an enabled parameterised template
 *     (e.g. `sunrise://knowledge/patterns/5` is a concrete instance of
 *     `sunrise://knowledge/patterns/{number}`).
 */
export async function isRegisteredMcpResourceUri(uri: string): Promise<boolean> {
  const all = await listMcpResources();
  for (const r of all) {
    if (r.uri === uri) return true;
    // Strip template params + query suffix from the registered URI to get
    // a prefix that concrete instances should start with.
    const prefix = r.uri.replace(/\{[^}]+\}.*$/, '').replace(/\?.*$/, '');
    if (prefix && prefix !== r.uri && uri.startsWith(prefix)) return true;
  }
  return false;
}
