// @vitest-environment happy-dom

/**
 * EmbeddingStatusBanner Component Tests
 *
 * @see components/admin/orchestration/knowledge/embedding-status-banner.tsx
 */

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';

import { EmbeddingStatusBanner } from '@/components/admin/orchestration/knowledge/embedding-status-banner';

describe('EmbeddingStatusBanner', () => {
  it('renders nothing when total is 0', () => {
    const { container } = render(
      <EmbeddingStatusBanner total={0} embedded={0} hasActiveProvider={false} />
    );
    expect(container.firstChild).toBeNull();
  });

  it('renders nothing when embedded >= total (fully embedded)', () => {
    const { container } = render(
      <EmbeddingStatusBanner total={10} embedded={10} hasActiveProvider={true} />
    );
    expect(container.firstChild).toBeNull();
  });

  it('renders nothing when embedded exceeds total', () => {
    const { container } = render(
      <EmbeddingStatusBanner total={5} embedded={6} hasActiveProvider={true} />
    );
    expect(container.firstChild).toBeNull();
  });

  it('shows "unavailable" copy and provider link when embedded === 0 and no active provider', () => {
    render(<EmbeddingStatusBanner total={20} embedded={0} hasActiveProvider={false} />);

    expect(screen.getByText(/vector search is unavailable/i)).toBeInTheDocument();
    expect(screen.getByText(/0 of 20/i)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /add an embedding provider/i })).toBeInTheDocument();
  });

  it('shows "partially available" copy with fraction when embedded > 0 and hasActiveProvider is true', () => {
    render(<EmbeddingStatusBanner total={20} embedded={8} hasActiveProvider={true} />);

    expect(screen.getByText(/vector search is partially available/i)).toBeInTheDocument();
    expect(screen.getByText(/8 of 20/i)).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /add an embedding provider/i })).toBeNull();
  });

  it('provider-available branch shows "Generate Embeddings" copy without provider link', () => {
    render(<EmbeddingStatusBanner total={10} embedded={3} hasActiveProvider={true} />);

    expect(screen.getByText(/generate embeddings/i)).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /add an embedding provider/i })).toBeNull();
    expect(screen.getByRole('link', { name: /knowledge base/i })).toBeInTheDocument();
  });

  it('shows the step left to take in place of "add a provider" when one is given (t-1011)', () => {
    // A local-only install: telling it to add Voyage or OpenAI would send its
    // text to a cloud vendor.
    render(
      <EmbeddingStatusBanner
        total={10}
        embedded={0}
        hasActiveProvider={false}
        providerState="none_configured"
        setupMessage="The local provider is used only once one of its models is picked."
      />
    );
    expect(
      screen.getByText(/the local provider is used only once one of its models is picked/i)
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /open settings/i })).toHaveAttribute(
      'href',
      '/admin/orchestration/settings'
    );
    expect(screen.queryByRole('link', { name: /add an embedding provider/i })).toBeNull();
  });

  it('keeps "add a provider" when nothing is set up and no step is given', () => {
    render(
      <EmbeddingStatusBanner
        total={10}
        embedded={0}
        hasActiveProvider={false}
        providerState="none_configured"
        setupMessage={null}
      />
    );
    expect(screen.getByRole('link', { name: /add an embedding provider/i })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /open settings/i })).toBeNull();
  });

  it('shows a step left to take even when every chunk is embedded (t-1011)', () => {
    // A search still embeds its query, so it fails too.
    render(
      <EmbeddingStatusBanner
        total={10}
        embedded={10}
        hasActiveProvider={false}
        providerState="none_configured"
        setupMessage="Add or reactivate a provider with that slug."
      />
    );
    expect(
      screen.getByText(/embedding cannot run, so search and new uploads fail/i)
    ).toBeInTheDocument();
    expect(screen.getByText(/add or reactivate a provider with that slug/i)).toBeInTheDocument();
  });
});
