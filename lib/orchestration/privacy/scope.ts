/**
 * The privacy scope: what the privacy stage knows about the call it is
 * looking at (§127).
 *
 * A chat turn or a workflow execution enters a scope, and every provider call
 * made inside it, by the turn itself or by a capability, a summariser or an
 * embedding it starts, reads that scope from the provider-manager Proxy. The
 * scope says who the call is for (org, agent, user), what the layer already
 * knows about the people in it (`knownValues`, for tier B), and collects what
 * the stage found across the calls (`tally`), which the turn writes to its
 * message metadata and the engine to each step's trace entry.
 *
 * **One store per process, on `globalThis`**, like the tenant, subject and
 * paid-call stores (`lib/tenancy/context.ts`, #1138). The capability
 * dispatcher runs the instrumentation graph's code, so with a module-level
 * store a model call a capability makes mid-turn (`call_agent`,
 * `search_knowledge_base`) would read an empty store, fall back to an
 * ephemeral scope and lose the turn's agent. The contents are still per call
 * stack.
 *
 * A call made with no scope at all gets an ephemeral one from the stage. Its
 * policy is the global one, raised by the org in tenant context; it is never
 * looser than a scoped call's, because nothing a scope carries loosens
 * anything: an agent's mode and an org's minimum only tighten (t-1010).
 *
 * @see .context/privacy/llm-privacy-layer.md — *How a call flows*
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { logger } from '@/lib/logging';
import type {
  EntityType,
  KnownValue,
  PrivacyMode,
  TokenSession,
} from '@/lib/privacy/adapters/types';
import { modeStrictness } from '@/lib/privacy/adapters/policy';
import type { PrivacySummary } from '@/types/orchestration';
import type { ScopePrivacySettings } from '@/lib/orchestration/privacy/scope-settings';

/** What the stage found across the calls made in one scope. Counts only, never values. */
export interface PrivacyTally {
  /** Chat calls the stage scanned. */
  calls: number;
  /** Detections in chat calls, by entity type. */
  counts: Record<EntityType, number>;
  /** Embedding calls the stage scanned. They are counted, never altered. */
  embeddingCalls: number;
  /** Detections in embedding inputs, by entity type. */
  embeddingCounts: Record<EntityType, number>;
  /** The strictest mode any scanned call ran under. */
  mode: PrivacyMode | null;
  /** A detector failed on at least one call and the call went ahead without it. */
  degraded: boolean;
  /** Ids of the adapters that failed, across the calls. */
  failedAdapters: Set<string>;
  /** Why the stage refused calls here, if it did: `PrivacyRefusalReason` values. */
  refusals: Set<string>;
  /**
   * Placeholder-shaped text in replies that no call's session issued (a model
   * inventing `[PERSON_9]`), left visible as written. `pseudonymise` only.
   */
  unresolved: number;
}

export interface PrivacyScopeInit {
  /** What the scope stands for. A detector sees it as `ctx.scopeId`. */
  scopeId: string;
  orgId?: string;
  agentId?: string;
  userId?: string;
  /** What the layer already knows belongs to the people in this call. */
  knownValues?: readonly KnownValue[];
  /**
   * Nothing reads this scope's counts: it exists to carry who the calls are
   * for (an agent's reply embedding, t-1010). The stage then treats it like a
   * call with no scope for the scan it would skip there: a call the scan
   * cannot change is not scanned for nothing, nor sent to an external
   * detector for nothing.
   */
  recordsNowhere?: boolean;
  /**
   * Loads more known values (the user's own name and email, say), once per
   * scope and only when a call is actually scanned, so mode `off` costs
   * nothing. A loader that fails leaves just `knownValues`: tier B then finds
   * less, and tiers A and C still run.
   */
  loadKnownValues?: () => Promise<readonly KnownValue[]>;
}

/**
 * A scope. The fields other than `tally` and `parent` can be filled in by
 * whoever entered it, once it knows them (a chat turn learns its conversation
 * after it has entered the scope); see {@link bindPrivacyScope}.
 */
export interface PrivacyScope {
  scopeId: string;
  orgId?: string;
  agentId?: string;
  userId?: string;
  knownValues: readonly KnownValue[];
  loadKnownValues?: () => Promise<readonly KnownValue[]>;
  /** See {@link PrivacyScopeInit.recordsNowhere}. */
  recordsNowhere?: boolean;
  /** The loader's result, once asked for. Shared with child scopes. */
  loaded?: Promise<readonly KnownValue[]>;
  /**
   * The token session every masked call in this scope uses (§127, t-992),
   * created on the first. In memory only, and gone with the scope: never
   * stored, never shared with a child scope. One session per scope keeps a
   * value's placeholder the same across a turn's tool loop even when a later
   * call detects a value an earlier one missed, so reasoning blocks replayed
   * from an earlier call still point at the right value.
   */
  tokenSession?: TokenSession;
  /**
   * The agent's and the org's privacy settings, read once for this scope by
   * `scopePrivacySettings()` (t-1010), for the org and agent named in `key`.
   * In memory only, gone with the scope, and not shared with a child: a child
   * may run a different agent.
   */
  scopeSettings?: { key: string; value: Promise<ScopePrivacySettings> };
  readonly tally: PrivacyTally;
  /** The scope this one sits inside. What is recorded here is recorded there too. */
  readonly parent?: PrivacyScope;
}

