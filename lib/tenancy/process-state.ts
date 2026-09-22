/**
 * Every module in `lib/` that holds process-global state, and what that state
 * is allowed to do across orgs (§108 t-712).
 *
 * **RLS cannot see a Node heap.** The policies §107 shipped confine what a
 * query returns; they say nothing about a `Map` a module built five minutes
 * ago and is about to serve to a different org. A cache keyed by something two
 * orgs share — an event type, a slug, a display name — is a cross-tenant read
 * that no policy, no test and no review of a SQL statement will ever catch.
 *
 * Until this manifest existed the only control was a grep an operator was
 * asked to run at every upstream sync, and a grep is not run. (That grep also
 * could not have worked: it looked for `new Map(`, and every cache in this
 * tree is written `new Map<string, X>()`.) This file is the roster;
 * `tests/unit/lib/tenancy/process-state.test.ts` is the scanner that proves it
 * complete, in both directions — a holder with no row fails, and a row whose
 * holder is gone fails, because a stale row is a lie that reads like a
 * decision.
 *
 * ## Adding process-global state
 *
 * Add a row. Choose the posture from the vocabulary below by asking one
 * question: **if two orgs used this install, could one org's entry be served
 * to the other?** If the answer is "no, because the key is unique across
 * orgs", say which key. If it is "yes, and that is fine", say why it is fine
 * and what would make it not fine. If it is "yes, and it is not fine", that is
 * a defect and the `why` names the task that fixes it.
 *
 * ## What is NOT process-global state
 *
 * A `const` lookup table — `new Set(['a', 'b'])` — is not state: it is written
 * once at module load from literals and never again. Class fields are not
 * either, except through the module-level instance that holds them, which is
 * what the row covers. Anything under `lib/app/**` or `lib/framework/**` is a
 * fork's own and is not scanned (`platform.reserved-tiers`); a fork holding
 * tenant-affecting state of its own wants a manifest like this one.
 *
 * @see .context/architecture/multi-tenancy.md — the sync checklist that used to carry the grep
 * @see .context/tenancy/context.md — the review-checklist entry that points here
 * @see .context/architecture/multi-tenancy-design.md — decision Q4, the shared-by-decision aggregates
 */

/**
 * What a holder is allowed to do across orgs. Closed on purpose: a free-text
 * posture is a sentence nobody can scan for, and the point of the vocabulary
 * is that `shared-by-decision` and `mixes-orgs` can be counted.
 */
export type TenancyPosture =
  /**
   * Holds nothing derived from a tenant row: code registrations and fork-seam
   * registries, one-shot init latches, process guards, stateless singletons
   * and shared handles. Nothing tenant-owned can enter, so nothing can cross.
   */
  | 'no-tenant-data'
  /**
   * Caches rows the classification calls system or global config
   * (`lib/tenancy/classification.ts`). Those rows have no `orgId` by
   * construction, so one process-wide copy is the whole truth. Reclassifying a
   * model as tenant-owned invalidates the row — that is the check.
   */
  | 'global-config'
  /**
   * Tenant data keyed by an id unique across orgs — a cuid primary key, a
   * credential id. Two orgs cannot collide on the key, so entries cannot be
   * served to the wrong org. Where the holder has a shared size cap, the `why`
   * names it: a cap is a noisy-neighbour question, not an isolation one.
   */
  | 'row-keyed'
  /** Tenant data partitioned by org id. */
  | 'org-keyed'
  /**
   * A tenant-affecting aggregate deliberately shared across every org, because
   * what it protects is shared: an upstream provider's API key, a third party's
   * host, this process. Decision Q4, 2026-08-27. The `why` carries the trigger
   * that should make someone revisit it.
   */
  | 'shared-by-decision'
  /**
   * An `AsyncLocalStorage`. The holder is module-global; its contents are
   * per-call-stack and are never shared between requests — which is the
   * property `runAsOrg` is built on.
   */
  | 'async-local'
  /**
   * Holds tenant data that is not partitioned by org and should be. A declared
   * defect: the `why` names the task that fixes it. Nothing should sit here
   * without one, and nothing should be added here to make the scanner quiet.
   */
  | 'mixes-orgs';

export interface ProcessStateDeclaration {
  /** Repo-relative path. */
  file: string;
  /**
   * The module-level identifiers this row covers. A file appears more than
   * once when its holders have different postures.
   */
  holders: readonly string[];
  posture: TenancyPosture;
  /** What the entries are keyed by. Required in spirit for every keyed posture. */
  keyedBy?: string;
  /** One sentence, written to be read by whoever hits this file at the next sync. */
  why: string;
}

