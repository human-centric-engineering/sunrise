// @vitest-environment happy-dom

/**
 * ProviderDetectionsBanner — failed Configure (§124)
 *
 * A refused Configure shows the server's own message in the box above the
 * detected rows and takes focus; it used to show a fixed message in the row.
 *
 * @see components/admin/orchestration/provider-detections-banner.tsx
 * @see .context/ui/form-errors.md
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { ProviderDetectionsBanner } from '@/components/admin/orchestration/provider-detections-banner';

const DETECTION = {
  slug: 'anthropic',
  name: 'Anthropic',
  providerType: 'anthropic',
  defaultBaseUrl: null,
  apiKeyEnvVar: 'ANTHROPIC_API_KEY',
  primaryEnvVar: 'ANTHROPIC_API_KEY',
  apiKeyPresent: true,
  alreadyConfigured: false,
  isLocal: false,
  suggestedDefaultChatModel: null,
  suggestedRoutingModel: null,
  suggestedReasoningModel: null,
  suggestedEmbeddingModel: null,
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('ProviderDetectionsBanner — failed Configure', () => {
  beforeEach(() => {
    Element.prototype.scrollIntoView = vi.fn();
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string, init?: RequestInit) => {
        if (url.includes('/providers/detect')) {
          return Promise.resolve(json({ success: true, data: { detected: [DETECTION] } }));
        }
        if (init?.method === 'POST') {
          return Promise.resolve(
            json(
              {
                success: false,
                error: { code: 'CONFLICT', message: 'A provider with slug "anthropic" exists' },
              },
              409
            )
          );
        }
        return Promise.resolve(json({ success: true, data: {} }));
      })
    );
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("shows the server's message above the rows and focuses it", async () => {
    const user = userEvent.setup();
    render(<ProviderDetectionsBanner />);

    await user.click(await screen.findByRole('button', { name: /^configure$/i }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(
      'Couldn\'t configure "Anthropic": A provider with slug "anthropic" exists'
    );
    expect(alert.nextElementSibling).toHaveTextContent('Anthropic');
    expect(alert).toHaveFocus();
  });
});
