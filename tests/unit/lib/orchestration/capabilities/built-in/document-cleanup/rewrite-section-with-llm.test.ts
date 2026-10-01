/**
 * Unit Tests: RewriteSectionWithLlmCapability
 *
 * Tests for the rewrite_section_with_llm capability. This capability:
 * - Locates a document section by Markdown heading or standalone-line marker.
 * - Sends only the matched section body to the LLM.
 * - Splices the rewritten body back into the document, preserving the
 *   surrounding content and the document's trailing newline if present.
 *
 * Key contracts:
 * - Section-finding: `# Heading` containing the marker → bodyStart is after
 *   the heading line; bodyEnd is at the next heading or EOF.
 * - Section-finding: a standalone line whose trimmed text equals the marker.
 * - The LLM is only sent the section body, not the whole document.
 * - The resulting doc is: content[0:bodyStart] + rewritten + content[bodyEnd:].
 * - Trailing newline is preserved when the original doc ended with \n.
 *
 * @see lib/orchestration/capabilities/built-in/document-cleanup/rewrite-section-with-llm.ts
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

import { RewriteSectionWithLlmCapability } from '@/lib/orchestration/capabilities/built-in/document-cleanup/rewrite-section-with-llm';
import { prisma } from '@/lib/db/client';
import type { CapabilityContext } from '@/lib/orchestration/capabilities/types';
import type { LlmResponse } from '@/lib/orchestration/llm/types';

// ─── Fixtures ───────────────────────────────────────────────────────────────

const DOCUMENT_ID = 'doc-rswl-001';
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
  overrides: {
    provider?: string | null;
    model?: string | null;
    temperature?: number | null;
  } = {}
) {
  return {
    provider: 'anthropic',
    model: 'claude-3-5-haiku-20241022',
    temperature: null,
    ...overrides,
  } as never;
}

function makeLlmResponse(overrides: Partial<LlmResponse> = {}): LlmResponse {
  return {
    content: 'Rewritten section content.',
    usage: { inputTokens: 80, outputTokens: 40 },
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

describe('RewriteSectionWithLlmCapability', () => {
  let capability: RewriteSectionWithLlmCapability;

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
    capability = new RewriteSectionWithLlmCapability();

    // Default: summariseMutation returns real-shaped output so assertions stay meaningful
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
      { sectionMarker: 'Introduction', instructions: 'Clean it up.' },
      makeContext()
    );

    // Assert
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('not_cleanup_session');
    expect(mockWriteCleanupContent).not.toHaveBeenCalled();
    expect(mockGetProvider).not.toHaveBeenCalled();
  });

  // ── section_not_found ────────────────────────────────────────────────────

  it('returns section_not_found when the marker does not match any heading or standalone line', async () => {
    // Arrange: document has no heading or line matching "NonExistent"
    const content = '# Introduction\nSome text here.\n# Conclusion\nFinal thoughts.';
    mockResolveCleanupTarget.mockResolvedValue(makeTarget(content));

    // Act
    const result = await capability.execute(
      { sectionMarker: 'NonExistent', instructions: 'Clean it.' },
      makeContext()
    );

    // Assert
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('section_not_found');
    expect(mockGetProvider).not.toHaveBeenCalled();
    expect(mockWriteCleanupContent).not.toHaveBeenCalled();
  });

  // ── binding resolution ───────────────────────────────────────────────────

  it('rewrites with the RESOLVED binding when the agent row has no provider or model', async () => {
    // Same regression as rewrite_with_llm: the cleanup agent ships with both
    // fields empty, so reading the row directly made this path dead on every
    // default install.
    const content = '# Introduction\nBody text here.';
    mockResolveCleanupTarget.mockResolvedValue(makeTarget(content));
    vi.mocked(prisma.aiAgent.findUnique).mockResolvedValue(
      makeAgentRow({ provider: '', model: '' })
    );
    mockResolveAgentProviderAndModel.mockResolvedValue({
      providerSlug: 'anthropic',
      model: 'claude-sonnet-4',
      fallbacks: [],
      provenance: { task: 'chat', primary: 'primary', fallbacks: 'system' },
    });
    const fakeProvider = makeFakeProvider(makeLlmResponse());
    mockGetProvider.mockResolvedValue(fakeProvider);

    const result = await capability.execute(
      { sectionMarker: 'Introduction', instructions: 'Rewrite it.' },
      makeContext()
    );

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
    const content = '# Introduction\nBody text here.';
    mockResolveCleanupTarget.mockResolvedValue(makeTarget(content));
    vi.mocked(prisma.aiAgent.findUnique).mockResolvedValue(makeAgentRow());
    mockResolveAgentProviderAndModel.mockRejectedValue(
      new Error('No active LLM provider is configured.')
    );

    const result = await capability.execute(
      { sectionMarker: 'Introduction', instructions: 'Rewrite it.' },
      makeContext()
    );

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('agent_misconfigured');
    expect(result.error?.message).toMatch(/deterministic cleanups still work/i);
    expect(mockGetProvider).not.toHaveBeenCalled();
  });

  it('returns agent_misconfigured when the agent row is missing entirely', async () => {
    const content = '# Introduction\nBody text here.';
    mockResolveCleanupTarget.mockResolvedValue(makeTarget(content));
    vi.mocked(prisma.aiAgent.findUnique).mockResolvedValue(null);

    const result = await capability.execute(
      { sectionMarker: 'Introduction', instructions: 'Rewrite it.' },
      makeContext()
    );

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('agent_misconfigured');
    expect(mockGetProvider).not.toHaveBeenCalled();
  });

  // ── provider_unavailable ─────────────────────────────────────────────────

  it('returns provider_unavailable when getProvider throws', async () => {
    // Arrange
    const content = '# Introduction\nBody text here.';
    mockResolveCleanupTarget.mockResolvedValue(makeTarget(content));
    vi.mocked(prisma.aiAgent.findUnique).mockResolvedValue(makeAgentRow());
    mockGetProvider.mockRejectedValue(new Error('Provider not found'));

    // Act
    const result = await capability.execute(
      { sectionMarker: 'Introduction', instructions: 'Rewrite it.' },
      makeContext()
    );

    // Assert
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('provider_unavailable');
    expect(mockWriteCleanupContent).not.toHaveBeenCalled();
  });

  // ── empty_response ───────────────────────────────────────────────────────

  it('returns empty_response when the LLM returns whitespace-only content', async () => {
    // Arrange
    const fakeProvider = makeFakeProvider(makeLlmResponse({ content: '   \n  ' }));
    mockResolveCleanupTarget.mockResolvedValue(
      makeTarget('# Introduction\nOriginal body text.\n# Conclusion\nFinal.')
    );
    vi.mocked(prisma.aiAgent.findUnique).mockResolvedValue(makeAgentRow());
    mockGetProvider.mockResolvedValue(fakeProvider);

    // Act
    const result = await capability.execute(
      { sectionMarker: 'Introduction', instructions: 'Tighten it.' },
      makeContext()
    );

    // Assert
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('empty_response');
    expect(mockWriteCleanupContent).not.toHaveBeenCalled();
  });

  // ── section-finding: Markdown heading ────────────────────────────────────

  it('matches a Markdown heading (# Heading) whose text contains the marker', async () => {
    // Arrange: two-section document with headings
    // "# Introduction\n" = 16 chars = line length 14, bodyStart = 14 + 1 = 15
    // "Body of intro.\n" = 15 chars
    // bodyEnd when "# Conclusion" found = 15 + 14 = 29... computed from lines.slice(1, 2)
    const content = '# Introduction\nBody of intro.\n# Conclusion\nFinal paragraph.';
    const rewritten = 'Improved intro body.';
    const fakeProvider = makeFakeProvider(makeLlmResponse({ content: rewritten }));

    mockResolveCleanupTarget.mockResolvedValue(makeTarget(content));
    vi.mocked(prisma.aiAgent.findUnique).mockResolvedValue(makeAgentRow());
    mockGetProvider.mockResolvedValue(fakeProvider);

    // Act
    const result = await capability.execute(
      { sectionMarker: 'Introduction', instructions: 'Improve the intro.' },
      makeContext()
    );

    // Assert: section was found (capability did not return section_not_found)
    expect(result.success).toBe(true);
    // The written content must have the rewritten body stitched in
    const createCall = vi.mocked(prisma.aiKnowledgeDocumentPendingChange.create).mock.calls[0];
    const writtenContent = (createCall?.[0]?.data as { afterContent?: string })?.afterContent ?? '';
    expect(writtenContent).toContain('Improved intro body.');
    expect(writtenContent).toContain('# Introduction');
    expect(writtenContent).toContain('# Conclusion');
    expect(writtenContent).toContain('Final paragraph.');
  });

  it('locates bodyStart after the heading line and bodyEnd at the next heading', async () => {
    // Arrange: build a known document so we can verify exact content placement
    // "# Section A\n" → heading "# Section A" is 11 chars, bodyStart = 12
    // "Body A text.\n" → 13 chars, then "# Section B"
    // bodyEnd = 12 + "Body A text.".length = 12 + 12 = 24
    const content = '# Section A\nBody A text.\n# Section B\nBody B text.';
    const rewrittenA = 'New body for A.';
    const fakeProvider = makeFakeProvider(makeLlmResponse({ content: rewrittenA }));

    mockResolveCleanupTarget.mockResolvedValue(makeTarget(content));
    vi.mocked(prisma.aiAgent.findUnique).mockResolvedValue(makeAgentRow());
    mockGetProvider.mockResolvedValue(fakeProvider);

    // Act
    await capability.execute(
      { sectionMarker: 'Section A', instructions: 'Rewrite section A.' },
      makeContext()
    );

    // Assert: the written document starts with the heading, then the rewritten body, then B
    const createCall = vi.mocked(prisma.aiKnowledgeDocumentPendingChange.create).mock.calls[0];
    const writtenContent = (createCall?.[0]?.data as { afterContent?: string })?.afterContent ?? '';
    // The heading is preserved before the rewritten body
    expect(writtenContent.startsWith('# Section A\n')).toBe(true);
    expect(writtenContent).toContain('New body for A.');
    // Section B is preserved after the rewrite
    expect(writtenContent).toContain('# Section B\nBody B text.');
    // Original Section A body is gone
    expect(writtenContent).not.toContain('Body A text.');
  });

  // ── section-finding: standalone line ─────────────────────────────────────

  it('matches a standalone line whose trimmed text equals the marker exactly', async () => {
    // Arrange: marker is a standalone plain line (not a Markdown heading)
    const content = 'Preamble paragraph.\nIntroduction\nBody text under the standalone heading.\n';
    const rewritten = 'Cleaner body text.';
    const fakeProvider = makeFakeProvider(makeLlmResponse({ content: rewritten }));

    mockResolveCleanupTarget.mockResolvedValue(makeTarget(content));
    vi.mocked(prisma.aiAgent.findUnique).mockResolvedValue(makeAgentRow());
    mockGetProvider.mockResolvedValue(fakeProvider);

    // Act
    const result = await capability.execute(
      { sectionMarker: 'Introduction', instructions: 'Clean it.' },
      makeContext()
    );

    // Assert: the capability succeeded (not section_not_found)
    expect(result.success).toBe(true);
    // Preamble is preserved before the match
    const createCall = vi.mocked(prisma.aiKnowledgeDocumentPendingChange.create).mock.calls[0];
    const writtenContent = (createCall?.[0]?.data as { afterContent?: string })?.afterContent ?? '';
    expect(writtenContent).toContain('Preamble paragraph.');
    expect(writtenContent).toContain('Introduction');
    expect(writtenContent).toContain('Cleaner body text.');
    // Original body is gone
    expect(writtenContent).not.toContain('Body text under the standalone heading.');
  });

  // ── only the section body is sent to the LLM ────────────────────────────

  it('sends only the matched section body to the LLM, not the entire document', async () => {
    // Arrange: two-section document
    const sectionABody = 'This is section A body only.';
    const sectionBBody = 'This is section B body — must NOT reach the LLM.';
    const content = `# Section A\n${sectionABody}\n# Section B\n${sectionBBody}`;
    const fakeProvider = makeFakeProvider(makeLlmResponse({ content: 'Cleaned A.' }));

    mockResolveCleanupTarget.mockResolvedValue(makeTarget(content));
    vi.mocked(prisma.aiAgent.findUnique).mockResolvedValue(makeAgentRow());
    mockGetProvider.mockResolvedValue(fakeProvider);

    // Act
    await capability.execute(
      { sectionMarker: 'Section A', instructions: 'Improve section A.' },
      makeContext()
    );

    // Assert: the user prompt sent to the LLM contains the section body but NOT section B's content
    const chatCall = fakeProvider.chat.mock.calls[0];
    const messages = chatCall[0] as Array<{ role: string; content: string }>;
    const userMessage = messages.find((m) => m.role === 'user');
    expect(userMessage?.content).toContain(sectionABody);
    // The section B body must not leak into the prompt
    expect(userMessage?.content).not.toContain(sectionBBody);
  });

  // ── doc reconstruction: content[0:bodyStart] + rewritten + content[bodyEnd:] ──

  it('splices the rewritten section into the original document at the correct positions', async () => {
    // Arrange: simple two-section document, rewrite section A
    // heading "# A" = 3 chars, bodyStart = 4, "alpha\n" = 6 chars, then "# B"
    // bodyEnd = 4 + 5 = 9 (lines.slice(i+1, j) = ["alpha"], join length = 5)
    // content[0:4] = "# A\n"
    // content[9:] = "\n# B\nbeta"
    const content = '# A\nalpha\n# B\nbeta';
    const rewritten = 'REWRITTEN';
    const fakeProvider = makeFakeProvider(makeLlmResponse({ content: rewritten }));

    mockResolveCleanupTarget.mockResolvedValue(makeTarget(content));
    vi.mocked(prisma.aiAgent.findUnique).mockResolvedValue(makeAgentRow());
    mockGetProvider.mockResolvedValue(fakeProvider);

    // Act
    await capability.execute({ sectionMarker: 'A', instructions: 'Rewrite it.' }, makeContext());

    // Assert: the prefix (heading + newline) and suffix (next section) are preserved,
    // with only the body replaced
    const createCall = vi.mocked(prisma.aiKnowledgeDocumentPendingChange.create).mock.calls[0];
    const writtenContent = (createCall?.[0]?.data as { afterContent?: string })?.afterContent ?? '';
    expect(writtenContent).toContain('# A\n');
    expect(writtenContent).toContain('REWRITTEN');
    expect(writtenContent).toContain('# B\nbeta');
    // Old body is gone
    expect(writtenContent).not.toContain('alpha');
  });

  // ── trailing newline preservation ─────────────────────────────────────────

  it('appends a trailing newline to the result when the original document ended with \\n', async () => {
    // Arrange: single-section document at EOF, ending with \n
    // The LLM produces trimmed content (no trailing newline)
    const content = '# Only Section\nOriginal body text.\n';
    const rewritten = 'Rewritten body text.'; // no trailing newline
    const fakeProvider = makeFakeProvider(makeLlmResponse({ content: rewritten }));

    mockResolveCleanupTarget.mockResolvedValue(makeTarget(content));
    vi.mocked(prisma.aiAgent.findUnique).mockResolvedValue(makeAgentRow());
    mockGetProvider.mockResolvedValue(fakeProvider);

    // Act
    await capability.execute(
      { sectionMarker: 'Only Section', instructions: 'Rewrite.' },
      makeContext()
    );

    // Assert: the rewritten document ends with \n because the original did
    const createCall = vi.mocked(prisma.aiKnowledgeDocumentPendingChange.create).mock.calls[0];
    const writtenContent = (createCall?.[0]?.data as { afterContent?: string })?.afterContent ?? '';
    expect(writtenContent.endsWith('\n')).toBe(true);
    expect(writtenContent).toContain('Rewritten body text.');
  });

  it('does NOT append a trailing newline when the original document did not end with \\n', async () => {
    // Arrange: single-section document at EOF, no trailing newline
    const content = '# Only Section\nOriginal body text.';
    const rewritten = 'Rewritten body text.';
    const fakeProvider = makeFakeProvider(makeLlmResponse({ content: rewritten }));

    mockResolveCleanupTarget.mockResolvedValue(makeTarget(content));
    vi.mocked(prisma.aiAgent.findUnique).mockResolvedValue(makeAgentRow());
    mockGetProvider.mockResolvedValue(fakeProvider);

    // Act
    await capability.execute(
      { sectionMarker: 'Only Section', instructions: 'Rewrite.' },
      makeContext()
    );

    // Assert: no trailing newline added when original didn't have one
    const createCall = vi.mocked(prisma.aiKnowledgeDocumentPendingChange.create).mock.calls[0];
    const writtenContent = (createCall?.[0]?.data as { afterContent?: string })?.afterContent ?? '';
    expect(writtenContent.endsWith('\n')).toBe(false);
  });

  // ── result data shape ────────────────────────────────────────────────────

  it('returns sectionMarker, instructions, and token counts in result.data', async () => {
    // Arrange
    const sectionMarker = 'Introduction';
    const instructions = 'Tighten this section.';
    const fakeProvider = makeFakeProvider(
      makeLlmResponse({ usage: { inputTokens: 150, outputTokens: 60 } })
    );

    mockResolveCleanupTarget.mockResolvedValue(
      makeTarget('# Introduction\nSome content.\n# Conclusion\nMore content.')
    );
    vi.mocked(prisma.aiAgent.findUnique).mockResolvedValue(makeAgentRow());
    mockGetProvider.mockResolvedValue(fakeProvider);

    // Act
    const result = await capability.execute({ sectionMarker, instructions }, makeContext());

    // Assert
    expect(result.success).toBe(true);
    expect(result.data?.sectionMarker).toBe(sectionMarker);
    expect(result.data?.instructions).toBe(instructions);
    expect(result.data?.inputTokens).toBe(150);
    expect(result.data?.outputTokens).toBe(60);
  });

  // ── temperature fallback ─────────────────────────────────────────────────

  it('falls back to temperature 0.2 when agent.temperature is null', async () => {
    // Arrange
    const fakeProvider = makeFakeProvider(makeLlmResponse());
    mockResolveCleanupTarget.mockResolvedValue(makeTarget('# Section\nContent.'));
    vi.mocked(prisma.aiAgent.findUnique).mockResolvedValue(makeAgentRow({ temperature: null }));
    mockGetProvider.mockResolvedValue(fakeProvider);

    // Act
    await capability.execute({ sectionMarker: 'Section', instructions: 'Rewrite.' }, makeContext());

    // Assert: null temperature defaults to 0.2
    expect(fakeProvider.chat).toHaveBeenCalledWith(
      expect.any(Array),
      expect.objectContaining({ temperature: 0.2 })
    );
  });

  it('uses agent.temperature when explicitly set', async () => {
    // Arrange
    const fakeProvider = makeFakeProvider(makeLlmResponse());
    mockResolveCleanupTarget.mockResolvedValue(makeTarget('# Section\nContent.'));
    vi.mocked(prisma.aiAgent.findUnique).mockResolvedValue(makeAgentRow({ temperature: 0.5 }));
    mockGetProvider.mockResolvedValue(fakeProvider);

    // Act
    await capability.execute({ sectionMarker: 'Section', instructions: 'Rewrite.' }, makeContext());

    // Assert: agent's configured temperature is used, not the fallback
    expect(fakeProvider.chat).toHaveBeenCalledWith(
      expect.any(Array),
      expect.objectContaining({ temperature: 0.5 })
    );
  });
});