function emptyTally(): PrivacyTally {
  return {
    calls: 0,
    counts: {},
    embeddingCalls: 0,
    embeddingCounts: {},
    mode: null,
    degraded: false,
    failedAdapters: new Set(),
    refusals: new Set(),
    unresolved: 0,
  };
}

function frozenValues(values: readonly KnownValue[]): readonly KnownValue[] {
  return Object.freeze(values.map((v) => Object.freeze({ ...v })));
}

/** A new scope, with an empty tally. Known values are copied and frozen. */
export function createPrivacyScope(init: PrivacyScopeInit, parent?: PrivacyScope): PrivacyScope {
  return {
    scopeId: init.scopeId,
    ...(init.orgId !== undefined ? { orgId: init.orgId } : {}),
    ...(init.agentId !== undefined ? { agentId: init.agentId } : {}),
    ...(init.userId !== undefined ? { userId: init.userId } : {}),
    knownValues: frozenValues(init.knownValues ?? []),
    ...(init.loadKnownValues ? { loadKnownValues: init.loadKnownValues } : {}),
    ...(init.recordsNowhere ? { recordsNowhere: true } : {}),
    tally: emptyTally(),
    ...(parent ? { parent } : {}),
  };
}

/** Fill in what the code that entered `scope` has since learned. */
export function bindPrivacyScope(
  scope: PrivacyScope,
  fields: Partial<Pick<PrivacyScopeInit, 'scopeId' | 'orgId' | 'agentId' | 'userId'>>
): void {
  if (fields.scopeId !== undefined) scope.scopeId = fields.scopeId;
  if (fields.orgId !== undefined) scope.orgId = fields.orgId;
  if (fields.agentId !== undefined) scope.agentId = fields.agentId;
  if (fields.userId !== undefined) scope.userId = fields.userId;
}

/**
 * A scope inside `parent` with its own tally, for one part of the work (a
 * workflow step). It takes `parent`'s fields as they are now, and shares its
 * known-value loader. What it records is recorded in `parent` as well.
 */
export function childPrivacyScope(parent: PrivacyScope, scopeId: string): PrivacyScope {
  return createPrivacyScope(
    {
      scopeId,
      ...(parent.orgId !== undefined ? { orgId: parent.orgId } : {}),
      ...(parent.agentId !== undefined ? { agentId: parent.agentId } : {}),
      ...(parent.userId !== undefined ? { userId: parent.userId } : {}),
      knownValues: parent.knownValues,
    },
    parent
  );
}

/**
 * A scope for one named agent's run (t-1010): a workflow `agent_call` or
 * `chat_turn` step, or an orchestrator's delegation. Inside the current scope
 * when there is one, so what its calls find is recorded there too; its own
 * when there is not. Its own object rather than the current one bound to the
 * agent, because an orchestrator runs delegations to different agents at once
 * on one step's scope, and binding would let one agent's calls run under
 * another's settings.
 */
export function agentPrivacyScope(
  agentId: string,
  // `null`, not `undefined`, for "no parent": an explicit `undefined` takes
  // the default, the current scope.
  parent: PrivacyScope | null = currentPrivacyScope() ?? null
): PrivacyScope {
  const scope = parent
    ? childPrivacyScope(parent, `${parent.scopeId}:agent:${agentId}`)
    : createPrivacyScope({ scopeId: `agent:${agentId}` });
  bindPrivacyScope(scope, { agentId });
  return scope;
}

/**
 * Every known value for `scope`: its own, plus its loader's (or its
 * parent's), loaded once. Never rejects.
 */
export async function knownValuesOf(scope: PrivacyScope): Promise<readonly KnownValue[]> {
  let owner: PrivacyScope | undefined = scope;
  while (owner && !owner.loadKnownValues) owner = owner.parent;
  const loader = owner?.loadKnownValues;
  if (!owner || !loader) return scope.knownValues;
  // `.then(loader)` so a loader that throws synchronously is caught too.
  owner.loaded ??= Promise.resolve()
    .then(loader)
    .then(frozenValues, (err: unknown): readonly KnownValue[] => {
      // Tier B finds less without them; say so, with no value in the line.
      logger.warn('privacy-scope: known values could not be loaded', {
        scopeId: owner.scopeId,
        errorName: err instanceof Error ? err.name : typeof err,
      });
      return [];
    });
  const loaded = await owner.loaded;
  return loaded.length === 0 ? scope.knownValues : [...scope.knownValues, ...loaded];
}

