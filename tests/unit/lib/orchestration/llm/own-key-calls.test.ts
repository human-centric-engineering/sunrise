/**
 * The notes that carry which key a call went out on to its cost row (§137
 * t-1046). Every answer that is not a clear "own key" is `false`, which counts
 * the row as the platform's: the side on which a spend cap can only refuse
 * early. These pin when a row is marked, and that a note is never taken by a
 * row it might not belong to.
 *
 * The end-to-end half, through the provider manager and real callers, is
 * `own-key-spend.test.ts`.
 *
 * @see lib/orchestration/llm/own-key-calls.ts
 */

import { beforeEach, describe, expect, it } from 'vitest';

import {
  OWN_KEY_NOTE_TTL_MS,
  OWN_KEY_NOTES_PER_KEY,
  claimOwnKeyCall,
  forgetProviderCallNotes,
  noteProviderCall,
} from '@/lib/orchestration/llm/own-key-calls';

const ORG_A = 'cmorg00000000000000000orga';
const ORG_B = 'cmorg00000000000000000orgb';
const MODEL = 'claude-haiku-4-5';
const T0 = 1_800_000_000_000;

beforeEach(() => {
  forgetProviderCallNotes();
});

describe('a row is marked', () => {
  it('when the org’s every live note for the model is an own-key one, taking one per row', () => {
    noteProviderCall(ORG_A, MODEL, true, T0);
    noteProviderCall(ORG_A, MODEL, true, T0 + 1);

    expect(claimOwnKeyCall(ORG_A, MODEL, T0 + 2)).toBe(true);
    expect(claimOwnKeyCall(ORG_A, MODEL, T0 + 3)).toBe(true);
    // Both taken: a third row has no call behind it.
    expect(claimOwnKeyCall(ORG_A, MODEL, T0 + 4)).toBe(false);
  });

  it('only for the org and model the call was noted for', () => {
    noteProviderCall(ORG_A, MODEL, true, T0);

    expect(claimOwnKeyCall(ORG_B, MODEL, T0)).toBe(false);
    expect(claimOwnKeyCall(ORG_A, 'claude-sonnet-4-6', T0)).toBe(false);
    expect(claimOwnKeyCall(null, MODEL, T0)).toBe(false);
    // The note is still there for its own row.
    expect(claimOwnKeyCall(ORG_A, MODEL, T0)).toBe(true);
  });
});

describe('a row is not marked', () => {
  it('for a platform-key call, and the note goes with the row', () => {
    noteProviderCall(ORG_A, MODEL, false, T0);
    expect(claimOwnKeyCall(ORG_A, MODEL, T0 + 1)).toBe(false);

    // Taken, so it does not make the next own-key row unclear.
    noteProviderCall(ORG_A, MODEL, true, T0 + 2);
    expect(claimOwnKeyCall(ORG_A, MODEL, T0 + 3)).toBe(true);
  });

  it('when the notes disagree, and none of them is taken', () => {
    noteProviderCall(ORG_A, MODEL, true, T0);
    noteProviderCall(ORG_A, MODEL, false, T0 + 1);

    // Either row may come first; neither can be told from the other.
    expect(claimOwnKeyCall(ORG_A, MODEL, T0 + 2)).toBe(false);
    expect(claimOwnKeyCall(ORG_A, MODEL, T0 + 3)).toBe(false);
    // Taking the own-key note for the first row would have marked the
    // platform's row that came second.
    expect(claimOwnKeyCall(ORG_A, MODEL, T0 + 4)).toBe(false);
  });

  it('once the notes have expired, and an expired note no longer makes them disagree', () => {
    noteProviderCall(ORG_A, MODEL, false, T0);
    noteProviderCall(ORG_A, MODEL, true, T0 + OWN_KEY_NOTE_TTL_MS);

    // The platform note is past the TTL: only the own-key one is live.
    expect(claimOwnKeyCall(ORG_A, MODEL, T0 + OWN_KEY_NOTE_TTL_MS + 1)).toBe(true);

    noteProviderCall(ORG_A, MODEL, true, T0 + 2 * OWN_KEY_NOTE_TTL_MS);
    expect(claimOwnKeyCall(ORG_A, MODEL, T0 + 3 * OWN_KEY_NOTE_TTL_MS + 1)).toBe(false);
  });

  it('for a while after the notes overflowed, rather than dropping one that might be the platform’s', () => {
    noteProviderCall(ORG_A, MODEL, false, T0);
    for (let i = 1; i <= OWN_KEY_NOTES_PER_KEY; i++) noteProviderCall(ORG_A, MODEL, true, T0 + i);

    expect(claimOwnKeyCall(ORG_A, MODEL, T0 + OWN_KEY_NOTES_PER_KEY + 1)).toBe(false);
    noteProviderCall(ORG_A, MODEL, true, T0 + OWN_KEY_NOTES_PER_KEY + 2);
    expect(claimOwnKeyCall(ORG_A, MODEL, T0 + OWN_KEY_NOTES_PER_KEY + 3)).toBe(false);

    // Clear again once the TTL has run from the overflow.
    const after = T0 + OWN_KEY_NOTES_PER_KEY + OWN_KEY_NOTE_TTL_MS + 10;
    noteProviderCall(ORG_A, MODEL, true, after);
    expect(claimOwnKeyCall(ORG_A, MODEL, after + 1)).toBe(true);
  });
});
