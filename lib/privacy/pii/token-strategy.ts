/**
 * The default token strategy: stateless, typed, numbered placeholders (§127).
 *
 * A session is one provider call's map from values to placeholders. It is
 * built from that call's own input and discarded after it, and nothing is
 * stored: every call sends the whole conversation, and providers are called
 * statelessly (no `store: true`, no `previous_response_id`, no batch API — see
 * the spec's *Placeholders*), so the next call rebuilds the same map.
 *
 * Numbering is by first appearance within a type (`PERSON_1`, `PERSON_2`,
 * `ORG_1`). History is append-only, so the earlier turns of a conversation
 * mask the same way on every call, and provider prompt caching keeps working.
 *
 * @see .context/privacy/llm-privacy-layer.md — *Placeholders*
 */
import type { EntityType, PrivacyTokenStrategy, TokenSession } from '@/lib/privacy/adapters/types';

export const STATELESS_TOKEN_STRATEGY_ID = 'core.stateless';

/**
 * How a placeholder is written. Chosen by measuring which form the shipped
 * providers reproduce most reliably; the spec records the measurement.
 * `restore.ts` and `stream-restore.ts` derive their grammar from it.
 */
export const PLACEHOLDER_FORMAT = { open: '[', close: ']' } as const;

/** The type that marks text which already looked like a placeholder. */
export const LITERAL_TYPE = 'LITERAL';

/** A placeholder as written. `n` is taken as given: "01" stays "01". */
export function formatPlaceholder(type: EntityType, n: number | string): string {
  return `${PLACEHOLDER_FORMAT.open}${type}_${n}${PLACEHOLDER_FORMAT.close}`;
}

interface Entry {
  placeholder: string;
  type: EntityType;
  value: string;
}

/**
 * One call's map. A value gets one placeholder whatever type it is reported
 * as, so the model never sees one person as two; the type of its first
 * appearance names it. Values are compared exactly: "James" and "JAMES" are
 * two values, so restoring gives back exactly what was masked.
 */
class StatelessSession implements TokenSession {
  private readonly byValue = new Map<string, Entry>();
  private readonly byPlaceholder = new Map<string, Entry>();
  private readonly counters = new Map<EntityType, number>();
  private readonly issued: Entry[] = [];

  placeholderFor(type: EntityType, value: string): string {
    const existing = this.byValue.get(value);
    if (existing) return existing.placeholder;
    const n = (this.counters.get(type) ?? 0) + 1;
    this.counters.set(type, n);
    const entry = { placeholder: formatPlaceholder(type, n), type, value };
    this.byValue.set(value, entry);
    this.byPlaceholder.set(entry.placeholder, entry);
    this.issued.push(entry);
    return entry.placeholder;
  }

  valueFor(placeholder: string): string | undefined {
    return this.byPlaceholder.get(placeholder)?.value;
  }

  entries(): readonly Entry[] {
    return this.issued.map((e) => ({ ...e }));
  }
}

/** Sunrise's default strategy: a fresh, unstored map per call. */
export function statelessTokenStrategy(): PrivacyTokenStrategy {
  return {
    id: STATELESS_TOKEN_STRATEGY_ID,
    persistent: false,
    createSession: () => new StatelessSession(),
  };
}
