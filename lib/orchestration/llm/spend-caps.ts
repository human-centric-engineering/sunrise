/**
 * Monthly spend caps: the org's and the global one (§110 t-788).
 *
 * Two caps are not about any one agent, so they hold for every AI call, not
 * only for chat:
 *
 * - an org's `Org.settings.quotas.monthlyBudgetUsd`, on the org's combined
 *   spend;
 * - `AiOrchestrationSettings.globalMonthlyBudgetUsd`, on every org's combined
 *   spend.
 *
 * {@link assertWithinSpendCaps} is the call-time gate. The provider manager's
 * Proxy runs it before every vendor call, beside the eligibility gate, so a
 * workflow step, the orchestrator, an evaluation, a judge, knowledge ingestion
 * and a scheduled or webhook run are all held to these caps, whichever site
 * picked the provider. `checkBudget()` reads the same state for chat, which
 * refuses a turn before it starts so the user gets a message rather than a
 * failed stream, and adds the agent's own cap, which only it can know.
 *
 * **A local provider is never refused.** It costs $0 (`cost-tracker.ts`), so a
 * reached cap is no reason to stop it, and a cap of `0` means "no paid calls"
 * rather than "no calls".
 *
 * **The month-to-date totals are cached for {@link SPEND_TOTAL_TTL_MS}.**
 * Without it every vendor call would sum a month of cost rows, and the global
 * total sums every org's, so the cost of a cap check would grow with the
 * number of tenants. `logCost` adds each row it writes to the cached totals
 * ({@link noteSpend}), so this process sees its own spend at once. Another
 * process's spend is seen when the entry expires, which bounds how far a cap
 * can be overrun to what the install spends in that window. A row written
 * while the total is being read may be counted twice until the entry expires.
 * That errs towards refusing early, never towards letting spend through.
 *
 * **The caps themselves are cached**, so a gated call makes no database read
 * at all while its entries are warm. An org's cap is cached here for
 * {@link CAP_SETTING_TTL_MS}, and `PATCH /api/v1/admin/orgs/[id]` clears it
 * with {@link forgetOrgCap}. The global cap is read from
 * `getOrchestrationSettings()`, whose cache the settings PATCH and the backup
 * importer already clear. Another process sees either change within 30s.
 *
 * **A chat turn can hold paid calls for an agent's own cap.** That cap is
 * known only to the chat handler, which still answers on a local model once
 * it is reached. It runs the turn inside {@link withPaidCallHold} and sets the
 * hold when it finds the cap reached, and this gate then refuses every paid
 * call the turn makes, the summarizer, embeddings and tools included, not
 * only the main stream.
 *
 * Tenancy posture: the global total is shared by decision, since the global
 * cap is install-wide by definition; the org totals and org caps are
 * row-keyed, by org id, and filled by queries that filter on that id; the
 * paid-call hold is async-local, one per chat turn.
 *
 * Platform-agnostic: no Next.js imports.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { prisma } from '@/lib/db/client';
import { logger } from '@/lib/logging';
import { globalSpendSince } from '@/lib/orchestration/admin/global-config-usage';
import { ProviderError, SPEND_CAP_CODES } from '@/lib/orchestration/llm/provider';
import {
  getOrchestrationSettings,
  invalidateOrchestrationSettingsCache,
} from '@/lib/orchestration/settings';
import { loadOrgQuotas } from '@/lib/tenancy/org-settings';
import { orgIdForCall } from '@/lib/tenancy/context';

/** How long a month-to-date total is served from the cache. */
export const SPEND_TOTAL_TTL_MS = 10_000;

/** How long an org's configured cap is served from the cache. */
export const CAP_SETTING_TTL_MS = 30_000;

/** A cached org cap. */
interface CapEntry {
  cachedAt: number;
  value: Promise<number | null>;
}

const orgCapEntries = new Map<string, CapEntry>();

/**
 * The org's `quotas.monthlyBudgetUsd`, cached; `null` when it has none. The
 * lookup is cached, so concurrent misses share one read, and a failed read is
 * dropped rather than kept as an answer.
 */
