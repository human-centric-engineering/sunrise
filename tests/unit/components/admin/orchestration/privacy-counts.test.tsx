// @vitest-environment happy-dom

/**
 * Tests: the privacy counts line on the conversation and execution traces (§127).
 */
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';

import { PrivacyCounts } from '@/components/admin/orchestration/privacy-counts';
import { ConversationTraceViewer } from '@/components/admin/orchestration/conversation-trace-viewer';
import type { PrivacySummary } from '@/types/orchestration';

const SUMMARY: PrivacySummary = {
  mode: 'detect',
  calls: 2,
  counts: { PERSON: 3, EMAIL: 1 },
  embeddingCalls: 1,
  embeddingCounts: { PERSON: 1 },
};

describe('PrivacyCounts', () => {
  it('shows the mode, the counts by type and the calls, chat and embeddings apart', () => {
    render(<PrivacyCounts summary={SUMMARY} />);
    const line = screen.getByTestId('privacy-counts');
    expect(line).toHaveTextContent('Privacy (detect): 1 EMAIL · 3 PERSON sent across 2 calls');
    expect(line).toHaveTextContent('embeddings: 1 PERSON sent across 1 call');
    expect(line).not.toHaveTextContent('degraded');
  });

  it('says when nothing was found, and when a call went ahead degraded', () => {
    render(
      <PrivacyCounts
        summary={{
          ...SUMMARY,
          calls: 1,
          counts: {},
          embeddingCalls: 0,
          embeddingCounts: {},
          degraded: true,
          failedAdapters: ['core.lists'],
        }}
      />
    );
    const line = screen.getByTestId('privacy-counts');
    expect(line).toHaveTextContent('nothing sent across 1 call');
    expect(line).toHaveTextContent('degraded (core.lists)');
    expect(line).not.toHaveTextContent('embeddings');
  });
});

describe('PrivacyCounts with only embedding calls', () => {
  it('leaves out the chat clause rather than say nothing was sent', () => {
    render(
      <PrivacyCounts
        summary={{
          ...SUMMARY,
          calls: 0,
          counts: {},
          embeddingCalls: 1,
          embeddingCounts: { PERSON: 2 },
        }}
      />
    );
    const line = screen.getByTestId('privacy-counts');
    expect(line).toHaveTextContent('Privacy (detect): embeddings: 2 PERSON sent across 1 call');
    expect(line).not.toHaveTextContent('0 calls');
  });
});

describe('the conversation trace', () => {
  function message(metadata: Record<string, unknown> | null) {
    return {
      id: 'm1',
      role: 'assistant',
      content: 'Hello',
      capabilitySlug: null,
      toolCallId: null,
      metadata,
      provenance: null,
      modelId: 'm',
      providerSlug: 'openai',
      agentVersionId: null,
      workflowExecutionId: null,
      workflowVersionId: null,
      createdAt: new Date().toISOString(),
    };
  }

  it("shows an assistant message's privacy counts", () => {
    render(<ConversationTraceViewer messages={[message({ privacy: SUMMARY })]} />);
    expect(screen.getByTestId('privacy-counts')).toHaveTextContent('3 PERSON');
  });

  it('shows nothing for a message without counts, or with malformed ones', () => {
    render(
      <ConversationTraceViewer
        messages={[message(null), message({ privacy: { mode: 'detect', calls: 'x' } })]}
      />
    );
    expect(screen.queryByTestId('privacy-counts')).toBeNull();
  });
});
