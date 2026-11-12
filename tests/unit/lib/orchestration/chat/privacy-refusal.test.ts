/**
 * Placing a turn the privacy layer refused under `block` (§127 t-1017,
 * t-1018): from the stage's positions and the builder's sources to a case,
 * the rows to leave out, whether the summary is forgotten, and which memories
 * are deleted.
 */
import { describe, expect, it } from 'vitest';

import type { MessageSource } from '@/lib/orchestration/chat/message-builder';
import { placePrivacyRefusal } from '@/lib/orchestration/chat/privacy-refusal';

// What a turn built: setup, two memories, the summary, two earlier exchanges,
// the user's message.
const SOURCES: MessageSource[] = [
  { kind: 'system_prompt' },
  { kind: 'context' },
  { kind: 'memories' },
  { kind: 'memory', memoryIndex: 0 },
  { kind: 'memory', memoryIndex: 1 },
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
const MEM_1 = { id: 'mem-1', updatedAt: new Date('2026-11-01T00:00:00Z') };
const MEM_2 = { id: 'mem-2', updatedAt: new Date('2026-11-02T00:00:00Z') };
const MEMORIES = [MEM_1, MEM_2];
// Two messages past those, which the tool loop added: an assistant tool call
// and its result.
const SENT = {
  messageCount: 12,
  sources: SOURCES,
  historyRows: HISTORY_ROWS,
  memories: MEMORIES,
};
// Indices into SENT, by what is there.
const SYSTEM = 0;
const CONTEXT = 1;
const HEADING = 2;
const MEMORY_1 = 3;
const MEMORY_2 = 4;
const SUMMARY = 5;
const NOTE = 6;
const QUESTION = 7; // row-b
const REPLY = 8; // row-c
const MESSAGE = 9;
const TOOL_RESULT = 11;

const place = (messageIndices: number[], messageCount = 12) =>
  placePrivacyRefusal({ messageCount, messageIndices }, SENT);

/** A call of one message per history row, to place any row on its own. */
const placeRows = (...indices: number[]) =>
  placePrivacyRefusal(
    { messageCount: HISTORY_ROWS.length, messageIndices: indices },
    {
      messageCount: HISTORY_ROWS.length,
      sources: HISTORY_ROWS.map((_, historyIndex) => ({ kind: 'history', historyIndex })),
      historyRows: HISTORY_ROWS,
      memories: [],
    }
  )?.earlierRowIds;

describe('placePrivacyRefusal', () => {
  it('this turn: the user’s message, or what the tool loop added', () => {
    expect(place([MESSAGE])).toEqual({
      code: 'privacy_blocked',
      earlierRowIds: [],
      summary: false,
      memories: [],
      setup: [],
      turn: true,
    });
    expect(place([TOOL_RESULT])).toMatchObject({ code: 'privacy_blocked', turn: true });
  });

  it('earlier: the whole exchange each row is in, by id, not by position in the prompt', () => {
    expect(place([REPLY])).toEqual({
      code: 'privacy_blocked_earlier',
      earlierRowIds: ['row-b', 'row-c'],
      summary: false,
      memories: [],
      setup: [],
      turn: false,
    });
    // The question held them: its reply goes too.
    expect(place([QUESTION])).toMatchObject({ earlierRowIds: ['row-b', 'row-c'] });
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
    expect(place([SUMMARY, QUESTION])).toEqual({
      code: 'privacy_blocked_earlier',
      earlierRowIds: ['row-b', 'row-c'],
      summary: true,
      memories: [],
      setup: [],
      turn: false,
    });
  });

  it('this turn wins over everything, and leaves the rest alone', () => {
    // A name the reader typed that the setup also holds: asking again
    // without it works, so they are not sent to an administrator.
    expect(place([SYSTEM, HEADING, MEMORY_1, SUMMARY, REPLY, MESSAGE])).toEqual({
      code: 'privacy_blocked',
      earlierRowIds: [],
      summary: false,
      memories: [],
      setup: [],
      turn: true,
    });
  });

  it('this turn wins over anything earlier, which it leaves alone', () => {
    // Detection runs over the whole call: a name this turn introduced can be
    // found in earlier rows and the summary that passed every scan before.
    expect(place([SUMMARY, REPLY, MESSAGE])).toEqual({
      code: 'privacy_blocked',
      earlierRowIds: [],
      summary: false,
      memories: [],
      setup: [],
      turn: true,
    });
  });

  it('the setup: each part that held details, once, ahead of anything earlier or a memory', () => {
    // Every part named holds details of its own (the stage leaves out values
    // it only learned elsewhere). Until an administrator changes the setup,
    // nothing removed helps, so nothing is.
    expect(place([SYSTEM, HEADING, SYSTEM, MEMORY_2, SUMMARY, REPLY])).toEqual({
      code: 'privacy_blocked_setup',
      earlierRowIds: [],
      summary: false,
      memories: [],
      setup: ['system_prompt', 'memories'],
      turn: false,
    });
    expect(place([CONTEXT])).toMatchObject({ setup: ['context'], turn: false });
    expect(place([NOTE])).toMatchObject({ setup: ['note'] });
  });

  it.each([
    ['no location', undefined],
    ['a location for a call of another length', { messageCount: 13, messageIndices: [MESSAGE] }],
    ['an index past the call', { messageCount: 12, messageIndices: [12] }],
    ['a negative index', { messageCount: 12, messageIndices: [-1] }],
    ['an index that is not a whole number', { messageCount: 12, messageIndices: [1.5] }],
    ['no index at all', { messageCount: 12, messageIndices: [] }],
  ])('places nothing for %s', (_why, found) => {
    expect(placePrivacyRefusal(found, SENT)).toBeNull();
  });

  it('places nothing when a history source names a row it was not given', () => {
    const sources: MessageSource[] = [{ kind: 'history', historyIndex: 12 }];
    expect(
      placePrivacyRefusal(
        { messageCount: 1, messageIndices: [0] },
        { messageCount: 1, sources, historyRows: HISTORY_ROWS, memories: MEMORIES }
      )
    ).toBeNull();
  });

  it('a memory: each one that held details, once, with when it was last written', () => {
    expect(place([MEMORY_2, MEMORY_1, MEMORY_2])).toEqual({
      code: 'privacy_blocked_memory',
      earlierRowIds: [],
      summary: false,
      memories: [MEM_1, MEM_2],
      setup: [],
      turn: false,
    });
    expect(place([MEMORY_2])).toMatchObject({ memories: [MEM_2] });
  });

  it('anything earlier wins over a memory, which it leaves alone', () => {
    // Deleting a memory cannot be undone and reaches every conversation: a
    // name it only matched because an earlier row taught it is not found
    // once that row is left out.
    expect(place([MEMORY_1, REPLY])).toMatchObject({
      code: 'privacy_blocked_earlier',
      earlierRowIds: ['row-b', 'row-c'],
      memories: [],
    });
    expect(place([SUMMARY, MEMORY_1])).toMatchObject({
      code: 'privacy_blocked_earlier',
      summary: true,
      memories: [],
    });
  });

  it('this turn wins over a memory, which it leaves alone', () => {
    expect(place([MEMORY_1, MESSAGE])).toMatchObject({
      code: 'privacy_blocked',
      memories: [],
      turn: true,
    });
  });

  it('places nothing when a memory source names a memory it was not given', () => {
    const sources: MessageSource[] = [{ kind: 'memory', memoryIndex: 2 }];
    expect(
      placePrivacyRefusal(
        { messageCount: 1, messageIndices: [0] },
        { messageCount: 1, sources, historyRows: HISTORY_ROWS, memories: MEMORIES }
      )
    ).toBeNull();
  });
});
