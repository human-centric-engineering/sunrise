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
 * policy is the global one; it is never looser than a scoped call's, because
 * nothing a scope carries in this task loosens anything.
 *
 * @see .context/privacy/llm-privacy-layer.md — *How a call flows*
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import type { EntityType, KnownValue, PrivacyMode } from '@/lib/privacy/adapters/types';
import { modeStrictness } from '@/lib/privacy/adapters/policy';
import type { PrivacySummary } from '@/types/orchestration';

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
}

export interface PrivacyScopeInit {
  /** What the scope stands for. A detector sees it as `ctx.scopeId`. */
  scopeId: string;
  orgId?: string;
  agentId?: string;
  userId?: string;
  /** What the layer already knows belongs to the people in this call. */
  knownValues?: readonly KnownValue[];
}

export interface PrivacyScope {
  readonly scopeId: string;
  readonly orgId?: string;
  readonly agentId?: string;
  readonly userId?: string;
  readonly knownValues: readonly KnownValue[];
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
  };
}

/** A new scope, with an empty tally. Known values are copied and frozen. */
export function createPrivacyScope(init: PrivacyScopeInit, parent?: PrivacyScope): PrivacyScope {
  return {
    scopeId: init.scopeId,
    ...(init.orgId !== undefined ? { orgId: init.orgId } : {}),
    ...(init.agentId !== undefined ? { agentId: init.agentId } : {}),
    ...(init.userId !== undefined ? { userId: init.userId } : {}),
    knownValues: Object.freeze((init.knownValues ?? []).map((v) => Object.freeze({ ...v }))),
    tally: emptyTally(),
    ...(parent ? { parent } : {}),
  };
}

/**
 * A scope inside `parent` with its own tally, for one part of the work (a
 * workflow step). It inherits everything else; what it records is recorded in
 * `parent` as well.
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

const globalForPrivacyScope = globalThis as unknown as {
  sunrisePrivacyScope?: AsyncLocalStorage<PrivacyScope>;
};
const privacyScopeStore = (globalForPrivacyScope.sunrisePrivacyScope ??=
  new AsyncLocalStorage<PrivacyScope>());

/** The scope the current call stack runs in, if any. */
export function currentPrivacyScope(): PrivacyScope | undefined {
  return privacyScopeStore.getStore();
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
  if (tally.mode === null || modeStrictness(record.mode) > modeStrictness(tally.mode)) {
    tally.mode = record.mode;
  }
  if (record.degraded) tally.degraded = true;
  for (const id of record.failedAdapters) tally.failedAdapters.add(id);
}

/** Add one call's result to `scope` and every scope it sits inside. */
export function recordPrivacyCall(scope: PrivacyScope, record: PrivacyCallRecord): void {
  for (let s: PrivacyScope | undefined = scope; s; s = s.parent) addTo(s.tally, record);
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
  };
}
