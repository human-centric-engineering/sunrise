// @vitest-environment happy-dom

/**
 * SetupWizard provider step — failed create (§124)
 *
 * A refused provider create shows the server's own message (it used to be
 * thrown away for a fixed one): above the detected providers for a one-click
 * configure, and directly above the buttons on the manual form.
 *
 * @see components/admin/orchestration/setup-wizard.tsx
 * @see .context/ui/form-errors.md
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { SetupWizard } from '@/components/admin/orchestration/setup-wizard';
import { seedStorage } from '@/tests/unit/components/admin/orchestration/setup-wizard.helpers';

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

describe('SetupWizard provider step — failed create', () => {
  beforeEach(() => {
    window.localStorage.clear();
    seedStorage(0);
    Element.prototype.scrollIntoView = vi.fn();
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string, init?: RequestInit) => {
        if (url.includes('/providers/detect')) {
          return Promise.resolve(json({ success: true, data: { detected: [DETECTION] } }));
        }
        if (init?.method === 'POST' && url.includes('/providers')) {
          return Promise.resolve(
            json(
              {
                success: false,
                error: { code: 'CONFLICT', message: 'Slug "anthropic" is already taken' },
              },
              409
            )
          );
        }
        return Promise.resolve(
          json({ success: true, data: [], meta: { page: 1, limit: 1, total: 0, totalPages: 0 } })
        );
      })
    );
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    window.localStorage.clear();
  });

  it("shows the server's message above the detected providers and focuses it", async () => {
    const user = userEvent.setup();
    render(<SetupWizard open={true} onOpenChange={() => {}} />);

    const card = await screen.findByRole('button', { name: /Anthropic/ });
    await user.click(card);

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(
      'Couldn\'t configure "Anthropic": Slug "anthropic" is already taken'
    );
    expect(alert.nextElementSibling).toContainElement(card);
    expect(alert).toHaveFocus();
  });

  it("shows the server's message above the manual form's buttons", async () => {
    const user = userEvent.setup();
    render(<SetupWizard open={true} onOpenChange={() => {}} />);

    await user.click(await screen.findByRole('button', { name: /configure manually instead/i }));
    await user.click(screen.getByRole('combobox', { name: /provider type/i }));
    await user.click(screen.getByRole('option', { name: /anthropic/i }));
    await user.type(document.getElementById('provider-name')!, 'Anthropic');
    await user.type(document.getElementById('provider-slug')!, 'anthropic');
    const create = screen.getByRole('button', { name: /create provider/i });
    await user.click(create);

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Slug "anthropic" is already taken');
    expect(alert.nextElementSibling).toContainElement(create);
    expect(alert).toHaveFocus();
  });

  describe("the manual form's own checks, now the browser's are off (t-964)", () => {
    const posted = () =>
      vi
        .mocked(fetch)
        .mock.calls.filter(
          ([url, init]) =>
            init?.method === 'POST' && typeof url === 'string' && url.includes('/providers')
        );

    async function openManual(user: ReturnType<typeof userEvent.setup>, type: RegExp) {
      render(<SetupWizard open={true} onOpenChange={() => {}} />);
      await user.click(await screen.findByRole('button', { name: /configure manually instead/i }));
      await user.click(screen.getByRole('combobox', { name: /provider type/i }));
      await user.click(screen.getByRole('option', { name: type }));
    }

    it('blocks a blank name and a slug outside [a-z0-9-] by Save, focused on Name, before any request', async () => {
      const user = userEvent.setup();
      await openManual(user, /anthropic/i);
      await user.type(document.getElementById('provider-slug')!, 'Anthropic Prod');

      const create = screen.getByRole('button', { name: /create provider/i });
      await user.click(create);

      const alert = await screen.findByRole('alert');
      expect(alert).toHaveTextContent(
        'Name is required. Slug must be lowercase letters, numbers and hyphens.'
      );
      expect(alert.nextElementSibling).toContainElement(create);
      await waitFor(() => expect(document.getElementById('provider-name')).toHaveFocus());
      expect(posted()).toEqual([]);
    });

    it('blocks an OpenAI-compatible provider with no base URL, before any request', async () => {
      const user = userEvent.setup();
      await openManual(user, /openai-compatible/i);
      await user.type(document.getElementById('provider-name')!, 'Local');
      await user.type(document.getElementById('provider-slug')!, 'local');

      await user.click(screen.getByRole('button', { name: /create provider/i }));

      expect(await screen.findByRole('alert')).toHaveTextContent('Base URL is required.');
      await waitFor(() => expect(document.getElementById('provider-base-url')).toHaveFocus());
      expect(posted()).toEqual([]);
    });
  });
});