const globalForPrivacyScope = globalThis as unknown as {
  sunrisePrivacyScope?: AsyncLocalStorage<PrivacyScope>;
};
const privacyScopeStore = (globalForPrivacyScope.sunrisePrivacyScope ??=
  new AsyncLocalStorage<PrivacyScope>());

/** The scope the current call stack runs in, if any. */
export function currentPrivacyScope(): PrivacyScope | undefined {
  return privacyScopeStore.getStore();
}

/**
 * Run `fn` outside any privacy scope, for fire-and-forget work a turn starts
 * but does not wait for (embedding its messages for search). Its calls would
 * otherwise land in the turn's tally at a time nobody controls, before or
 * after the turn writes its counts, so the same turn could record different
 * numbers. Only the privacy store is left; the tenant context and the
 * paid-call hold carry on.
 */
export function outsidePrivacyScope<T>(fn: () => T): T {
  return privacyScopeStore.exit(fn);
}

/** Run `fn` with `scope` as the privacy scope for everything it does. */
export function runInPrivacyScope<T>(scope: PrivacyScope, fn: () => T): T {
  return privacyScopeStore.run(scope, fn);
}

/**
 * Drive `inner` with `scope` as the privacy scope: each `next()` runs inside
 * the store, so whatever the generator starts between yields carries it. The
 * shape of `withPaidCallHold` (`lib/orchestration/llm/spend-caps.ts`).
 */
export async function* withPrivacyScope<T, R>(
  scope: PrivacyScope,
  inner: AsyncGenerator<T, R, unknown>
): AsyncGenerator<T, R, unknown> {
  try {
    while (true) {
      const result = await privacyScopeStore.run(scope, () => inner.next());
      if (result.done) return result.value;
      yield result.value;
    }
  } finally {
    // As `yield*` would: let the inner's own finally run when the consumer
    // stops early. A no-op on a generator that has already finished.
    await privacyScopeStore.run(scope, () => inner.return(undefined as R));
  }
}

/** What one scanned call adds to a tally. */
export interface PrivacyCallRecord {
  kind: 'chat' | 'embedding';
  mode: PrivacyMode;
  counts: Readonly<Record<EntityType, number>>;
  degraded: boolean;
  failedAdapters: readonly string[];
}

function addTo(tally: PrivacyTally, record: PrivacyCallRecord): void {
  const target = record.kind === 'chat' ? tally.counts : tally.embeddingCounts;
  if (record.kind === 'chat') tally.calls++;
  else tally.embeddingCalls++;
  for (const [type, n] of Object.entries(record.counts)) target[type] = (target[type] ?? 0) + n;
  raiseMode(tally, record.mode);
  if (record.degraded) tally.degraded = true;
  for (const id of record.failedAdapters) tally.failedAdapters.add(id);
}

/** Add one call's result to `scope` and every scope it sits inside. */
export function recordPrivacyCall(scope: PrivacyScope, record: PrivacyCallRecord): void {
  for (let s: PrivacyScope | undefined = scope; s; s = s.parent) addTo(s.tally, record);
}

function raiseMode(tally: PrivacyTally, mode: PrivacyMode): void {
  if (tally.mode === null || modeStrictness(mode) > modeStrictness(tally.mode)) {
    tally.mode = mode;
  }
}

/**
 * Record that the stage refused a call here, and why, in `scope` and every
 * scope it sits inside: the trace shows the admin the reason. The reason is a
 * `PrivacyRefusalReason`; never request text.
 */
export function recordPrivacyRefusal(scope: PrivacyScope, mode: PrivacyMode, reason: string): void {
  for (let s: PrivacyScope | undefined = scope; s; s = s.parent) {
    raiseMode(s.tally, mode);
    s.tally.refusals.add(reason);
  }
}

/** Record placeholders a reply wrote that no session issued, left visible. */
export function recordPrivacyUnresolved(scope: PrivacyScope, unresolved: number): void {
  if (unresolved <= 0) return;
  for (let s: PrivacyScope | undefined = scope; s; s = s.parent) s.tally.unresolved += unresolved;
}

/**
 * What a scope's tally looks like in message or execution metadata, or
 * `undefined` when the stage scanned no call in it (mode `off`, or only local
 * providers). Counts and adapter ids only.
 */
export function privacySummary(scope: PrivacyScope): PrivacySummary | undefined {
  const t = scope.tally;
  if (t.mode === null) return undefined;
  return {
    mode: t.mode,
    calls: t.calls,
    counts: { ...t.counts },
    embeddingCalls: t.embeddingCalls,
    embeddingCounts: { ...t.embeddingCounts },
    ...(t.degraded ? { degraded: true } : {}),
    ...(t.failedAdapters.size > 0 ? { failedAdapters: [...t.failedAdapters].sort() } : {}),
    ...(t.refusals.size > 0 ? { refused: [...t.refusals].sort() } : {}),
    ...(t.unresolved > 0 ? { unresolved: t.unresolved } : {}),
  };
}
