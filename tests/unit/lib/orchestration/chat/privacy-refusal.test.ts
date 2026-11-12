/**
 * Placing a turn the privacy layer refused under `block` (§127 t-1017): from
 * the stage's positions and the builder's sources to a case, the rows to
 * leave out, and whether the summary is forgotten.
 */
import { describe, expect, it } from 'vitest';

import type { MessageSource } from '@/lib/orchestration/chat/message-builder';
import { placePrivacyRefusal } from '@/lib/orchestration/chat/privacy-refusal';

// What a turn built: setup, the summary, two earlier exchanges, the user's message.
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
const row = (id: string, role: string, finishedReply = false) => ({ id, role, finishedReply });
// Row 0 was dropped by the cap: it has an id, and no message. Rows 1 and 2
// are one exchange; rows 3 to 7 another (a tool call, its result, a pending
// approval's empty marker, the reply); row 8 a turn the agent opened, which
// has no user row.
const HISTORY_ROWS = [
  row('row-a', 'assistant', true),
  row('row-b', 'user'),
  row('row-c', 'assistant', true),
  row('row-d', 'user'),
  row('row-e', 'assistant'),
  row('row-f', 'tool'),
  row('row-m', 'assistant'),
  row('row-g', 'assistant', true),
  row('row-h', 'assistant', true),
];
// Two messages the tool loop added: an assistant tool call and its result.
const SENT = { messageCount: 10, sources: SOURCES, historyRows: HISTORY_ROWS };

const place = (messageIndices: number[], messageCount = 10) =>
  placePrivacyRefusal({ messageCount, messageIndices }, SENT);

/** A call of one message per history row, to place any row on its own. */
const placeRows = (...indices: number[]) =>
  placePrivacyRefusal(
    { messageCount: HISTORY_ROWS.length, messageIndices: indices },
    {
      messageCount: HISTORY_ROWS.length,
      sources: HISTORY_ROWS.map((_, historyIndex) => ({ kind: 'history', historyIndex })),
      historyRows: HISTORY_ROWS,
    }
  )?.earlierRowIds;

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

  it('earlier: the whole exchange each row is in, by id, not by position in the prompt', () => {
    expect(place([6])).toEqual({
      code: 'privacy_blocked_earlier',
      earlierRowIds: ['row-b', 'row-c'],
      summary: false,
      setup: [],
      turn: false,
    });
    // The question held them: its reply goes too.
    expect(place([5])).toMatchObject({ earlierRowIds: ['row-b', 'row-c'] });
  });

  it('earlier: an exchange runs to where the next begins, and a window may start inside one', () => {
    // No exchange begins before row 0: it starts at the window.
    expect(placeRows(0)).toEqual(['row-a']);
    // The tool call's exchange: its question, its result, the marker and its
    // reply, each once. A marker is not a finished reply: no split there.
    const toolExchange = ['row-d', 'row-e', 'row-f', 'row-m', 'row-g'];
    expect(placeRows(4, 4)).toEqual(toolExchange);
    expect(placeRows(7)).toEqual(toolExchange);
    // A turn the agent opened begins its own exchange: neither takes the other.
    expect(placeRows(8)).toEqual(['row-h']);
    expect(placeRows(3)).toEqual(toolExchange);
  });

  it('earlier: the summary, and earlier rows with it', () => {
    expect(place([3, 5])).toEqual({
      code: 'privacy_blocked_earlier',
      earlierRowIds: ['row-b', 'row-c'],
      summary: true,
      setup: [],
      turn: false,
    });
  });

  it('this turn wins over everything, and leaves the rest alone', () => {
    // A name the reader typed that the setup also holds: asking again
    // without it works, so they are not sent to an administrator.
    expect(place([0, 2, 3, 6, 7])).toEqual({
      code: 'privacy_blocked',
      earlierRowIds: [],
      summary: false,
      setup: [],
      turn: true,
    });
  });

  it('this turn wins over anything earlier, which it leaves alone', () => {
    // Detection runs over the whole call: a name this turn introduced can be
    // found in earlier rows and the summary that passed every scan before.
    expect(place([3, 6, 7])).toEqual({
      code: 'privacy_blocked',
      earlierRowIds: [],
      summary: false,
      setup: [],
      turn: true,
    });
  });

  it('the setup wins over anything earlier, and leaves it alone', () => {
    expect(place([0, 2, 0, 3, 6])).toEqual({
      code: 'privacy_blocked_setup',
      earlierRowIds: [],
      summary: false,
      setup: ['system_prompt', 'memories'],
      turn: false,
    });
    expect(place([1])).toMatchObject({ setup: ['context'], turn: false });
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
    const sources: MessageSource[] = [{ kind: 'history', historyIndex: 12 }];
    expect(
      placePrivacyRefusal(
        { messageCount: 1, messageIndices: [0] },
        { messageCount: 1, sources, historyRows: HISTORY_ROWS }
      )
    ).toBeNull();
  });
});
