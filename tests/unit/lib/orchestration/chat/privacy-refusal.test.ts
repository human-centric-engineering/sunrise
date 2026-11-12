/**
 * Placing a turn the privacy layer refused under `block` (§127 t-1017): from
 * the stage's positions and the builder's sources to a case, the rows to
 * leave out, and whether the summary goes.
 */
import { describe, expect, it } from 'vitest';

import type { MessageSource } from '@/lib/orchestration/chat/message-builder';
import { placePrivacyRefusal } from '@/lib/orchestration/chat/privacy-refusal';

// What a turn built: setup, the summary, two earlier rows, the user's message.
const SOURCES: MessageSource[] = [
  { kind: 'system_prompt' },
  { kind: 'context' },
  { kind: 'memories' },
  { kind: 'summary' },
  { kind: 'note' },
  { kind: 'history', historyIndex: 1 },
  { kind: 'history', historyIndex: 2 },
  { kind: 'user_message' },
];
// Row 0 was dropped by the cap: it has an id, and no message.
const HISTORY_ROW_IDS = ['row-a', 'row-b', 'row-c'];
// Two messages the tool loop added: an assistant tool call and its result.
const SENT = { messageCount: 10, sources: SOURCES, historyRowIds: HISTORY_ROW_IDS };

const place = (messageIndices: number[], messageCount = 10) =>
  placePrivacyRefusal({ messageCount, messageIndices }, SENT);

describe('placePrivacyRefusal', () => {
  it('this turn: the user’s message, or what the tool loop added', () => {
    expect(place([7])).toEqual({
      code: 'privacy_blocked',
      earlierRowIds: [],
      summary: false,
      setup: [],
      turn: true,
    });
    expect(place([9])).toMatchObject({ code: 'privacy_blocked', turn: true });
  });

  it('earlier: the rows by their id, not their position in the prompt', () => {
    expect(place([6, 7])).toEqual({
      code: 'privacy_blocked_earlier',
      earlierRowIds: ['row-c'],
      summary: false,
      setup: [],
      turn: true,
    });
    expect(place([5])).toMatchObject({ earlierRowIds: ['row-b'] });
  });

  it('earlier: the summary', () => {
    expect(place([3])).toMatchObject({
      code: 'privacy_blocked_earlier',
      summary: true,
      earlierRowIds: [],
    });
  });

  it('setup wins, and everything else that held details is still named', () => {
    expect(place([0, 2, 0, 3, 6, 8])).toEqual({
      code: 'privacy_blocked_setup',
      earlierRowIds: ['row-c'],
      summary: true,
      setup: ['system_prompt', 'memories'],
      turn: true,
    });
    expect(place([1])).toMatchObject({ setup: ['context'] });
    expect(place([4])).toMatchObject({ setup: ['note'] });
  });

  it.each([
    ['no location', undefined],
    ['a location for a call of another length', { messageCount: 11, messageIndices: [7] }],
    ['an index past the call', { messageCount: 10, messageIndices: [10] }],
    ['a negative index', { messageCount: 10, messageIndices: [-1] }],
    ['an index that is not a whole number', { messageCount: 10, messageIndices: [1.5] }],
    ['no index at all', { messageCount: 10, messageIndices: [] }],
  ])('places nothing for %s', (_why, found) => {
    expect(placePrivacyRefusal(found, SENT)).toBeNull();
  });

  it('places nothing when a history source names a row it was not given', () => {
    const sources: MessageSource[] = [{ kind: 'history', historyIndex: 7 }];
    expect(
      placePrivacyRefusal(
        { messageCount: 1, messageIndices: [0] },
        { messageCount: 1, sources, historyRowIds: HISTORY_ROW_IDS }
      )
    ).toBeNull();
  });
});
