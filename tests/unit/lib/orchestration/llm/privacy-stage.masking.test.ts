/**
 * Tests: the privacy stage's masking modes, `block`, and the embeddings policy
 * (§127, t-992).
 *
 * The registry, Sunrise's own detectors and its token strategy are real, so
 * what is masked is what the shipped layer masks. The app seam is a stand-in
 * each case fills, and the settings read is stubbed.
 *
 * @see lib/orchestration/llm/privacy-stage.ts
 * @see lib/orchestration/privacy/call-masking.ts
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const seam = vi.hoisted(() => ({ init: vi.fn<() => void>() }));
const settings = vi.hoisted(() => ({
  read: vi.fn<() => Promise<Record<string, unknown>>>(),
}));
/** Makes masking throw: a bug inside the stage. */
const masking = vi.hoisted(() => ({ fail: false }));

// The agent's mode and the org's minimum (t-1010): neither set here.
vi.mock('@/lib/db/client', () => ({
  prisma: {
    aiAgent: { findUnique: vi.fn(async () => null) },
    org: { findUnique: vi.fn(async () => null) },
  },
}));
vi.mock('@/lib/app/privacy-adapters', () => ({
  initAppPrivacyAdapters: () => seam.init(),
}));
vi.mock('@/lib/orchestration/settings', () => ({
  getOrchestrationSettings: () => settings.read(),
}));
vi.mock('@/lib/orchestration/privacy/call-masking', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/orchestration/privacy/call-masking')>();
  return {
    ...real,
    maskMessages: (...args: Parameters<typeof real.maskMessages>) => {
      if (masking.fail) throw new Error('masking broke');
      return real.maskMessages(...args);
    },
  };
});
vi.mock('@/lib/logging', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { logger } from '@/lib/logging';
import {
  applyPrivacyStage,
  isLocalOnlyEmbeddingRefusal,
  PrivacyRefusedError,
} from '@/lib/orchestration/llm/privacy-stage';
import {
  isRequestFault,
  PRIVACY_BLOCKED,
  PRIVACY_REFUSED,
  ProviderError,
} from '@/lib/orchestration/llm/provider';
import type { LlmMessage, LlmResponse, StreamChunk } from '@/lib/orchestration/llm/types';
import {
  createPrivacyScope,
  privacySummary,
  runInPrivacyScope,
  type PrivacyScope,
} from '@/lib/orchestration/privacy/scope';
import {
  __resetPrivacyAdaptersForTests,
  registerPrivacyDetector,
} from '@/lib/privacy/adapters/registry';
import { PLACEHOLDER_INSTRUCTION } from '@/lib/privacy/pii/mask';

const EMAIL = 'priya.sharma@example.com';
const NINO = 'TJ 33 15 36 A';
const PHONE = '07911 123456';
const NAME = 'Priya Sharma';
const SEEDED = [EMAIL, NINO, PHONE, NAME];

function messages(): LlmMessage[] {
  return [
    { role: 'system', content: 'You are a helpful support agent.' },
    { role: 'user', content: `Hi, I'm ${NAME}. My email is ${EMAIL} and my NI number is ${NINO}.` },
    {
      role: 'assistant',
      content: '',
      toolCalls: [
        {
          id: 't1',
          name: 'lookup',
          arguments: { phone: PHONE, byEmail: { [EMAIL]: true }, nested: { n: 1 } },
        },
      ],
    },
    { role: 'tool', content: '{"found":true}', toolCallId: 't1' },
  ];
}

function mode(privacyMode: string, extra: Record<string, unknown> = {}) {
  settings.read.mockResolvedValue({
    privacyMode,
    privacyIgnoredEntityTypes: ['DATE', 'LOCATION'],
    privacyProtectLocalProviders: false,
    privacyEmbeddingsPolicy: 'allow',
    ...extra,
  });
}

function chatCall(args: unknown[] = [messages(), { model: 'm' }], isLocal = false) {
  return { providerSlug: 'openai', isLocal, coverage: 'full' as const, args };
}

function embedCall(isLocal: boolean) {
  return { providerSlug: 'voyage', isLocal, coverage: 'count' as const, args: [[NAME]] };
}

async function inScope<T>(fn: () => Promise<T>): Promise<{ result: T; scope: PrivacyScope }> {
  const scope = createPrivacyScope({ scopeId: 'conversation:c1', agentId: 'agent-1' });
  const result = await runInPrivacyScope(scope, fn);
  return { result, scope };
}

async function refusal(promise: Promise<unknown>): Promise<PrivacyRefusedError> {
  const err = await promise.then(
    () => undefined,
    (e: unknown) => e
  );
  if (!(err instanceof PrivacyRefusedError))
    throw new Error(`expected a refusal, got ${String(err)}`);
  return err;
}

function sentMessages(args: readonly unknown[]): LlmMessage[] {
  return args[0] as LlmMessage[];
}

/** The placeholder the sent text gives a value's type, e.g. `[EMAIL_1]`. */
function placeholderOf(sent: string, type: string): string {
  const m = new RegExp(`\\[${type}_\\d+\\]`).exec(sent);
  if (!m) throw new Error(`no ${type} placeholder in ${sent}`);
  return m[0];
}

function response(content: string, toolCalls?: LlmResponse['toolCalls']): LlmResponse {
  return {
    content,
    ...(toolCalls ? { toolCalls } : {}),
    usage: { inputTokens: 1, outputTokens: 1 },
    model: 'm',
    finishReason: 'stop',
  };
}

async function* chunks(...items: StreamChunk[]): AsyncGenerator<StreamChunk> {
  for (const item of items) yield item;
}

async function collect(stream: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const out: StreamChunk[] = [];
  for await (const c of stream) out.push(c);
  return out;
}

function failingDetector(required: boolean) {
  registerPrivacyDetector(
    {
      id: 'app.flaky',
      egress: 'in_process',
      entityTypes: ['PERSON'],
      detect: () => Promise.reject(new Error('timed out')),
    },
    { required }
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  __resetPrivacyAdaptersForTests();
  seam.init.mockImplementation(() => undefined);
  masking.fail = false;
  mode('pseudonymise');
});

describe('pseudonymise: what is sent', () => {
  it('sends no seeded value, anywhere in the call, and leaves the caller’s messages alone', async () => {
    const original = messages();
    const before = structuredClone(original);
    const { result } = await inScope(() => applyPrivacyStage(chatCall([original, { model: 'm' }])));

    const sent = JSON.stringify(result.args);
    for (const value of SEEDED) expect(sent).not.toContain(value);
    expect(sent).toMatch(/\[EMAIL_1\]/);
    expect(sent).toMatch(/\[UK_NINO_1\]/);
    expect(sent).toMatch(/\[PHONE_1\]/);
    expect(sent).toMatch(/\[PERSON_1\]/);
    // The options go out as they came.
    expect(result.args[1]).toEqual({ model: 'm' });
    expect(original).toEqual(before);
  });

  it('masks a tool call’s argument keys with the same placeholder as the value elsewhere', async () => {
    const { result } = await inScope(() => applyPrivacyStage(chatCall()));
    const sent = sentMessages(result.args);
    const email = placeholderOf(JSON.stringify(sent[1].content), 'EMAIL');
    expect(sent[2].toolCalls?.[0].arguments).toEqual({
      phone: expect.stringMatching(/^\[PHONE_\d+\]$/),
      byEmail: { [email]: true },
      nested: { n: 1 },
    });
  });

  it('adds the placeholder instruction to the system prompt once, on every masking-mode call', async () => {
    const { result } = await inScope(() => applyPrivacyStage(chatCall()));
    const sent = sentMessages(result.args);
    expect(sent[0]).toEqual({
      role: 'system',
      content: `You are a helpful support agent.\n\n${PLACEHOLDER_INSTRUCTION}`,
    });
    expect(JSON.stringify(sent).split(PLACEHOLDER_INSTRUCTION)).toHaveLength(2);

    // Nothing to mask still carries it, so the system prompt (the provider's
    // cache prefix) does not change when the first value appears. Nothing
    // was issued, so there is nothing to restore.
    const question: LlmMessage = { role: 'user', content: 'What are your opening hours?' };
    const clean: LlmMessage[] = [
      { role: 'system', content: 'You are a helpful support agent.' },
      question,
    ];
    const { result: untouched } = await inScope(() => applyPrivacyStage(chatCall([clean, {}])));
    expect(sentMessages(untouched.args)[0]).toEqual(sent[0]);
    expect(sentMessages(untouched.args)[1]).toEqual(question);
    expect(untouched.restorer).toBeUndefined();
  });

  it('adds the instruction as a system message of its own when the call has no system prompt', async () => {
    const args = [[{ role: 'user', content: `Email ${EMAIL}` }], { model: 'm' }];
    const { result } = await inScope(() => applyPrivacyStage(chatCall(args)));
    expect(sentMessages(result.args)[0]).toEqual({
      role: 'system',
      content: PLACEHOLDER_INSTRUCTION,
    });
  });

  it('masks earlier turns the same way on every call, so a growing history keeps its numbering', async () => {
    const first = messages();
    const { result: a } = await inScope(() => applyPrivacyStage(chatCall([first, {}])));
    const second: LlmMessage[] = [
      ...first,
      { role: 'assistant', content: `Thanks ${NAME}, I found your record.` },
      { role: 'user', content: 'Please also copy in jo.bloggs@example.org.' },
    ];
    const { result: b } = await inScope(() => applyPrivacyStage(chatCall([second, {}])));
    const sentA = sentMessages(a.args);
    const sentB = sentMessages(b.args);
    expect(sentB.slice(0, sentA.length)).toEqual(sentA);
    expect(JSON.stringify(sentB)).toMatch(/\[EMAIL_2\]/);
  });

  it('masks text that already looks like a placeholder, and gives it back exactly on restore', async () => {
    const args = [
      [{ role: 'user', content: `I'm ${NAME}. Our template says [PERSON_1] here.` }],
      { model: 'm' },
    ];
    const { result } = await inScope(() => applyPrivacyStage(chatCall(args)));
    const sent = JSON.stringify(sentMessages(result.args)[1].content);
    expect(sent).toMatch(/\[LITERAL_1\]/);
    const echoed = result.restorer?.response(response(sent.slice(1, -1)));
    expect(echoed?.content).toBe(`I'm ${NAME}. Our template says [PERSON_1] here.`);
  });

  it('scans and masks a call made outside any scope, observer or not', async () => {
    const result = await applyPrivacyStage(chatCall());
    const sent = JSON.stringify(result.args);
    for (const value of SEEDED) expect(sent).not.toContain(value);
  });
});

/** A detector for `CODE` values that reports only the codes `find` names, first copy only. */
function codeDetector(find: () => readonly string[]) {
  registerPrivacyDetector({
    id: 'app.codes',
    egress: 'in_process',
    entityTypes: ['CODE'],
    detect: async ({ text }) =>
      find().flatMap((code) => {
        const at = text.indexOf(code);
        return at === -1 ? [] : [{ type: 'CODE', start: at, end: at + code.length, confidence: 1 }];
      }),
  });
}

describe('pseudonymise: every copy of a value', () => {
  it('masks a copy the detector did not report, so it never sits in plaintext beside its placeholder', async () => {
    seam.init.mockImplementation(() => codeDetector(() => ['ZX-4471']));
    const args = [
      [
        { role: 'user', content: 'My code is ZX-4471.' },
        { role: 'user', content: 'Yes, ZX-4471 is right, not ZX-4471Q.' },
      ],
      { model: 'm' },
    ];
    const { result } = await inScope(() => applyPrivacyStage(chatCall(args)));
    const sent = sentMessages(result.args);
    expect(sent[1].content).toBe('My code is [CODE_1].');
    // The second copy is masked; a longer token that merely starts with it is not.
    expect(sent[2].content).toBe('Yes, [CODE_1] is right, not ZX-4471Q.');
  });
});

describe('pseudonymise: a one-word value is not extended to its other copies', () => {
  it('leaves an ordinary word spelt like a found name alone', async () => {
    seam.init.mockImplementation(() =>
      registerPrivacyDetector({
        id: 'app.colleague',
        egress: 'in_process',
        entityTypes: ['PERSON'],
        detect: async ({ text }) => {
          const at = text.indexOf('colleague Will');
          return at === -1
            ? []
            : [{ type: 'PERSON', start: at + 10, end: at + 14, confidence: 0.9 }];
        },
      })
    );
    const args = [
      [
        { role: 'system', content: 'Will you always cite sources.' },
        { role: 'user', content: 'Ask my colleague Will.' },
      ],
      { model: 'm' },
    ];
    const { result } = await inScope(() => applyPrivacyStage(chatCall(args)));
    const sent = sentMessages(result.args);
    expect(sent[0].content).toMatch(/^Will you always cite sources\./);
    expect(sent[1].content).toBe('Ask my colleague [PERSON_1].');
  });
});

describe('pseudonymise: one session per scope', () => {
  it('keeps a value’s placeholder across a turn’s calls when a later call detects more', async () => {
    let found: string[] = ['BETA-2'];
    seam.init.mockImplementation(() => codeDetector(() => found));
    const scope = createPrivacyScope({ scopeId: 'conversation:c1' });
    const history: LlmMessage[] = [{ role: 'user', content: 'Codes ALPHA-1 and BETA-2.' }];

    const first = await runInPrivacyScope(scope, () => applyPrivacyStage(chatCall([history, {}])));
    expect(sentMessages(first.args)[1].content).toBe('Codes ALPHA-1 and [CODE_1].');

    // A later call in the loop detects ALPHA-1 too. Numbering by first
    // appearance alone would renumber BETA-2 to CODE_2, and reasoning replayed
    // from the first call would then point [CODE_1] at the wrong value.
    found = ['ALPHA-1', 'BETA-2'];
    const second = await runInPrivacyScope(scope, () => applyPrivacyStage(chatCall([history, {}])));
    expect(sentMessages(second.args)[1].content).toBe('Codes [CODE_2] and [CODE_1].');
    expect(second.restorer?.response(response('[CODE_1] then [CODE_2]')).content).toBe(
      'BETA-2 then ALPHA-1'
    );

    // A call whose detector misses a value the scope already masked still masks it.
    found = [];
    const third = await runInPrivacyScope(scope, () => applyPrivacyStage(chatCall([history, {}])));
    expect(sentMessages(third.args)[1].content).toBe('Codes [CODE_2] and [CODE_1].');
  });

  it('starts afresh in another scope, numbering by first appearance', async () => {
    seam.init.mockImplementation(() => codeDetector(() => ['ALPHA-1', 'BETA-2']));
    const history: LlmMessage[] = [{ role: 'user', content: 'Codes ALPHA-1 and BETA-2.' }];
    const { result } = await inScope(() => applyPrivacyStage(chatCall([history, {}])));
    expect(sentMessages(result.args)[1].content).toBe('Codes [CODE_1] and [CODE_2].');
  });
});

describe('pseudonymise: what comes back', () => {
  it('restores the reply and a tool call’s arguments, keys included, before the caller sees them', async () => {
    const { result, scope } = await inScope(() => applyPrivacyStage(chatCall()));
    const sent = JSON.stringify(result.args);
    const email = placeholderOf(sent, 'EMAIL');
    const person = placeholderOf(sent, 'PERSON');

    const restored = result.restorer?.response(
      response(`Thanks ${person}, I'll write to ${email}.`, [
        {
          id: 'c1',
          name: 'send_email',
          arguments: { to: email, cc: [email], meta: { [email]: 1 } },
        },
      ])
    );

    expect(restored?.content).toBe(`Thanks ${NAME}, I'll write to ${EMAIL}.`);
    expect(restored?.toolCalls?.[0].arguments).toEqual({
      to: EMAIL,
      cc: [EMAIL],
      meta: { [EMAIL]: 1 },
    });
    expect(privacySummary(scope)?.unresolved).toBeUndefined();
  });

  it('leaves a placeholder no call issued visible, and counts it on the trace', async () => {
    const { result, scope } = await inScope(() => applyPrivacyStage(chatCall()));
    const restored = result.restorer?.response(response('Ask [PERSON_9] about it.'));
    expect(restored?.content).toBe('Ask [PERSON_9] about it.');
    expect(privacySummary(scope)?.unresolved).toBe(1);
  });

  it('restores a structured reply by parsing it, so a value with a quote cannot break the JSON', async () => {
    const quoted = 'Dara "DJ" O’Neill';
    const args = [
      [{ role: 'user', content: `Contact ${quoted} on ${EMAIL}` }],
      { model: 'm', responseFormat: { type: 'json_object' } },
    ];
    const { result } = await inScope(() => applyPrivacyStage(chatCall(args)));
    const email = placeholderOf(JSON.stringify(result.args), 'EMAIL');
    const restored = result.restorer?.response(
      response(JSON.stringify({ contact: email, note: `${email} wrote "hi"` }))
    );
    expect(JSON.parse(restored?.content ?? '')).toEqual({
      contact: EMAIL,
      note: `${EMAIL} wrote "hi"`,
    });
  });

  it('holds a streamed structured reply whole and restores it as JSON, so a quote cannot break it', async () => {
    const quoted = 'Dara "DJ" O’Neill';
    const args = [
      [{ role: 'user', content: `Contact ${quoted} on ${EMAIL}` }],
      { model: 'm', responseFormat: { type: 'json_object' } },
    ];
    const { result } = await inScope(() => applyPrivacyStage(chatCall(args)));
    const email = placeholderOf(JSON.stringify(result.args), 'EMAIL');
    const json = JSON.stringify({ to: email });
    const out = await collect(
      result.restorer!.stream(
        chunks(
          { type: 'text', content: json.slice(0, 5) },
          { type: 'text', content: json.slice(5) },
          { type: 'done', usage: { inputTokens: 1, outputTokens: 1 }, finishReason: 'stop' }
        )
      )
    );
    expect(out.map((c) => c.type)).toEqual(['text', 'done']);
    const text = out[0].type === 'text' ? out[0].content : '';
    expect(JSON.parse(text)).toEqual({ to: EMAIL });
  });

  it('restores a stream split mid-placeholder, and a streamed tool call, keeping their order', async () => {
    const { result } = await inScope(() => applyPrivacyStage(chatCall()));
    const sent = JSON.stringify(result.args);
    const email = placeholderOf(sent, 'EMAIL');
    const person = placeholderOf(sent, 'PERSON');
    const text = `Hello ${person}, writing to ${email}`;
    const cut = text.indexOf(email) + 3;

    const out = await collect(
      result.restorer!.stream(
        chunks(
          { type: 'reasoning', text: `${person} wants ` },
          { type: 'reasoning', text: 'an update' },
          { type: 'text', content: text.slice(0, cut) },
          { type: 'text', content: text.slice(cut) },
          { type: 'tool_call', toolCall: { id: 'c1', name: 'send', arguments: { to: email } } },
          { type: 'done', usage: { inputTokens: 1, outputTokens: 1 }, finishReason: 'tool_use' }
        )
      )
    );

    const textOut = out.flatMap((c) => (c.type === 'text' ? [c.content] : [])).join('');
    const reasoningOut = out.flatMap((c) => (c.type === 'reasoning' ? [c.text] : [])).join('');
    expect(textOut).toBe(`Hello ${NAME}, writing to ${EMAIL}`);
    expect(reasoningOut).toBe(`${NAME} wants an update`);
    const kinds = out.map((c) => c.type);
    // All text is out before the tool call, and the tool call before done.
    expect(kinds.lastIndexOf('text')).toBeLessThan(kinds.indexOf('tool_call'));
    expect(kinds.indexOf('tool_call')).toBeLessThan(kinds.indexOf('done'));
    expect(out.find((c) => c.type === 'tool_call')).toEqual({
      type: 'tool_call',
      toolCall: { id: 'c1', name: 'send', arguments: { to: EMAIL } },
    });
  });

  it('releases what a stream held back when it ends with no done chunk', async () => {
    const { result } = await inScope(() => applyPrivacyStage(chatCall()));
    const email = placeholderOf(JSON.stringify(result.args), 'EMAIL');
    const out = await collect(
      result.restorer!.stream(chunks({ type: 'text', content: `Mail ${email.slice(0, 4)}` }))
    );
    expect(out.map((c) => (c.type === 'text' ? c.content : '')).join('')).toBe(
      `Mail ${email.slice(0, 4)}`
    );
  });
});

describe('redact', () => {
  it('masks, never restores, and leaves text that only looks like a placeholder as written', async () => {
    mode('redact');
    const args = [
      [{ role: 'user', content: `I'm ${NAME} (${EMAIL}). The form says [PERSON_2].` }],
      { model: 'm' },
    ];
    const { result, scope } = await inScope(() => applyPrivacyStage(chatCall(args)));
    const sent = JSON.stringify(result.args);
    for (const value of [NAME, EMAIL]) expect(sent).not.toContain(value);
    expect(sent).toContain('[PERSON_2]');
    expect(sent).not.toMatch(/LITERAL/);
    expect(result.restorer).toBeUndefined();
    expect(privacySummary(scope)).toMatchObject({ mode: 'redact', calls: 1 });
  });
});

describe('block', () => {
  it('refuses a chat call with anything found, as privacy_blocked, and puts the reason on the trace', async () => {
    mode('block');
    const { scope } = await inScope(async () => {
      const err = await refusal(applyPrivacyStage(chatCall()));
      expect(err.reason).toBe('content_blocked');
      expect(err.code).toBe(PRIVACY_BLOCKED);
      expect(isRequestFault(err)).toBe(true);
      // The reader is told why, and never a value.
      expect(err.message).toMatch(/personal details/);
      for (const value of SEEDED) expect(err.message).not.toContain(value);
      return undefined;
    });
    expect(privacySummary(scope)).toMatchObject({ mode: 'block', refused: ['content_blocked'] });
  });

  it('says which messages held something, and never what (t-1017)', async () => {
    mode('block');
    const { result: err } = await inScope(() => refusal(applyPrivacyStage(chatCall())));
    // The user's message and the assistant's tool-call arguments; not the
    // system prompt or the tool's result.
    expect(err.found).toEqual({ messageCount: 4, messageIndices: [1, 2] });
    for (const value of SEEDED) expect(JSON.stringify(err.found)).not.toContain(value);
  });

  it('places a name where it was found, not where it was only learned from it (t-1018)', async () => {
    // Tier C learns "Sharma" from the full name in the memory and marks it in
    // the persona too. The persona passes every scan on its own, so only the
    // memory is named: blaming the persona would refuse every turn with
    // nothing for an administrator to change.
    mode('block');
    const args = [
      [
        { role: 'system', content: 'You are the parking desk. Greet Sharma fans warmly.' },
        { role: 'system', content: `- name: ${NAME}` },
        { role: 'user', content: 'Where can I park?' },
      ],
      { model: 'm' },
    ];
    const { result: err } = await inScope(() => refusal(applyPrivacyStage(chatCall(args))));
    expect(err.found).toEqual({ messageCount: 3, messageIndices: [1] });
  });

  it('places by every span when a detector marked them all learned (t-1018)', async () => {
    // Nothing found where it stands leaves nothing to place by: every span
    // places, as before the flag existed, rather than none.
    mode('block');
    registerPrivacyDetector({
      id: 'app.echo',
      egress: 'in_process',
      entityTypes: ['CODE'],
      detect: async ({ text }) => {
        const at = text.indexOf('ZX-41');
        return at === -1
          ? []
          : [{ type: 'CODE', start: at, end: at + 5, confidence: 1, learned: true }];
      },
    });
    const args = [
      [
        { role: 'system', content: 'You help with orders.' },
        { role: 'user', content: 'Where is ZX-41?' },
      ],
      { model: 'm' },
    ];
    const { result: err } = await inScope(() => refusal(applyPrivacyStage(chatCall(args))));
    expect(err.found).toEqual({ messageCount: 2, messageIndices: [1] });
  });

  it('sends a call with nothing found, untouched', async () => {
    mode('block');
    const args = [[{ role: 'user', content: 'What are your opening hours?' }], { model: 'm' }];
    const { result } = await inScope(() => applyPrivacyStage(chatCall(args)));
    expect(result).toEqual({ args });
  });
});

describe('a detector that fails under a masking mode (owner ruling, 2026-11-11)', () => {
  it.each(['pseudonymise', 'redact'])(
    'refuses the call in %s when a required detector fails, rather than send it part-masked',
    async (masking) => {
      mode(masking);
      seam.init.mockImplementation(() => failingDetector(true));
      const { scope } = await inScope(async () => {
        const err = await refusal(applyPrivacyStage(chatCall()));
        expect(err.reason).toBe('detector_failed');
        expect(err.code).toBe(PRIVACY_REFUSED);
        return undefined;
      });
      expect(privacySummary(scope)?.refused).toEqual(['detector_failed']);
    }
  );

  it('refuses under block when a required detector fails, rather than send what it missed', async () => {
    mode('block');
    seam.init.mockImplementation(() => failingDetector(true));
    // Nothing the working detectors find: only the failure stands between
    // this call and the vendor.
    const args = [[{ role: 'user', content: 'What are your opening hours?' }], { model: 'm' }];
    const err = await refusal(applyPrivacyStage(chatCall(args)));
    expect(err.reason).toBe('detector_failed');
  });

  it('goes ahead masked, marked degraded, when only an optional detector fails', async () => {
    seam.init.mockImplementation(() => failingDetector(false));
    const { result, scope } = await inScope(() => applyPrivacyStage(chatCall()));
    const sent = JSON.stringify(result.args);
    for (const value of SEEDED) expect(sent).not.toContain(value);
    expect(privacySummary(scope)).toMatchObject({ degraded: true, failedAdapters: ['app.flaky'] });
  });

  it('still only marks an embedding call degraded: nothing in it is masked either way', async () => {
    seam.init.mockImplementation(() => failingDetector(true));
    const { result, scope } = await inScope(() => applyPrivacyStage(embedCall(false)));
    expect(result.args).toEqual([[NAME]]);
    expect(privacySummary(scope)).toMatchObject({ degraded: true, embeddingCalls: 1 });
  });
});

describe('a call the caller abandons under a masking mode', () => {
  it('throws an abort rather than hand back unscanned arguments, and records nothing', async () => {
    const caller = new AbortController();
    seam.init.mockImplementation(() =>
      registerPrivacyDetector({
        id: 'app.slow',
        egress: 'in_process',
        entityTypes: ['PERSON'],
        detect: (_input, ctx) =>
          new Promise((_resolve, reject) => {
            ctx.signal.addEventListener('abort', () => reject(new Error('aborted')));
            caller.abort();
          }),
      })
    );
    const args = [messages(), { model: 'm', signal: caller.signal }];
    const { result, scope } = await inScope(() =>
      applyPrivacyStage(chatCall(args)).then(
        () => 'sent',
        (e: unknown) => e
      )
    );
    // The shape every shipped provider throws for an aborted request.
    expect(result).toBeInstanceOf(ProviderError);
    expect(result).toMatchObject({ code: 'aborted', retriable: false });
    expect(result).not.toBeInstanceOf(PrivacyRefusedError);
    expect(privacySummary(scope)).toBeUndefined();
  });
});

describe('an error inside the stage', () => {
  it('refuses the call rather than send it unmasked', async () => {
    masking.fail = true;
    const { scope } = await inScope(async () => {
      const err = await refusal(applyPrivacyStage(chatCall()));
      expect(err.reason).toBe('stage_error');
      return undefined;
    });
    expect(privacySummary(scope)?.refused).toEqual(['stage_error']);
  });
});

describe('an unscoped embedding call under a masking mode', () => {
  it('is not scanned when nothing would read it: embeddings are never masked', async () => {
    const detect = vi.fn(async () => []);
    seam.init.mockImplementation(() =>
      registerPrivacyDetector({
        id: 'app.spy',
        egress: 'external',
        entityTypes: ['PERSON'],
        detect,
      })
    );
    await expect(applyPrivacyStage(embedCall(false))).resolves.toEqual({ args: [[NAME]] });
    expect(detect).not.toHaveBeenCalled();

    // A scope reads it, so a scoped one is still counted.
    await inScope(() => applyPrivacyStage(embedCall(false)));
    expect(detect).toHaveBeenCalledTimes(1);
  });
});

describe('embeddings policy local_only', () => {
  it('refuses an embedding call to a provider that is not local, under pseudonymise or stricter', async () => {
    for (const strict of ['pseudonymise', 'redact', 'block']) {
      mode(strict, { privacyEmbeddingsPolicy: 'local_only' });
      const { scope } = await inScope(async () => {
        const err = await refusal(applyPrivacyStage(embedCall(false)));
        expect(isLocalOnlyEmbeddingRefusal(err)).toBe(true);
        // An upload stores this message for the admin: it names the setting.
        expect(err.message).toMatch(/embeddings policy: local only/);
        return undefined;
      });
      expect(privacySummary(scope)?.refused).toEqual(['embeddings_local_only']);
    }
  });

  it('logs the refusal at info, not warn: the configuration is working as chosen', async () => {
    mode('pseudonymise', { privacyEmbeddingsPolicy: 'local_only' });
    await refusal(applyPrivacyStage(embedCall(false)));
    expect(logger.warn).not.toHaveBeenCalledWith(
      'privacy-stage: refusing a provider call',
      expect.anything()
    );
    expect(logger.info).toHaveBeenCalledWith(
      'privacy-stage: refusing a provider call',
      expect.objectContaining({ reason: 'embeddings_local_only' })
    );
  });

  it('sends one to a local provider, and does not touch it', async () => {
    mode('pseudonymise', { privacyEmbeddingsPolicy: 'local_only' });
    const call = embedCall(true);
    await expect(applyPrivacyStage(call)).resolves.toEqual({ args: call.args });
  });

  it('applies only under a masking mode, and never with allow', async () => {
    mode('detect', { privacyEmbeddingsPolicy: 'local_only' });
    await expect(applyPrivacyStage(embedCall(false))).resolves.toMatchObject({
      args: [[NAME]],
    });
    mode('pseudonymise', { privacyEmbeddingsPolicy: 'allow' });
    await expect(applyPrivacyStage(embedCall(false))).resolves.toMatchObject({
      args: [[NAME]],
    });
  });

  it('never refuses a chat call', async () => {
    mode('pseudonymise', { privacyEmbeddingsPolicy: 'local_only' });
    await expect(applyPrivacyStage(chatCall())).resolves.toHaveProperty('restorer');
  });
});