function orgCapSetting(orgId: string): Promise<number | null> {
  const current = orgCapEntries.get(orgId);
  if (current && Date.now() - current.cachedAt < CAP_SETTING_TTL_MS) return current.value;
  const entry: CapEntry = {
    cachedAt: Date.now(),
    value: loadOrgQuotas(orgId).then((quotas) => quotas.monthlyBudgetUsd ?? null),
  };
  orgCapEntries.set(orgId, entry);
  entry.value.catch(() => {
    if (orgCapEntries.get(orgId) === entry) orgCapEntries.delete(orgId);
  });
  return entry.value;
}

/** Drop one org's cached cap after a write, so this process enforces the new one at once. */
export function forgetOrgCap(orgId: string): void {
  orgCapEntries.delete(orgId);
}

/** Midnight UTC on the first of `now`'s month: where every monthly budget starts. */
export function utcMonthStart(now: Date = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

/**
 * One cached total. The LOOKUP is cached, not its answer, so concurrent misses
 * share one query (the shape `org-provider-policy.ts` uses). `added` is what
 * this process has spent since the lookup started.
 */
interface SpendEntry {
  monthStart: number;
  cachedAt: number;
  value: Promise<number>;
  added: number;
}

let globalEntry: SpendEntry | null = null;
const orgEntries = new Map<string, SpendEntry>();

function freshFor(entry: SpendEntry | null | undefined, monthStart: Date): entry is SpendEntry {
  return (
    entry !== null &&
    entry !== undefined &&
    entry.monthStart === monthStart.getTime() &&
    Date.now() - entry.cachedAt < SPEND_TOTAL_TTL_MS
  );
}

/** Start a lookup, and drop the entry again if it rejects: a failed read is not an answer. */
function startEntry(
  monthStart: Date,
  read: () => Promise<number>,
  store: (entry: SpendEntry | null) => void,
  current: () => SpendEntry | null | undefined
): SpendEntry {
  const entry: SpendEntry = {
    monthStart: monthStart.getTime(),
    cachedAt: Date.now(),
    value: read(),
    added: 0,
  };
  store(entry);
  entry.value.catch(() => {
    if (current() === entry) store(null);
  });
  return entry;
}

async function totalOf(entry: SpendEntry): Promise<number> {
  return (await entry.value) + entry.added;
}

/**
 * Every org's spend since the start of the current UTC month, detached
 * `NULL`-org rows included. Cached; see the module docblock.
 *
 * Read across orgs at `multi` (`globalSpendSince`), because the caller is
 * usually inside one org's scope, where the `org_isolation` policy would hide
 * every other org's rows.
 */
export function getMonthToDateGlobalSpend(): Promise<number> {
  const monthStart = utcMonthStart();
  const entry = freshFor(globalEntry, monthStart)
    ? globalEntry
    : startEntry(
        monthStart,
        () => globalSpendSince(monthStart),
        (next) => {
          globalEntry = next;
        },
        () => globalEntry
      );
  return totalOf(entry);
}

/**
 * One org's spend since the start of the current UTC month. Cached; see the
 * module docblock.
 *
 * Filtered on `orgId` explicitly rather than left to the `org_isolation`
 * policy, so it is the org's total whatever scope the caller is in, and at
 * `single` too, where there is no policy and a total with no filter would be
 * the whole install's.
 */
export function getMonthToDateOrgSpend(orgId: string): Promise<number> {
  const monthStart = utcMonthStart();
  const cached = orgEntries.get(orgId);
  const entry = freshFor(cached, monthStart)
    ? cached
    : startEntry(
        monthStart,
        async () => {
          const aggregate = await prisma.aiCostLog.aggregate({
            where: { orgId, createdAt: { gte: monthStart } },
            _sum: { totalCostUsd: true },
          });
          return aggregate._sum.totalCostUsd ?? 0;
        },
        (next) => {
          if (next === null) orgEntries.delete(orgId);
          else orgEntries.set(orgId, next);
        },
        () => orgEntries.get(orgId)
      );
  return totalOf(entry);
}

/**
 * Add a cost row this process just wrote to the cached totals, so the caps
 * see it before the entries expire. Called by `logCost`. A `NULL`-org row
 * counts towards the global total only.
 */
export function noteSpend(orgId: string | null, costUsd: number, at: Date = new Date()): void {
  if (!(costUsd > 0)) return;
  const monthStart = utcMonthStart(at);
  if (freshFor(globalEntry, monthStart)) globalEntry.added += costUsd;
  if (orgId !== null) {
    const entry = orgEntries.get(orgId);
    if (freshFor(entry, monthStart)) entry.added += costUsd;
  }
}

/** Drop every cached total and cap, so the next read of each goes to the database. */
export function forgetSpendCaps(): void {
  globalEntry = null;
  orgEntries.clear();
  orgCapEntries.clear();
  invalidateOrchestrationSettingsCache();
}

/** The global cap and what it is checked against. */
export interface GlobalCapState {
  /** `AiOrchestrationSettings.globalMonthlyBudgetUsd`; `null` when no cap is set. */
  cap: number | null;
  /** Month-to-date spend in every org; `0` when no cap is set, since nothing reads it. */
  spent: number;
  exceeded: boolean;
}

/**
 * The global cap and whether this month's spend has reached it. Throws when
 * the settings row or the total cannot be read; each caller decides what a
 * failure means for it.
 */
export async function getGlobalCapState(): Promise<GlobalCapState> {
  const cap = (await getOrchestrationSettings()).globalMonthlyBudgetUsd;
  if (cap === null) return { cap: null, spent: 0, exceeded: false };
  const spent = await getMonthToDateGlobalSpend();
  return { cap, spent, exceeded: spent >= cap };
}

/** An org's cap and what it is checked against. */
export interface OrgCapState {
  /** `Org.settings.quotas.monthlyBudgetUsd`. */
  limit: number;
  /** The org's month-to-date spend. */
  spent: number;
  exceeded: boolean;
}

/**
 * The org's cap, if it has one, and whether its month-to-date spend has
 * reached it. `null` when there is no org or the org has set no cap. Throws
 * when the org or its total cannot be read.
 */
export async function getOrgCapState(orgId: string | null): Promise<OrgCapState | null> {
  if (!orgId) return null;
  const monthlyBudgetUsd = await orgCapSetting(orgId);
  if (monthlyBudgetUsd === null) return null;
  const spent = await getMonthToDateOrgSpend(orgId);
  return { limit: monthlyBudgetUsd, spent, exceeded: spent >= monthlyBudgetUsd };
}

/** What a cap-read failure is logged with, beside the error. */
type CapReadContext = Record<string, unknown>;

function warnCapSkipped(cap: 'global' | 'org', context: CapReadContext, err: unknown): null {
  logger.warn(`Spend caps: the ${cap} cap could not be read, so it is skipped`, {
    ...context,
    error: err instanceof Error ? err.message : String(err),
  });
  return null;
}

/**
 * {@link getGlobalCapState}, or `null` when it cannot be read. A cap that
 * cannot be read is skipped rather than refusing everything: a settings read
 * that fails must not stop every AI call on the install. Every enforcing
 * caller reads the caps through this and {@link orgCapStateOrSkip}, so they
 * all treat a failure the same way.
 */
export function globalCapStateOrSkip(context: CapReadContext): Promise<GlobalCapState | null> {
  return getGlobalCapState().catch((err: unknown) => warnCapSkipped('global', context, err));
}

/** {@link getOrgCapState}, or `null` when it cannot be read; see {@link globalCapStateOrSkip}. */
export function orgCapStateOrSkip(
  orgId: string | null,
  context: CapReadContext
): Promise<OrgCapState | null> {
  return getOrgCapState(orgId).catch((err: unknown) =>
    warnCapSkipped('org', { orgId, ...context }, err)
  );
}

/** Which cap refused a paid call. */
export type SpendCap = keyof typeof SPEND_CAP_CODES;

/**
 * A chat turn's hold on paid calls. `cap` is set when the turn finds a cap
 * reached but goes on, on a local model; from then on the gate refuses every
 * paid call the turn makes. Mutable, so the handler can set it part way
 * through a turn that is already running inside {@link withPaidCallHold}.
 */
export interface PaidCallHold {
  cap: SpendCap | null;
}

/**
 * On `globalThis` for the reason `lib/tenancy/context.ts` gives above its
 * store (#1138): a capability the turn dispatches runs in the dispatcher's
 * module graph, and its paid calls must meet the hold the turn set in the
 * route's. The hold itself is still per turn.
 */
const globalForPaidCallHold = globalThis as unknown as {
  sunrisePaidCallHold?: AsyncLocalStorage<PaidCallHold>;
};
const paidCallHold = (globalForPaidCallHold.sunrisePaidCallHold ??=
  new AsyncLocalStorage<PaidCallHold>());

/**
 * Drive `inner` with `hold` as the paid-call hold for everything it does: each
 * `next()` runs inside the store, and the awaits it makes carry the store
 * with them, so a capability, a summarizer call or a fire-and-forget
 * embedding started by the turn sees the hold as the main stream does. The
 * shape of `withSpanGenerator`, which carries the OTEL context the same way.
 * A nested turn (an agent calling another agent) runs under its own hold.
 */
export async function* withPaidCallHold<T, R>(
  hold: PaidCallHold,
  inner: AsyncGenerator<T, R, unknown>
): AsyncGenerator<T, R, unknown> {
  try {
    while (true) {
      const result = await paidCallHold.run(hold, () => inner.next());
      if (result.done) return result.value;
      yield result.value;
    }
  } finally {
    // As `yield*` would: let the inner's own finally run when the consumer
    // stops early. A no-op on a generator that has already finished.
    await inner.return(undefined as R);
  }
}

/**
 * A paid vendor call refused because a monthly spend cap has been reached.
 * A request fault (`isRequestFault`): it is not retried and never reaches a
 * circuit breaker. Failing over is left to provider selection, which skips a
 * paid candidate the caps refuse and so can still reach a local one
 * (`getProviderWithFallbacks`, and chat's mid-stream failover).
 *
 * The message is for the operator reading a failed execution or a log; chat
 * shows its reader the registry's words for the code instead
 * (`getUserFacingError`).
 */
export class SpendCapExceededError extends ProviderError {
  readonly cap: SpendCap;
  readonly providerSlug: string;
  constructor(cap: SpendCap, providerSlug: string) {
    super(OPERATOR_MESSAGES[cap], { code: SPEND_CAP_CODES[cap], retriable: false });
    this.name = 'SpendCapExceededError';
    this.cap = cap;
    this.providerSlug = providerSlug;
  }
}

const OPERATOR_MESSAGES: Record<SpendCap, string> = {
  agent:
    "This agent has reached its monthly budget, so the call to a paid provider was refused. An admin can raise the agent's budget, or the agent can use a local model.",
  org: "This organisation has reached its monthly AI budget, so the call to a paid provider was refused. A platform admin can raise the organisation's cap (PATCH /api/v1/admin/orgs/[id], settings.quotas), or the work can use a local model.",
  global:
    'This platform has reached its global monthly AI budget, so the call to a paid provider was refused. A platform admin can raise the global cap in the orchestration settings, or the work can use a local model.',
};

/**
 * The refusal a paid call to `providerSlug` would meet now, or `null` when it
 * may go ahead. Never throws: provider selection asks this of each candidate
 * so it can pass over a refused paid one and reach a local one.
 *
 * The global cap is checked first, as in the chat handler's refusal: it is the
 * one nobody in the org can lift. Then the org's, then a hold the chat turn has
 * set for its agent's cap. A cap that cannot be read is skipped
 * ({@link globalCapStateOrSkip}).
 */
export async function spendCapRefusal(
  providerSlug: string,
  isLocal: boolean
): Promise<SpendCapExceededError | null> {
  if (isLocal) return null;
  const orgId = orgIdForCall();
  const [global, org] = await Promise.all([
    globalCapStateOrSkip({ providerSlug }),
    orgCapStateOrSkip(orgId, { providerSlug }),
  ]);

  const cap: SpendCap | null = global?.exceeded
    ? 'global'
    : org?.exceeded
      ? 'org'
      : (paidCallHold.getStore()?.cap ?? null);
  if (cap === null) return null;
  logger.warn('Refusing a paid provider call: monthly spend cap reached', {
    providerSlug,
    cap,
    orgId,
    ...(cap === 'global'
      ? { limitUsd: global?.cap, spentUsd: global?.spent }
      : cap === 'org'
        ? { limitUsd: org?.limit, spentUsd: org?.spent }
        : {}),
  });
  return new SpendCapExceededError(cap, providerSlug);
}

/**
 * The call-time spend gate: throws the {@link spendCapRefusal} for a paid
 * call, if there is one. Run by the provider manager before every vendor call.
 */
export async function assertWithinSpendCaps(providerSlug: string, isLocal: boolean): Promise<void> {
  const refusal = await spendCapRefusal(providerSlug, isLocal);
  if (refusal) throw refusal;
}