/**
 * The roster. Ordered by posture — the tenant-touching ones first, because
 * they are the ones worth reading — and by path within a posture.
 */
export const PROCESS_STATE: readonly ProcessStateDeclaration[] = [
  // ───────────────────────────────────────────────────────────────────────
  // mixes-orgs — declared defects, each with the task that fixes it
  // ───────────────────────────────────────────────────────────────────────
  {
    file: 'lib/admin/logs.ts',
    holders: ['globalForLogs'],
    posture: 'mixes-orgs',
    keyedBy: 'nothing — a flat 1000-entry ring buffer',
    why: "At multi an org admin's Logs page shows every org's log lines, message, context and meta; t-714 gives the entry an org and filters the query, and carries the operator-versus-org-admin question underneath it.",
  },

  // ───────────────────────────────────────────────────────────────────────
  // org-keyed
  // ───────────────────────────────────────────────────────────────────────
  {
    file: 'lib/orchestration/hooks/registry.ts',
    holders: ['hookCacheByOrg'],
    posture: 'org-keyed',
    keyedBy: "org id, or 'system' for the system scope",
    why: "AiEventHook is tenant-owned and eventType is a label every org shares, so the one process-wide map this replaced dispatched whichever org refreshed it last to all of them — org B's event to org A's URL, signed with org A's secret (§108 t-712).",
  },
  {
    file: 'lib/orchestration/mcp/tool-registry.ts',
    holders: ['mcpSystemAgentIdByOrg'],
    posture: 'org-keyed',
    keyedBy: "org id, or 'system' for the system scope",
    why: "Agent slugs are unique per org (§107 t-708), so each org holds its own `mcp-system` agent and a single process-wide id would hand org B org A's agent — its disabled capabilities invisible under B's scope, its cost rows misattributed.",
  },

  // ───────────────────────────────────────────────────────────────────────
  // row-keyed — tenant data, keyed by an id no two orgs share
  // ───────────────────────────────────────────────────────────────────────
  {
    file: 'lib/orchestration/capabilities/dispatcher.ts',
    holders: ['globalForDispatcher'],
    posture: 'row-keyed',
    keyedBy: 'agent id for the binding maps; capability slug for the rest',
    why: 'The dispatcher instance holds capability handlers, guards and per-slug limiters, which are global config, plus per-agent capability bindings keyed by the agent cuid — the strictest of the two is what this row declares, and the bindings are what a fork adding a cache here must key the same way.',
  },
  {
    file: 'lib/orchestration/chat/context-builder.ts',
    holders: ['cache'],
    posture: 'row-keyed',
    keyedBy: 'context type + entity id + optional user id',
    why: "The entity id is a cuid, so two orgs cannot collide, but the 500-entry cap is shared: a busy org can evict a quiet one's entries, which costs a rebuild and never a wrong answer.",
  },
  {
    file: 'lib/orchestration/knowledge/resolveAgentDocumentAccess.ts',
    holders: ['cache'],
    posture: 'row-keyed',
    keyedBy: 'agent id',
    why: 'A resolved document-access set per agent cuid, invalidated on grant mutations; the 60-second TTL is the window in which a revoked grant still answers, and it is the same window at single and multi.',
  },
  {
    file: 'lib/orchestration/llm/budget-mutex.ts',
    holders: ['locks'],
    posture: 'row-keyed',
    keyedBy: 'agent id',
    why: 'A serialising lock per agent cuid, so two orgs never contend for the same lock and the TOCTOU window it closes is per agent, as the file header says.',
  },
  {
    file: 'lib/orchestration/mcp/log-emitter.ts',
    holders: ['sentTimestamps'],
    posture: 'row-keyed',
    keyedBy: 'MCP session id',
    why: 'A per-session sliding window for notification rate limiting; session ids are minted by the session manager and are unique across orgs.',
  },
  {
    file: 'lib/orchestration/mcp/progress-tracker.ts',
    holders: ['sentTimestamps'],
    posture: 'row-keyed',
    keyedBy: 'MCP session id',
    why: 'The same per-session sliding window as the log emitter, for progress notifications.',
  },
  {
    file: 'lib/orchestration/mcp/protocol-handler.ts',
    holders: ['keyRateLimitCache', 'keyRateLimitCacheAt'],
    posture: 'row-keyed',
    keyedBy: 'MCP API key id',
    why: "Key ids are unique across orgs so one map is correct, but filling it is not automatic — the refresh runs under runAsSystem because it inherited the refreshing org before §108 t-712 and silently dropped every other org's override for five minutes.",
  },
  {
    file: 'lib/orchestration/mcp/singletons.ts',
    holders: ['sessionManager', 'rateLimiter'],
    posture: 'row-keyed',
    keyedBy: 'MCP session id and API key id, inside the two managers',
    why: 'Lazy singletons whose contents are keyed by ids unique across orgs; sessions are per-process by design and refuse to start where more than one process serves traffic.',
  },

  // ───────────────────────────────────────────────────────────────────────
  // shared-by-decision — Q4, 2026-08-27
  // ───────────────────────────────────────────────────────────────────────
  {
    file: 'lib/orchestration/engine/outbound-rate-limiter.ts',
    holders: ['retryAfterDeadlines', 'hostLimiters'],
    posture: 'shared-by-decision',
    keyedBy: 'outbound hostname',
    why: "What the limit protects is the third-party host, which every org shares, so one org can spend another's budget against it — revisit if per-org outbound quotas land (§110).",
  },
  {
    file: 'lib/orchestration/llm/circuit-breaker.ts',
    holders: ['breakers'],
    posture: 'shared-by-decision',
    keyedBy: 'provider slug',
    why: 'A breaker guards the upstream credential, which is a process environment variable today, so the slug IS the credential identity — the key gains the credential when §109 makes credentials per org, and until then a breaker opened by one org pauses all of them.',
  },
  {
    file: 'lib/orchestration/llm/in-flight-counter.ts',
    holders: ['counts'],
    posture: 'shared-by-decision',
    keyedBy: 'provider slug',
    why: 'A saturation gauge for the process against one upstream provider, read by the live-engine dashboard as "this worker\'s load"; the same §109 trigger as the breaker applies.',
  },
  {
    file: 'lib/orchestration/maintenance/idle-gate.ts',
    holders: ['skipUntilMs'],
    posture: 'shared-by-decision',
    keyedBy: 'nothing — one horizon for the process',
    why: 'The tick sweeps every org in one pass (§108 t-711) and arms the gate only when no org found work and the earliest next run across all orgs is far enough away, so one skip decision covering every org is the correct shape rather than a compromise.',
  },
  {
    file: 'lib/security/rate-limit-stores/index.ts',
    holders: ['_store'],
    posture: 'shared-by-decision',
    keyedBy: 'the caller token the limiter was given — session user id, or client IP',
    why: "The counters behind every limiter, shared because a section cap protects this deployment's endpoint and the key is who is calling rather than which org they are in; an IP is shared by everyone behind it, orgs included.",
  },
  {
    file: 'lib/security/rate-limit.ts',
    holders: ['tierRegistry', 'RATE_LIMIT_TIERS'],
    posture: 'shared-by-decision',
    keyedBy: 'tier name, over the shared store above',
    why: "The built-in and fork-registered section tiers; the limiter instances are shared so that resetting a tier and resolving it observe one bucket, and the per-caller keying is the store's.",
  },

  // ───────────────────────────────────────────────────────────────────────
  // global-config — rows with no org by classification
  // ───────────────────────────────────────────────────────────────────────
  {
    file: 'lib/orchestration/llm/model-registry-db-hydrate.ts',
    holders: ['dbHydratedAt', 'inflight'],
    posture: 'global-config',
    why: 'Hydrates the model registry from AiProviderModel, a global-config model, and holds only the freshness stamp and the in-flight promise that de-duplicates concurrent hydrations.',
  },
  {
    file: 'lib/orchestration/llm/model-registry.ts',
    holders: ['state', 'inflightRefresh'],
    posture: 'global-config',
    why: 'The AiProviderModel catalogue with its fallback map, refreshed behind one in-flight promise; no row in it belongs to an org.',
  },
  {
    file: 'lib/orchestration/llm/provider-manager.ts',
    holders: ['instanceCache'],
    posture: 'global-config',
    keyedBy: 'provider slug or name',
    why: 'Constructed provider instances from AiProviderConfig, a global-config model whose slugs are unique install-wide, with the API key coming from the environment rather than from a row (§109 changes both halves of that).',
  },
  {
    file: 'lib/orchestration/llm/provider-selector.ts',
    holders: ['modelCache'],
    posture: 'global-config',
    why: 'A 30-second copy of the AiProviderModel rows the selector ranks.',
  },
  {
    file: 'lib/orchestration/llm/settings-resolver.ts',
    holders: ['settingsCache'],
    posture: 'global-config',
    why: "The AiOrchestrationSettings singleton's stored defaultModels map; the singleton cannot take an orgId at all.",
  },
  {
    file: 'lib/orchestration/mcp/config.ts',
    holders: ['cached', 'cachedAt'],
    posture: 'global-config',
    why: 'The McpServerConfig singleton, the other row that cannot take an orgId.',
  },
  {
    file: 'lib/orchestration/mcp/prompt-registry.ts',
    holders: ['cachedPrompts', 'cachedAt'],
    posture: 'global-config',
    why: 'McpExposedPrompt rows, which the classification calls global config: what this install exposes over MCP is one list.',
  },
  {
    file: 'lib/orchestration/mcp/resource-registry.ts',
    holders: ['cachedResources', 'cachedAt'],
    posture: 'global-config',
    why: 'McpExposedResource rows, the same global list as the prompts — the per-org part of an MCP call is the agent, which tool-registry keys by org.',
  },
  {
    file: 'lib/orchestration/mcp/tool-registry.ts',
    holders: ['cachedTools', 'cachedAt'],
    posture: 'global-config',
    why: 'McpExposedTool joined to AiCapability, both global config; the per-agent disable filter is deliberately a live query so it stays coherent with admin changes without a second cache.',
  },
  {
    file: 'lib/orchestration/settings.ts',
    holders: ['settingsCache'],
    posture: 'global-config',
    why: 'The AiOrchestrationSettings singleton as the rest of the platform reads it.',
  },

  // ───────────────────────────────────────────────────────────────────────
  // async-local — module-global holder, per-call-stack contents
  // ───────────────────────────────────────────────────────────────────────
  {
    file: 'lib/auth/signup-mode.ts',
    holders: ['invitedSignupContext'],
    posture: 'async-local',
    why: 'Carries "this sign-up came from an invitation" down one call stack, so a concurrent open sign-up cannot see it.',
  },
  {
    file: 'lib/db/tenancy-extension.ts',
    holders: ['txScope'],
    posture: 'async-local',
    why: 'Marks the call stack that is already inside a transaction so the data layer sets the org GUC once per transaction rather than per operation.',
  },
  {
    file: 'lib/tenancy/context.ts',
    holders: ['tenantContext'],
    posture: 'async-local',
    why: 'The tenant context itself: the store every other posture in this file is ultimately defined against.',
  },

  // ───────────────────────────────────────────────────────────────────────
  // no-tenant-data — code registrations, latches, guards, handles
  // ───────────────────────────────────────────────────────────────────────
  {
    file: 'lib/account-sections/registry.ts',
    holders: ['sections'],
    posture: 'no-tenant-data',
    why: 'Account-page sections a fork registers from code.',
  },
  {
    file: 'lib/admin-nav/registry.ts',
    holders: ['appSections'],
    posture: 'no-tenant-data',
    why: 'Admin nav sections a fork registers from code.',
  },
  {
    file: 'lib/analytics/client.ts',
    holders: ['analyticsClient', 'initPromise', 'initWarningLogged'],
    posture: 'no-tenant-data',
    why: 'The configured analytics provider, its one-shot init promise and a warn-once latch.',
  },
  {
    file: 'lib/auth/authorization.ts',
    holders: ['warnedOwnerlessKinds', 'appPolicy', 'registrationFailed'],
    posture: 'no-tenant-data',
    why: "A fork's registered policy, whether registering it failed, and the kinds already warned about once — the policy's per-request inputs are arguments, not state.",
  },
  {
    file: 'lib/auth/user-created-hooks.ts',
    holders: ['hooks'],
    posture: 'no-tenant-data',
    why: 'User-created callbacks a fork registers from code.',
  },
  {
    file: 'lib/db/client.ts',
    holders: ['globalForPrisma', 'adapter', 'pool'],
    posture: 'no-tenant-data',
    why: 'The Prisma client, its pg pool and adapter, held on globalThis so every module graph and every hot reload share one — the per-org part is the GUC the extension sets inside each transaction, which is call-stack state, not this.',
  },
  {
    file: 'lib/email/client.ts',
    holders: ['resendClient', 'startupWarningLogged'],
    posture: 'no-tenant-data',
    why: 'The mail transport handle and a warn-once latch.',
  },
  {
    file: 'lib/env.ts',
    holders: ['coreServerKeys', 'coreClientKeys'],
    posture: 'no-tenant-data',
    why: "The names of core's own env schema keys, derived once from the schemas so a fork's additions can be told apart.",
  },
  {
    file: 'lib/errors/handler.ts',
    holders: ['processedErrors'],
    posture: 'no-tenant-data',
    why: 'A bounded set of error signatures already handled, which exists to stop an error handler looping on itself.',
  },
  {
    file: 'lib/logging/index.ts',
    holders: ['logger'],
    posture: 'no-tenant-data',
    why: 'The logger instance itself; what it writes into the admin ring buffer is the `mixes-orgs` row above.',
  },
  {
    file: 'lib/logging/visitor-id.ts',
    holders: ['signingKeyPromise'],
    posture: 'no-tenant-data',
    why: 'The imported HMAC key for hashing visitor ids, derived once from an install-wide secret.',
  },
  {
    file: 'lib/orchestration/capabilities/registry.ts',
    holders: [
      'registered',
      'appCapabilities',
      'appRegistered',
      'appInitError',
      'warnedDivergentPairs',
    ],
    posture: 'no-tenant-data',
    why: "Built-in and fork-registered capability classes plus the one-shot init latches; a capability's tenant-owned data is read per call, inside the caller's scope.",
  },
  {
    file: 'lib/orchestration/chat/context-builder.ts',
    holders: ['globalForContributors', 'contributors'],
    posture: 'no-tenant-data',
    why: 'Context contributors a fork registers from code, on globalThis because instrumentation.ts and the request path are separate module graphs; what a contributor returns is cached in the row-keyed entry above.',
  },
  {
    file: 'lib/orchestration/chat/guard-events.ts',
    holders: ['contributors'],
    posture: 'no-tenant-data',
    why: 'Guard-event contributors a fork registers from code.',
  },
  {
    file: 'lib/orchestration/chat/guard-floor.ts',
    holders: ['contributors'],
    posture: 'no-tenant-data',
    why: 'Guard-floor contributors a fork registers from code.',
  },
  {
    file: 'lib/orchestration/engine/executor-registry.ts',
    holders: ['registry'],
    posture: 'no-tenant-data',
    why: 'Step executors by step type, all registered from code.',
  },
  {
    file: 'lib/orchestration/evaluations/graders/registry.ts',
    holders: ['registry'],
    posture: 'no-tenant-data',
    why: 'Grader implementations by name, all registered from code.',
  },
  {
    file: 'lib/orchestration/http/allowlist.ts',
    holders: ['cachedAllowedHosts', 'cachedAllowedHostsRaw'],
    posture: 'no-tenant-data',
    why: 'The parsed outbound host allowlist with the raw env string it was parsed from, so a changed variable re-parses.',
  },
  {
    file: 'lib/orchestration/inbound/bootstrap.ts',
    holders: ['bootstrapped'],
    posture: 'no-tenant-data',
    why: 'A one-shot latch for registering the inbound adapters.',
  },
  {
    file: 'lib/orchestration/inbound/registry.ts',
    holders: ['adapters'],
    posture: 'no-tenant-data',
    why: 'Inbound channel adapters by name, registered from code; the org an inbound call belongs to comes from the row it names, not from here.',
  },
  {
    file: 'lib/orchestration/knowledge/parsers/dom-text.ts',
    holders: ['sharedWindow'],
    posture: 'no-tenant-data',
    why: 'One jsdom window reused as a host for DOMParser; each parse gets an independent Document, so no document content survives a call.',
  },
  {
    file: 'lib/orchestration/knowledge/parsers/pdf-parser.ts',
    holders: ['pdfParseModulePromise'],
    posture: 'no-tenant-data',
    why: 'The lazily imported pdf-parse module, held so the dynamic import happens once.',
  },
  {
    file: 'lib/orchestration/knowledge/resolveAgentDocumentAccess.ts',
    holders: ['accessContributors'],
    posture: 'no-tenant-data',
    why: 'Access contributors a fork registers from code; what they return is cached in the row-keyed entry above.',
  },
  {
    file: 'lib/orchestration/llm/provider-eligibility.ts',
    holders: ['appResolver', 'wiring'],
    posture: 'no-tenant-data',
    why: "A fork's eligibility resolver and the promise that wires it once.",
  },
  {
    file: 'lib/orchestration/llm/tokeniser.ts',
    holders: ['heuristic', 'openAiModern', 'openAiLegacy', 'anthropic', 'gemini', 'llama'],
    posture: 'no-tenant-data',
    why: 'Stateless tokeniser strategies, one instance each because constructing them is the only cost.',
  },
  {
    file: 'lib/orchestration/maintenance/app-jobs.ts',
    holders: ['jobs'],
    posture: 'no-tenant-data',
    why: "A fork's registered maintenance jobs; each one declares the scope it RUNS in (§108 t-711), which is the tenancy decision — this map only holds the registrations.",
  },
  {
    file: 'lib/orchestration/maintenance/run-tick.ts',
    holders: ['tickRunning', 'currentTickToken'],
    posture: 'no-tenant-data',
    why: 'The overlap guard and its monotonic token, which are about this process running one sweep at a time rather than about whose rows the sweep touches.',
  },
  {
    file: 'lib/orchestration/mcp/resource-registry.ts',
    holders: ['appHandlers', 'appUriSchemes'],
    posture: 'no-tenant-data',
    why: 'Resource handlers and their URI schemes, registered from code by a fork.',
  },
  {
    file: 'lib/orchestration/outbound/bootstrap.ts',
    holders: ['bootstrapped'],
    posture: 'no-tenant-data',
    why: 'A one-shot latch for registering the outbound adapters.',
  },
  {
    file: 'lib/orchestration/outbound/registry.ts',
    holders: ['adapters'],
    posture: 'no-tenant-data',
    why: 'Outbound channel adapters by name, registered from code.',
  },
  {
    file: 'lib/orchestration/schemas/registry.ts',
    holders: ['REGISTRY'],
    posture: 'no-tenant-data',
    why: 'Zod schemas by name, registered from code.',
  },
  {
    file: 'lib/orchestration/tracing/noop-tracer.ts',
    holders: ['NOOP_SPAN', 'NOOP_TRACER'],
    posture: 'no-tenant-data',
    why: 'The do-nothing span and tracer, shared because they hold nothing at all.',
  },
  {
    file: 'lib/orchestration/tracing/registry.ts',
    holders: ['activeTracer'],
    posture: 'no-tenant-data',
    why: "The installed tracer, the no-op until a fork sets one; a span's attributes come from the call, not from here.",
  },
  {
    file: 'lib/privacy/erasure-hooks.ts',
    holders: ['hooks'],
    posture: 'no-tenant-data',
    why: 'Erasure cleanup callbacks a fork registers from code.',
  },
  {
    file: 'lib/privacy/subject-source-registry.ts',
    holders: ['sources', 'excluded', 'owners', 'appInitFailed'],
    posture: 'no-tenant-data',
    why: "A fork's subject-export dispositions, which say which MODELS a data subject's export reads; the rows themselves are read per request inside the caller's scope.",
  },
  {
    file: 'lib/security/rate-limit-policy.ts',
    holders: ['effectivePolicyCache', 'appKeyResolvers'],
    posture: 'no-tenant-data',
    why: "The resolved policy table — core's rules plus a fork's — and the key resolvers that go with them, all derived from code rather than from rows.",
  },
  {
    file: 'lib/security/rate-limit-stores/redis.ts',
    holders: ['requestCounter'],
    posture: 'no-tenant-data',
    why: 'A monotonic counter for correlating Redis calls in the logs.',
  },
  {
    file: 'lib/storage/client.ts',
    holders: ['storageClient', 'initWarningLogged'],
    posture: 'no-tenant-data',
    why: 'The configured storage provider handle and a warn-once latch.',
  },
  {
    file: 'lib/tenancy/classification.ts',
    holders: ['rosters'],
    posture: 'no-tenant-data',
    why: 'A WeakMap from a Prisma client object to the tenant-owned model roster derived from its runtime data model, so the derivation happens once per client.',
  },
  {
    file: 'lib/tenancy/resolver.ts',
    holders: ['resolver'],
    posture: 'no-tenant-data',
    why: "A fork's request-to-org resolver — the seam that DECIDES an org per request, holding no org itself.",
  },
];

/** Postures that mean the holder can carry tenant-derived values. */
export const TENANT_TOUCHING_POSTURES: readonly TenancyPosture[] = [
  'row-keyed',
  'org-keyed',
  'shared-by-decision',
  'mixes-orgs',
];
