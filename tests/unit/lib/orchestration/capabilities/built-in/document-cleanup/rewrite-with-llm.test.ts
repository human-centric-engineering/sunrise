/**
 * Unit Tests: RewriteWithLlmCapability
 *
 * Tests for the rewrite_with_llm capability. This capability:
 * - Guards against non-cleanup sessions and too-large documents.
 * - Looks up the agent's provider + model from the DB.
 * - Calls the LLM provider with a system prompt, the user instructions,
 *   and the full document content.
 * - Writes the trimmed LLM response to processedContent.
 * - Returns input/output token counts + MutationSummary.
 *
 * @see lib/orchestration/capabilities/built-in/document-cleanup/rewrite-with-llm.ts
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ─── Mocks ──────────────────────────────────────────────────────────────────

// vi.mock is hoisted — use vi.hoisted() so mock fn refs exist before the factory runs.
const { mockResolveCleanupTarget, mockWriteCleanupContent, mockSummariseMutation } = vi.hoisted(
  () => ({
    mockResolveCleanupTarget: vi.fn(),
    mockWriteCleanupContent: vi.fn(),
    mockSummariseMutation: vi.fn(),
  })
);

vi.mock('@/lib/orchestration/capabilities/built-in/document-cleanup/context', () => ({
  resolveCleanupTarget: mockResolveCleanupTarget,
  writeCleanupContent: mockWriteCleanupContent,
  summariseMutation: mockSummariseMutation,
}));

const { mockRequireEditableTarget } = vi.hoisted(() => ({
  mockRequireEditableTarget: vi.fn(),
}));

vi.mock('@/lib/orchestration/knowledge/edit-lock', () => ({
  requireEditableTarget: mockRequireEditableTarget,
}));

const { mockGetDocumentSizeReport } = vi.hoisted(() => ({
  mockGetDocumentSizeReport: vi.fn(),
}));

vi.mock('@/lib/orchestration/knowledge/size-report', () => ({
  getDocumentSizeReport: mockGetDocumentSizeReport,
}));

vi.mock('@/lib/db/client', () => ({
  prisma: {
    aiAgent: {
      findUnique: vi.fn(),
    },
    aiKnowledgeDocumentPendingChange: {
      create: vi
        .fn()
        .mockImplementation(({ data }: { data: Record<string, unknown> }) =>
          Promise.resolve({ id: 'pending-id-1', ...data })
        ),
    },
  },
}));

const { mockGetProvider } = vi.hoisted(() => ({
  mockGetProvider: vi.fn(),
}));

vi.mock('@/lib/orchestration/llm/provider-manager', () => ({
  getProvider: mockGetProvider,
}));

// The capability resolves its binding through the same seam the chat loop
// uses, because the cleanup agent ships with provider/model EMPTY. Mocked so
// these tests state what binding came back rather than what the row held.
const { mockResolveAgentProviderAndModel } = vi.hoisted(() => ({
  mockResolveAgentProviderAndModel: vi.fn(),
}));

vi.mock('@/lib/orchestration/llm/agent-resolver', () => ({
  resolveAgentProviderAndModel: mockResolveAgentProviderAndModel,
}));

vi.mock('@/lib/logging', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

// ─── Imports ────────────────────────────────────────────────────────────────

import { RewriteWithLlmCapability } from '@/lib/orchestration/capabilities/built-in/document-cleanup/rewrite-with-llm';
import { prisma } from '@/lib/db/client';
import type { CapabilityContext } from '@/lib/orchestration/capabilities/types';
import type { LlmResponse } from '@/lib/orchestration/llm/types';

// ─── Fixtures ───────────────────────────────────────────────────────────────

const DOCUMENT_ID = 'doc-rwl-001';
const AGENT_ID = 'agent-001';

function makeContext(overrides: Partial<CapabilityContext> = {}): CapabilityContext {
  return {
    userId: 'user-1',
    agentId: AGENT_ID,
    conversationId: 'conv-1',
    ...overrides,
  };
}

function makeTarget(content: string) {
  return {
    documentId: DOCUMENT_ID,
    content,
    originalContent: content,
  };
}

function makeAgentRow(
  overrides: { provider?: string | null; model?: string | null; temperature?: number | null } = {}
) {
  return {
    provider: 'anthropic',
    model: 'claude-3-5-haiku-20241022',
    temperature: null,
    ...overrides,
  } as never;
}

function makeSizeReport(llmRewriteAllowed = true) {
  return {
    tokenCount: llmRewriteAllowed ? 5_000 : 120_000,
    sizeClass: llmRewriteAllowed ? 'small' : 'too-large',
    llmRewriteAllowed,
  };
}

function makeLlmResponse(overrides: Partial<LlmResponse> = {}): LlmResponse {
  return {
    content: 'Cleaned document content.',
    usage: { inputTokens: 100, outputTokens: 50 },
    model: 'claude-3-5-haiku-20241022',
    finishReason: 'stop',
    ...overrides,
  };
}

function makeFakeProvider(chatResponse: LlmResponse) {
  return {
    chat: vi.fn().mockResolvedValue(chatResponse),
  };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('RewriteWithLlmCapability', () => {
  let capability: RewriteWithLlmCapability;

  beforeEach(() => {
    vi.clearAllMocks();
    mockRequireEditableTarget.mockResolvedValue({ ok: true });
    // Default: the resolver hands back a usable binding, as it does whenever
    // the install has any reachable provider.
    mockResolveAgentProviderAndModel.mockResolvedValue({
      providerSlug: 'openai',
      model: 'gpt-4.1',
      fallbacks: [],
    });
    capability = new RewriteWithLlmCapability();

    // Default: summariseMutation returns a real-shaped summary from actual inputs
    mockSummariseMutation.mockImplementation((before: string, after: string) => ({
      charsRemoved: before.length - after.length,
      charsAfter: after.length,
      linesRemoved: before.split('\n').length - after.split('\n').length,
      linesAfter: after.split('\n').length,
    }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── not_cleanup_session ──────────────────────────────────────────────────

  it('returns not_cleanup_session error when resolveCleanupTarget returns null', async () => {
    // Arrange
    mockResolveCleanupTarget.mockResolvedValue(null);

    // Act
    const result = await capability.execute(
      { instructions: 'Remove filler words.' },
      makeContext()
    );

    // Assert
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('not_cleanup_session');
    expect(mockWriteCleanupContent).not.toHaveBeenCalled();
    expect(mockGetProvider).not.toHaveBeenCalled();
  });

  // ── document_too_large ───────────────────────────────────────────────────

  it('returns document_too_large when size report shows llmRewriteAllowed is false', async () => {
    // Arrange
    mockResolveCleanupTarget.mockResolvedValue(makeTarget('very large document'));
    mockGetDocumentSizeReport.mockReturnValue(makeSizeReport(false));

    // Act
    const result = await capability.execute({ instructions: 'Summarise.' }, makeContext());

    // Assert: error code must be document_too_large, not a generic failure
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('document_too_large');
    // Critical: no LLM call was made when the doc is too large
    expect(mockGetProvider).not.toHaveBeenCalled();
    expect(mockWriteCleanupContent).not.toHaveBeenCalled();
  });

  // ── binding resolution ───────────────────────────────────────────────────

  it('rewrites with the RESOLVED binding when the agent row has no provider or model', async () => {
    // The regression this guards: the cleanup agent is seeded with both
    // fields empty so it inherits the install's binding, and this capability
    // used to read the row directly and bail — making the whole LLM half of
    // Document Clean Up permanently unavailable on a default install.
    mockResolveCleanupTarget.mockResolvedValue(makeTarget('doc content'));
    mockGetDocumentSizeReport.mockReturnValue(makeSizeReport(true));
    vi.mocked(prisma.aiAgent.findUnique).mockResolvedValue(
      makeAgentRow({ provider: '', model: '' })
    );
    const fakeProvider = makeFakeProvider(makeLlmResponse());
    mockGetProvider.mockResolvedValue(fakeProvider);
    mockResolveAgentProviderAndModel.mockResolvedValue({
      providerSlug: 'anthropic',
      model: 'claude-sonnet-4',
      fallbacks: [],
      provenance: { task: 'chat', primary: 'primary', fallbacks: 'system' },
    });

    const result = await capability.execute({ instructions: 'Clean it up.' }, makeContext());

    expect(result.success).toBe(true);
    // Fetched with the binding's primary provenance, for the call-time gate.
    expect(mockGetProvider).toHaveBeenCalledWith('anthropic', {
      task: 'chat',
      source: 'primary',
      primarySlug: null,
    });
    expect(fakeProvider.chat).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ model: 'claude-sonnet-4' })
    );
  });

  it('returns agent_misconfigured when no provider is configured for the install', async () => {
    mockResolveCleanupTarget.mockResolvedValue(makeTarget('doc content'));
    mockGetDocumentSizeReport.mockReturnValue(makeSizeReport(true));
    vi.mocked(prisma.aiAgent.findUnique).mockResolvedValue(makeAgentRow());
    mockResolveAgentProviderAndModel.mockRejectedValue(
      new Error('No active LLM provider is configured.')
    );

    const result = await capability.execute({ instructions: 'Clean it up.' }, makeContext());

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('agent_misconfigured');
    // The message has to tell the admin deterministic cleanups still work —
    // the agent relays it verbatim into the chat.
    expect(result.error?.message).toMatch(/deterministic cleanups still work/i);
    expect(mockGetProvider).not.toHaveBeenCalled();
  });

  it('returns agent_misconfigured when the agent row is missing entirely', async () => {
    mockResolveCleanupTarget.mockResolvedValue(makeTarget('doc content'));
    mockGetDocumentSizeReport.mockReturnValue(makeSizeReport(true));
    vi.mocked(prisma.aiAgent.findUnique).mockResolvedValue(null);

    const result = await capability.execute({ instructions: 'Clean it up.' }, makeContext());

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('agent_misconfigured');
    expect(mockGetProvider).not.toHaveBeenCalled();
  });

  // ── provider_unavailable ─────────────────────────────────────────────────

  it('returns provider_unavailable when getProvider throws', async () => {
    // Arrange
    mockResolveCleanupTarget.mockResolvedValue(makeTarget('doc content'));
    mockGetDocumentSizeReport.mockReturnValue(makeSizeReport(true));
    vi.mocked(prisma.aiAgent.findUnique).mockResolvedValue(makeAgentRow());
    mockGetProvider.mockRejectedValue(new Error('Provider config missing'));

    // Act
    const result = await capability.execute({ instructions: 'Tighten sentences.' }, makeContext());

    // Assert
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('provider_unavailable');
    expect(mockWriteCleanupContent).not.toHaveBeenCalled();
  });

  // ── empty_response ───────────────────────────────────────────────────────

  it('returns empty_response when the LLM returns whitespace-only content', async () => {
    // Arrange
    const fakeProvider = makeFakeProvider(makeLlmResponse({ content: '   \n  \t  ' }));
    mockResolveCleanupTarget.mockResolvedValue(makeTarget('doc content'));
    mockGetDocumentSizeReport.mockReturnValue(makeSizeReport(true));
    vi.mocked(prisma.aiAgent.findUnique).mockResolvedValue(makeAgentRow());
    mockGetProvider.mockResolvedValue(fakeProvider);

    // Act
    const result = await capability.execute({ instructions: 'Rewrite.' }, makeContext());

    // Assert
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('empty_response');
    // No write should happen for empty content
    expect(mockWriteCleanupContent).not.toHaveBeenCalled();
  });

  // ── happy path ───────────────────────────────────────────────────────────

  it('calls getProvider with the resolved provider slug then calls provider.chat with system + user messages', async () => {
    // Arrange
    const docContent = 'The original document text.';
    const instructions = 'Remove all filler words.';
    const llmResponse = makeLlmResponse({
      content: 'The cleaned text.',
      usage: { inputTokens: 200, outputTokens: 80 },
    });
    const fakeProvider = makeFakeProvider(llmResponse);

    mockResolveCleanupTarget.mockResolvedValue(makeTarget(docContent));
    mockGetDocumentSizeReport.mockReturnValue(makeSizeReport(true));
    vi.mocked(prisma.aiAgent.findUnique).mockResolvedValue(
      makeAgentRow({ provider: 'anthropic', model: 'claude-3-5-haiku-20241022' })
    );
    // An explicitly-bound agent resolves to its own provider/model — the
    // resolver returns them unchanged.
    mockResolveAgentProviderAndModel.mockResolvedValue({
      providerSlug: 'anthropic',
      model: 'claude-3-5-haiku-20241022',
      fallbacks: [],
      provenance: { task: 'chat', primary: 'explicit', fallbacks: 'explicit' },
    });
    mockGetProvider.mockResolvedValue(fakeProvider);

    // Act
    const result = await capability.execute({ instructions }, makeContext());

    // Assert: provider was fetched by the RESOLVED slug
    // Fetched with the binding's primary provenance, for the call-time gate.
    expect(mockGetProvider).toHaveBeenCalledWith('anthropic', {
      task: 'chat',
      source: 'explicit',
      primarySlug: null,
    });
    // Provider.chat was called with a 2-message array
    expect(fakeProvider.chat).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ role: 'system' }),
        expect.objectContaining({ role: 'user' }),
      ]),
      expect.objectContaining({ model: 'claude-3-5-haiku-20241022' })
    );
    // The user prompt must contain BOTH the instructions AND the document content
    const chatCall = fakeProvider.chat.mock.calls[0];
    const userMessage = (chatCall[0] as Array<{ role: string; content: string }>).find(
      (m) => m.role === 'user'
    );
    expect(userMessage?.content).toContain(instructions);
    expect(userMessage?.content).toContain(docContent);

    expect(result.success).toBe(true);
  });

  it('emits a pending change with the trimmed LLM response as afterContent', async () => {
    // Mixed agent/human model — LLM rewrites no longer auto-apply. The
    // capability writes a pending change instead. Assert the trimmed content
    // lands in the pending row's afterContent.
    const rawLlmContent = '  \n Cleaned document. \n  ';
    const expectedTrimmed = 'Cleaned document.';
    const fakeProvider = makeFakeProvider(makeLlmResponse({ content: rawLlmContent }));

    mockResolveCleanupTarget.mockResolvedValue(makeTarget('Original text.'));
    mockGetDocumentSizeReport.mockReturnValue(makeSizeReport(true));
    vi.mocked(prisma.aiAgent.findUnique).mockResolvedValue(makeAgentRow());
    mockGetProvider.mockResolvedValue(fakeProvider);

    const result = await capability.execute({ instructions: 'Clean it.' }, makeContext());

    expect(result.success).toBe(true);
    expect(mockWriteCleanupContent).not.toHaveBeenCalled();
    expect(prisma.aiKnowledgeDocumentPendingChange.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        documentId: DOCUMENT_ID,
        source: 'rewrite_with_llm',
        beforeContent: 'Original text.',
        afterContent: expectedTrimmed,
        instructions: 'Clean it.',
      }),
    });
    if (result.success && result.data) {
      expect(result.data.pendingChangeId).toBe('pending-id-1');
      expect(result.data.status).toBe('pending_human_review');
    }
  });

  it('returns input and output token counts from the LLM response', async () => {
    // Arrange
    const fakeProvider = makeFakeProvider(
      makeLlmResponse({ usage: { inputTokens: 350, outputTokens: 120 } })
    );
    mockResolveCleanupTarget.mockResolvedValue(makeTarget('Source document content.'));
    mockGetDocumentSizeReport.mockReturnValue(makeSizeReport(true));
    vi.mocked(prisma.aiAgent.findUnique).mockResolvedValue(makeAgentRow());
    mockGetProvider.mockResolvedValue(fakeProvider);

    // Act
    const result = await capability.execute({ instructions: 'Tighten sentences.' }, makeContext());

    // Assert: token counts come from the LLM response, passed through to the result
    expect(result.success).toBe(true);
    expect(result.data?.inputTokens).toBe(350);
    expect(result.data?.outputTokens).toBe(120);
  });

  it('echoes back the instructions in result.data', async () => {
    // Arrange
    const instructions = 'Remove all filler words and repetition.';
    const fakeProvider = makeFakeProvider(makeLlmResponse());
    mockResolveCleanupTarget.mockResolvedValue(makeTarget('Some content.'));
    mockGetDocumentSizeReport.mockReturnValue(makeSizeReport(true));
    vi.mocked(prisma.aiAgent.findUnique).mockResolvedValue(makeAgentRow());
    mockGetProvider.mockResolvedValue(fakeProvider);

    // Act
    const result = await capability.execute({ instructions }, makeContext());

    // Assert
    expect(result.success).toBe(true);
    expect(result.data?.instructions).toBe(instructions);
  });

  // ── temperature fallback ─────────────────────────────────────────────────

  it('uses agent.temperature when set', async () => {
    // Arrange
    const fakeProvider = makeFakeProvider(makeLlmResponse());
    mockResolveCleanupTarget.mockResolvedValue(makeTarget('Doc content.'));
    mockGetDocumentSizeReport.mockReturnValue(makeSizeReport(true));
    vi.mocked(prisma.aiAgent.findUnique).mockResolvedValue(makeAgentRow({ temperature: 0.7 }));
    mockGetProvider.mockResolvedValue(fakeProvider);

    // Act
    await capability.execute({ instructions: 'Do something.' }, makeContext());

    // Assert: agent.temperature (0.7) was passed to provider.chat — not the fallback 0.2
    expect(fakeProvider.chat).toHaveBeenCalledWith(
      expect.any(Array),
      expect.objectContaining({ temperature: 0.7 })
    );
  });

  it('falls back to temperature 0.2 when agent.temperature is null', async () => {
    // Arrange
    const fakeProvider = makeFakeProvider(makeLlmResponse());
    mockResolveCleanupTarget.mockResolvedValue(makeTarget('Doc content.'));
    mockGetDocumentSizeReport.mockReturnValue(makeSizeReport(true));
    vi.mocked(prisma.aiAgent.findUnique).mockResolvedValue(makeAgentRow({ temperature: null }));
    mockGetProvider.mockResolvedValue(fakeProvider);

    // Act
    await capability.execute({ instructions: 'Do something.' }, makeContext());

    // Assert: null temperature must fall back to 0.2 — not be passed as null
    expect(fakeProvider.chat).toHaveBeenCalledWith(
      expect.any(Array),
      expect.objectContaining({ temperature: 0.2 })
    );
  });

  // ── agent lookup uses agentId from context ───────────────────────────────

  it('queries prisma.aiAgent with the agentId from the context', async () => {
    // Arrange
    const fakeProvider = makeFakeProvider(makeLlmResponse());
    mockResolveCleanupTarget.mockResolvedValue(makeTarget('Content.'));
    mockGetDocumentSizeReport.mockReturnValue(makeSizeReport(true));
    vi.mocked(prisma.aiAgent.findUnique).mockResolvedValue(makeAgentRow());
    mockGetProvider.mockResolvedValue(fakeProvider);

    const context = makeContext({ agentId: 'agent-xyz-999' });

    // Act
    await capability.execute({ instructions: 'Clean.' }, context);

    // Assert: the capability uses context.agentId — not a hardcoded value
    expect(prisma.aiAgent.findUnique).toHaveBeenCalledWith({
      where: { id: 'agent-xyz-999' },
      select: {
        provider: true,
        model: true,
        temperature: true,
        fallbackProviders: true,
      },
    });
  });
});
