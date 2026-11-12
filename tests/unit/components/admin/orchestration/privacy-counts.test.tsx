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
    expect(line).toHaveTextContent('Privacy (detect): 1 EMAIL · 3 PERSON found across 2 calls');
    expect(line).toHaveTextContent('embeddings: 1 PERSON found across 1 call');
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
    expect(line).toHaveTextContent('nothing found across 1 call');
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
    expect(line).toHaveTextContent('Privacy (detect): embeddings: 2 PERSON found across 1 call');
    expect(line).not.toHaveTextContent('0 calls');
  });
});

describe('PrivacyCounts refusals, unresolved placeholders and verbs', () => {
  const base: PrivacySummary = {
    mode: 'detect',
    calls: 1,
    counts: { PERSON: 1 },
    embeddingCalls: 0,
    embeddingCounts: {},
  };

  it('spells a known refusal reason out', () => {
    render(<PrivacyCounts summary={{ ...base, refused: ['content_blocked'] }} />);
    expect(screen.getByTestId('privacy-refused')).toHaveTextContent(
      'refused: personal data found (block mode)'
    );
  });

  it('shows an unknown reason as itself, and joins several', () => {
    render(
      <PrivacyCounts summary={{ ...base, refused: ['content_blocked', 'brand_new_reason'] }} />
    );
    expect(screen.getByTestId('privacy-refused')).toHaveTextContent(
      'personal data found (block mode); brand_new_reason'
    );
  });

  it('does not treat an inherited property name as a known reason', () => {
    render(<PrivacyCounts summary={{ ...base, refused: ['toString'] }} />);
    expect(screen.getByTestId('privacy-refused')).toHaveTextContent('refused: toString');
  });

  it('shows no refusal text when none were refused', () => {
    render(<PrivacyCounts summary={{ ...base, refused: [] }} />);
    expect(screen.queryByTestId('privacy-refused')).toBeNull();
  });

  it('pluralises unresolved placeholders, and omits the clause for zero or absent', () => {
    const { rerender } = render(<PrivacyCounts summary={{ ...base, unresolved: 2 }} />);
    expect(screen.getByTestId('privacy-counts')).toHaveTextContent(
      '2 placeholders left unrestored'
    );
    rerender(<PrivacyCounts summary={{ ...base, unresolved: 1 }} />);
    expect(screen.getByTestId('privacy-counts')).toHaveTextContent('1 placeholder left unrestored');
    expect(screen.getByTestId('privacy-counts')).not.toHaveTextContent('placeholders left');
    rerender(<PrivacyCounts summary={{ ...base, unresolved: 0 }} />);
    expect(screen.getByTestId('privacy-counts')).not.toHaveTextContent('unrestored');
    rerender(<PrivacyCounts summary={base} />);
    expect(screen.getByTestId('privacy-counts')).not.toHaveTextContent('unrestored');
  });

  // The mode is the strictest any call in the scope ran under, so a verb
  // read from it ("masked") would overclaim for a scope that mixed modes.
  it.each(['pseudonymise', 'redact', 'detect', 'block'] as const)(
    'mode %s says what was found, never claiming it was masked',
    (mode) => {
      render(<PrivacyCounts summary={{ ...base, mode }} />);
      const line = screen.getByTestId('privacy-counts');
      expect(line).toHaveTextContent('1 PERSON found across 1 call');
      expect(line).not.toHaveTextContent('masked');
    }
  );

  it('reads "no call sent" for a refusal with no calls scanned', () => {
    render(
      <PrivacyCounts
        summary={{ ...base, mode: 'block', calls: 0, counts: {}, refused: ['content_blocked'] }}
      />
    );
    expect(screen.getByTestId('privacy-counts')).toHaveTextContent('Privacy (block): no call sent');
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
