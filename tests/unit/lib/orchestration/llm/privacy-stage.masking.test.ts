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

import {
  applyPrivacyStage,
  isLocalOnlyEmbeddingRefusal,
  PrivacyRefusedError,
} from '@/lib/orchestration/llm/privacy-stage';
import { isRequestFault, PRIVACY_BLOCKED, PRIVACY_REFUSED } from '@/lib/orchestration/llm/provider';
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
    const { result } = await inScope(() =>
      applyPrivacyStage(chatCall([original, { model: 'm' }]))
    );

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

  it('adds the placeholder instruction to the system prompt once, only when something was masked', async () => {
    const { result } = await inScope(() => applyPrivacyStage(chatCall()));
    const sent = sentMessages(result.args);
    expect(sent[0]).toEqual({
      role: 'system',
      content: `You are a helpful support agent.\n\n${PLACEHOLDER_INSTRUCTION}`,
    });
    expect(JSON.stringify(sent).split(PLACEHOLDER_INSTRUCTION)).toHaveLength(2);

    // Nothing to mask: the very arguments, no line, nothing to restore.
    const clean = [[{ role: 'user', content: 'What are your opening hours?' }], { model: 'm' }];
    const { result: untouched } = await inScope(() => applyPrivacyStage(chatCall(clean)));
    expect(untouched.args).toBe(clean);
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

describe('pseudonymise: what comes back', () => {
  it('restores the reply and a tool call’s arguments, keys included, before the caller sees them', async () => {
    const { result, scope } = await inScope(() => applyPrivacyStage(chatCall()));
    const sent = JSON.stringify(result.args);
    const email = placeholderOf(sent, 'EMAIL');
    const person = placeholderOf(sent, 'PERSON');

    const restored = result.restorer?.response(
      response(`Thanks ${person}, I'll write to ${email}.`, [
        { id: 'c1', name: 'send_email', arguments: { to: email, cc: [email], meta: { [email]: 1 } } },
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
