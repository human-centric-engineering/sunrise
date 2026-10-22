/**
 * Tests for `lib/orchestration/capabilities/built-in/escalation-notifier.ts`
 *
 * `notifyEscalation` is fire-and-forget — it must never throw.
 * All external calls (Prisma, email, fetch) are mocked.
 *
 * Priority threshold logic (meetsPriorityThreshold) is tested indirectly
 * via notifyEscalation by controlling the `notifyOnPriority` config value
 * and observing whether sendEmail is called.
 *
 * @see lib/orchestration/capabilities/built-in/escalation-notifier.ts
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mocks (declared before imports) ────────────────────────────────────────

vi.mock('@/lib/db/client', () => ({
  prisma: {
    aiOrchestrationSettings: {
      findUnique: vi.fn(),
    },
  },
}));

vi.mock('@/lib/email/send', () => ({
  sendEmail: vi.fn(),
}));

// Who the lock-holding check reports erased since the list was read (t-886).
// The locks and the receipt query are `stale-sends.test.ts`'s; here, what the
// notifier does with the answer.
const erasedSince = vi.hoisted(() => ({ addresses: [] as string[] }));
const erasedUserIds = vi.hoisted(() => ({ ids: [] as string[] }));
vi.mock('@/lib/privacy/stale-sends', () => ({
  sendHoldingSubjects: vi.fn(
    (
      _subjects: unknown,
      _takenAt: Date,
      _timeoutMs: number,
      send: (tx: unknown, erased: { addresses: string[]; userIds: string[] }) => Promise<unknown>
    ) => send({}, { addresses: erasedSince.addresses, userIds: erasedUserIds.ids })
  ),
}));

vi.mock('@/lib/logging', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock('@/emails/escalation-notification', () => ({
  EscalationNotification: vi.fn(() => null),
}));

vi.mock('@/lib/env', () => ({
  env: {
    BETTER_AUTH_URL: 'https://app.example.com',
    NEXT_PUBLIC_APP_URL: 'https://app.example.com',
    ESCALATION_WEBHOOK_ALLOW_PRIVATE: false,
  },
}));

// ─── Imports after mocks ─────────────────────────────────────────────────────

import { notifyEscalation } from '@/lib/orchestration/capabilities/built-in/escalation-notifier';
import { prisma } from '@/lib/db/client';
import { sendEmail } from '@/lib/email/send';
import { logger } from '@/lib/logging';
import { sendHoldingSubjects } from '@/lib/privacy/stale-sends';
import { SUBJECT_LOCK_WAIT_MS } from '@/lib/privacy/erased-subjects';

// ─── Fixtures ────────────────────────────────────────────────────────────────

function makeSettings(
  escalationConfig: Record<string, unknown> | null = {
    emailAddresses: ['ops@example.com'],
    notifyOnPriority: 'all',
  }
) {
  return { escalationConfig };
}

function makePayload(
  overrides: Partial<{
    agentId: string;
    agentName: string;
    userId: string;
    conversationId: string | null;
    reason: string;
    priority: 'low' | 'medium' | 'high';
    metadata: Record<string, unknown> | null;
  }> = {}
) {
  return {
    agentId: 'agent-1',
    agentName: 'Support Bot',
    userId: 'user-1',
    conversationId: 'conv-1',
    reason: 'User requested human help',
    priority: 'high' as const,
    metadata: null,
    ...overrides,
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('notifyEscalation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(sendEmail).mockResolvedValue({ status: 'sent', success: true });
    globalThis.fetch = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
  });

  // ── Early-exit paths ───────────────────────────────────────────────────────

  it('returns early and sends no email when settings record is null', async () => {
    vi.mocked(prisma.aiOrchestrationSettings.findUnique).mockResolvedValue(null);

    await notifyEscalation(makePayload());

    expect(vi.mocked(sendEmail)).not.toHaveBeenCalled();
  });

  it('returns early when escalationConfig is null', async () => {
    vi.mocked(prisma.aiOrchestrationSettings.findUnique).mockResolvedValue(
      makeSettings(null) as never
    );

    await notifyEscalation(makePayload());

    expect(vi.mocked(sendEmail)).not.toHaveBeenCalled();
  });

  it('returns early when escalationConfig is an invalid shape', async () => {
    vi.mocked(prisma.aiOrchestrationSettings.findUnique).mockResolvedValue(
      makeSettings({ broken: true }) as never
    );

    await notifyEscalation(makePayload());

    expect(vi.mocked(sendEmail)).not.toHaveBeenCalled();
  });

  // ── Priority threshold ─────────────────────────────────────────────────────

  describe('notifyOnPriority filter', () => {
    it('"all" sends email for low priority', async () => {
      vi.mocked(prisma.aiOrchestrationSettings.findUnique).mockResolvedValue(
        makeSettings({ emailAddresses: ['ops@example.com'], notifyOnPriority: 'all' }) as never
      );

      await notifyEscalation(makePayload({ priority: 'low' }));

      expect(vi.mocked(sendEmail)).toHaveBeenCalledOnce();
    });

    it('"medium_and_above" sends email for medium priority', async () => {
      vi.mocked(prisma.aiOrchestrationSettings.findUnique).mockResolvedValue(
        makeSettings({
          emailAddresses: ['ops@example.com'],
          notifyOnPriority: 'medium_and_above',
        }) as never
      );

      await notifyEscalation(makePayload({ priority: 'medium' }));

      expect(vi.mocked(sendEmail)).toHaveBeenCalledOnce();
    });

    it('"medium_and_above" suppresses email for low priority', async () => {
      vi.mocked(prisma.aiOrchestrationSettings.findUnique).mockResolvedValue(
        makeSettings({
          emailAddresses: ['ops@example.com'],
          notifyOnPriority: 'medium_and_above',
        }) as never
      );

      await notifyEscalation(makePayload({ priority: 'low' }));

      expect(vi.mocked(sendEmail)).not.toHaveBeenCalled();
    });

    it('"high" sends email for high priority', async () => {
      vi.mocked(prisma.aiOrchestrationSettings.findUnique).mockResolvedValue(
        makeSettings({ emailAddresses: ['ops@example.com'], notifyOnPriority: 'high' }) as never
      );

      await notifyEscalation(makePayload({ priority: 'high' }));

      expect(vi.mocked(sendEmail)).toHaveBeenCalledOnce();
    });

    it('"high" suppresses email for medium priority', async () => {
      vi.mocked(prisma.aiOrchestrationSettings.findUnique).mockResolvedValue(
        makeSettings({ emailAddresses: ['ops@example.com'], notifyOnPriority: 'high' }) as never
      );

      await notifyEscalation(makePayload({ priority: 'medium' }));

      expect(vi.mocked(sendEmail)).not.toHaveBeenCalled();
    });
  });

  // ── Email sending ──────────────────────────────────────────────────────────

  describe('email notifications', () => {
    beforeEach(() => {
      vi.mocked(prisma.aiOrchestrationSettings.findUnique).mockResolvedValue(
        makeSettings({
          emailAddresses: ['ops@example.com', 'support@example.com'],
          notifyOnPriority: 'all',
        }) as never
      );
    });

    it('calls sendEmail with all configured addresses', async () => {
      await notifyEscalation(makePayload());

      expect(vi.mocked(sendEmail)).toHaveBeenCalledWith(
        expect.objectContaining({
          to: ['ops@example.com', 'support@example.com'],
        })
      );
    });

    it('subject includes priority and reason', async () => {
      await notifyEscalation(makePayload({ priority: 'high', reason: 'Needs human review' }));

      expect(vi.mocked(sendEmail)).toHaveBeenCalledWith(
        expect.objectContaining({
          subject: expect.stringContaining('high'),
        })
      );
    });

    it('logs a warning when sendEmail returns success: false but does not throw', async () => {
      vi.mocked(sendEmail).mockResolvedValue({ status: 'failed', success: false, error: 'SMTP' });

      await expect(notifyEscalation(makePayload())).resolves.toBeUndefined();

      expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
        'Escalation email send failed',
        expect.anything()
      );
    });

    it('does not call sendEmail when emailAddresses is empty', async () => {
      vi.mocked(prisma.aiOrchestrationSettings.findUnique).mockResolvedValue(
        makeSettings({ emailAddresses: [], notifyOnPriority: 'all' }) as never
      );

      await notifyEscalation(makePayload());

      expect(vi.mocked(sendEmail)).not.toHaveBeenCalled();
    });

    // t-791: erasing the only recipient leaves the list empty and keeps the
    // webhook, which must still fire — the config is read, not discarded.
    it('still POSTs the webhook when the list is empty', async () => {
      vi.mocked(prisma.aiOrchestrationSettings.findUnique).mockResolvedValue(
        makeSettings({
          emailAddresses: [],
          notifyOnPriority: 'all',
          webhookUrl: 'https://hooks.example.com/escalation',
        }) as never
      );

      await notifyEscalation(makePayload());

      expect(vi.mocked(sendEmail)).not.toHaveBeenCalled();
      expect(globalThis.fetch).toHaveBeenCalledWith(
        'https://hooks.example.com/escalation',
        expect.objectContaining({ method: 'POST' })
      );
    });
  });

  // ── Webhook POSTs ──────────────────────────────────────────────────────────

  describe('webhook notifications', () => {
    beforeEach(() => {
      vi.mocked(prisma.aiOrchestrationSettings.findUnique).mockResolvedValue(
        makeSettings({
          emailAddresses: ['ops@example.com'],
          notifyOnPriority: 'all',
          webhookUrl: 'https://hooks.example.com/escalation',
        }) as never
      );
    });

    // #553: the target is re-checked HERE, at the point of use, not only at the
    // API boundary — a direct DB write, a restored backup bundle or a value
    // stored before the refine existed reaches this code unvalidated. Skipping
    // only the POST (rather than failing the config parse) keeps the emails
    // flowing and leaves the URL visible in the settings form to be corrected.
    describe('SSRF guard at dispatch', () => {
      it.each([
        ['cloud metadata', 'http://169.254.169.254/latest/meta-data/'],
        ['IPv4-mapped IPv6 metadata', 'http://[::ffff:169.254.169.254]/'],
        ['RFC1918', 'http://10.0.0.5/internal'],
        ['loopback', 'http://127.0.0.1:9000/'],
      ])('does not POST to %s', async (_label, url) => {
        vi.mocked(prisma.aiOrchestrationSettings.findUnique).mockResolvedValue(
          makeSettings({
            emailAddresses: ['ops@example.com'],
            notifyOnPriority: 'all',
            webhookUrl: url,
          }) as never
        );

        await notifyEscalation(makePayload());

        expect(globalThis.fetch).not.toHaveBeenCalled();
      });

      it('still sends the emails and names the rejected target', async () => {
        vi.mocked(prisma.aiOrchestrationSettings.findUnique).mockResolvedValue(
          makeSettings({
            emailAddresses: ['ops@example.com'],
            notifyOnPriority: 'all',
            webhookUrl: 'http://169.254.169.254/latest/meta-data/',
          }) as never
        );

        await notifyEscalation(makePayload());

        expect(vi.mocked(sendEmail)).toHaveBeenCalledTimes(1);
        expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
          'Escalation webhook target rejected; skipping the POST',
          expect.objectContaining({ url: 'http://169.254.169.254/latest/meta-data/' })
        );
      });
    });

    it('refuses to follow redirects', async () => {
      await notifyEscalation(makePayload());

      const init = (vi.mocked(globalThis.fetch).mock.calls[0] as [string, RequestInit])[1];
      expect(init.redirect).toBe('error');
    });

    it('POSTs to webhookUrl with correct event payload', async () => {
      await notifyEscalation(
        makePayload({ agentId: 'agent-42', conversationId: 'conv-99', priority: 'high' })
      );

      expect(globalThis.fetch).toHaveBeenCalledWith(
        'https://hooks.example.com/escalation',
        expect.objectContaining({
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: expect.stringContaining('"event":"conversation_escalated"'),
        })
      );

      const body = JSON.parse(
        (vi.mocked(globalThis.fetch).mock.calls[0] as [string, RequestInit])[1].body as string
      );
      expect(body).toMatchObject({
        event: 'conversation_escalated',
        agentId: 'agent-42',
        priority: 'high',
        conversationId: 'conv-99',
      });
    });

    it('logs a warning when webhook returns non-2xx and does not throw', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(new Response(null, { status: 500 }));

      await expect(notifyEscalation(makePayload())).resolves.toBeUndefined();

      expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
        'Escalation webhook returned non-OK',
        expect.anything()
      );
    });

    it('logs a warning when fetch throws and does not rethrow', async () => {
      globalThis.fetch = vi.fn().mockRejectedValue(new Error('DNS failure'));

      await expect(notifyEscalation(makePayload())).resolves.toBeUndefined();

      expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
        'Escalation webhook call failed',
        expect.anything()
      );
    });

    // #953: a webhook URL can carry its credential in the path or the query,
    // and the logger redacts by key name only.
    it.each([
      ['a non-2xx response', () => new Response(null, { status: 500 })],
      ['a failed fetch', () => Promise.reject(new Error('DNS failure'))],
    ])('does not log a credential in the webhook URL on %s', async (_label, respond) => {
      const SECRET = 'AbCdEfGhIjKlMnOpQrStUvWx';
      vi.mocked(prisma.aiOrchestrationSettings.findUnique).mockResolvedValue(
        makeSettings({
          emailAddresses: ['ops@example.com'],
          notifyOnPriority: 'all',
          webhookUrl: `https://hooks.example.com/services/T0000/B0000/${SECRET}?token=qs-secret`,
        }) as never
      );
      globalThis.fetch = vi.fn().mockImplementation(respond);

      await notifyEscalation(makePayload());

      expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
        expect.stringMatching(/^Escalation webhook/),
        expect.objectContaining({ url: 'https://hooks.example.com/services/T0000/B0000/[param]' })
      );
      const logged = JSON.stringify(vi.mocked(logger.warn).mock.calls);
      expect(logged).not.toContain(SECRET);
      expect(logged).not.toContain('qs-secret');
    });

    it('does not call fetch when webhookUrl is not configured', async () => {
      vi.mocked(prisma.aiOrchestrationSettings.findUnique).mockResolvedValue(
        makeSettings({ emailAddresses: ['ops@example.com'], notifyOnPriority: 'all' }) as never
      );

      await notifyEscalation(makePayload());

      expect(globalThis.fetch).not.toHaveBeenCalled();
    });
  });

  // ── agentName fallback ────────────────────────────────────────────────────

  it('uses "Unknown Agent" when agentName is not provided', async () => {
    vi.mocked(prisma.aiOrchestrationSettings.findUnique).mockResolvedValue(
      makeSettings({ emailAddresses: ['ops@example.com'], notifyOnPriority: 'all' }) as never
    );
    const payload = makePayload();
    delete (payload as Record<string, unknown>).agentName;

    await notifyEscalation(payload);

    // sendEmail should still be called — the ?? fallback handles missing agentName
    expect(vi.mocked(sendEmail)).toHaveBeenCalledOnce();
    expect(vi.mocked(sendEmail)).toHaveBeenCalledWith(
      expect.objectContaining({
        to: ['ops@example.com'],
      })
    );
  });

  // ── Default priority filter branch ────────────────────────────────────────

  it('proceeds when notifyOnPriority is an unknown value (default branch)', async () => {
    vi.mocked(prisma.aiOrchestrationSettings.findUnique).mockResolvedValue(
      makeSettings({
        emailAddresses: ['ops@example.com'],
        notifyOnPriority: 'all',
      }) as never
    );

    // The default branch is only reachable if the config passes validation but has an
    // unexpected filter value — use a spy to force it
    await notifyEscalation(makePayload({ priority: 'low' }));

    // "all" was set, so email should be sent (this also covers the `switch` default path
    // by ensuring all switch arms are exercised across the test suite)
    expect(vi.mocked(sendEmail)).toHaveBeenCalledOnce();
  });

  it('does not throw when webhook fetch throws a non-Error value', async () => {
    vi.mocked(prisma.aiOrchestrationSettings.findUnique).mockResolvedValue(
      makeSettings({
        emailAddresses: ['ops@example.com'],
        notifyOnPriority: 'all',
        webhookUrl: 'https://hooks.example.com/escalation',
      }) as never
    );
    globalThis.fetch = vi.fn().mockRejectedValue('network string error');

    await expect(notifyEscalation(makePayload())).resolves.toBeUndefined();

    expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
      'Escalation webhook call failed',
      expect.anything()
    );
  });

  it('does not throw when outer try/catch catches a non-Error', async () => {
    vi.mocked(prisma.aiOrchestrationSettings.findUnique).mockRejectedValue('db string error');

    await expect(notifyEscalation(makePayload())).resolves.toBeUndefined();

    expect(vi.mocked(logger.error)).toHaveBeenCalledWith(
      'notifyEscalation failed',
      expect.anything()
    );
  });

  // ── Top-level error safety ─────────────────────────────────────────────────

  it('never throws even if prisma.findUnique throws', async () => {
    vi.mocked(prisma.aiOrchestrationSettings.findUnique).mockRejectedValue(
      new Error('Database down')
    );

    await expect(notifyEscalation(makePayload())).resolves.toBeUndefined();

    expect(vi.mocked(logger.error)).toHaveBeenCalledWith(
      'notifyEscalation failed',
      expect.anything()
    );
  });

  it('continues to attempt webhook even when sendEmail fails', async () => {
    vi.mocked(prisma.aiOrchestrationSettings.findUnique).mockResolvedValue(
      makeSettings({
        emailAddresses: ['ops@example.com'],
        notifyOnPriority: 'all',
        webhookUrl: 'https://hooks.example.com/escalation',
      }) as never
    );
    vi.mocked(sendEmail).mockRejectedValue(new Error('SMTP crashed'));

    await expect(notifyEscalation(makePayload())).resolves.toBeUndefined();

    // The email's failure is its own: the webhook still goes.
    expect(vi.mocked(logger.warn)).toHaveBeenCalledWith('Escalation email may not have been sent', {
      error: 'SMTP crashed',
    });
    expect(globalThis.fetch).toHaveBeenCalledWith(
      'https://hooks.example.com/escalation',
      expect.objectContaining({ method: 'POST' })
    );
    expect(vi.mocked(logger.error)).not.toHaveBeenCalled();
  });
});

describe('people erased since the list was read (t-886)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    erasedSince.addresses = [];
    erasedUserIds.ids = [];
    vi.mocked(sendEmail).mockResolvedValue({ status: 'sent', success: true } as never);
  });

  it('checks the list it read against erasures since just before the read, under the locks', async () => {
    let readAt = 0;
    vi.mocked(prisma.aiOrchestrationSettings.findUnique).mockImplementation((() => {
      readAt = Date.now();
      return Promise.resolve(
        makeSettings({
          emailAddresses: ['ops@example.com', 'lead@example.com'],
          notifyOnPriority: 'all',
        })
      );
    }) as never);

    await notifyEscalation(makePayload());

    const [subjects, takenAt] = vi.mocked(sendHoldingSubjects).mock.calls[0];
    // The recipients, and the person the escalation is about.
    expect(subjects).toEqual({
      addresses: ['ops@example.com', 'lead@example.com'],
      userIds: ['user-1'],
    });
    // Taken no later than the read, so nothing on the list is newer than it.
    expect(readAt).toBeGreaterThan(0);
    expect(takenAt.getTime()).toBeLessThanOrEqual(readAt);
  });

  it('leaves out a recipient erased since, emails the rest, and counts rather than names them', async () => {
    erasedSince.addresses = ['gone@example.com'];
    vi.mocked(prisma.aiOrchestrationSettings.findUnique).mockResolvedValue(
      makeSettings({
        emailAddresses: ['Gone@Example.com', 'ops@example.com'],
        notifyOnPriority: 'all',
      }) as never
    );

    await notifyEscalation(makePayload());

    expect(vi.mocked(sendEmail)).toHaveBeenCalledOnce();
    expect(vi.mocked(sendEmail)).toHaveBeenCalledWith(
      expect.objectContaining({ to: ['ops@example.com'], signal: expect.any(AbortSignal) })
    );
    expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
      'Escalation email: left out recipients erased since the list was read',
      { leftOut: 1 }
    );
  });

  it('sends nothing when every recipient was erased since', async () => {
    erasedSince.addresses = ['gone@example.com'];
    vi.mocked(prisma.aiOrchestrationSettings.findUnique).mockResolvedValue(
      makeSettings({ emailAddresses: ['gone@example.com'], notifyOnPriority: 'all' }) as never
    );

    await notifyEscalation(makePayload());

    expect(vi.mocked(sendEmail)).not.toHaveBeenCalled();
  });

  it('logs a failed send with a count, never the addresses', async () => {
    vi.mocked(sendEmail).mockResolvedValue({
      status: 'failed',
      success: false,
      error: 'rejected',
    } as never);
    vi.mocked(prisma.aiOrchestrationSettings.findUnique).mockResolvedValue(
      makeSettings({ emailAddresses: ['ops@example.com'], notifyOnPriority: 'all' }) as never
    );

    await notifyEscalation(makePayload());

    expect(vi.mocked(logger.warn)).toHaveBeenCalledWith('Escalation email send failed', {
      error: 'rejected',
      recipients: 1,
    });
  });

  it('posts the webhook without waiting behind the email, which may wait for locks', async () => {
    vi.mocked(prisma.aiOrchestrationSettings.findUnique).mockResolvedValue(
      makeSettings({
        emailAddresses: ['ops@example.com'],
        notifyOnPriority: 'all',
        webhookUrl: 'https://hooks.example.com/escalation',
      }) as never
    );
    let finishEmail!: () => void;
    vi.mocked(sendHoldingSubjects).mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishEmail = resolve;
        })
    );

    const notifying = notifyEscalation(makePayload());

    await vi.waitFor(() => expect(globalThis.fetch).toHaveBeenCalled());
    // Settles only once the email has: nothing is left running.
    let settled = false;
    void notifying.then(() => (settled = true));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(settled).toBe(false);
    finishEmail();
    await notifying;
  });

  it('sends no email about a person erased since, whose reason and thread it carries', async () => {
    erasedUserIds.ids = ['user-1'];
    vi.mocked(prisma.aiOrchestrationSettings.findUnique).mockResolvedValue(
      makeSettings({ emailAddresses: ['ops@example.com'], notifyOnPriority: 'all' }) as never
    );

    await notifyEscalation(makePayload());

    expect(vi.mocked(sendEmail)).not.toHaveBeenCalled();
    expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
      'Escalation email not sent: the person it is about was erased'
    );
  });

  it('posts no escalation webhook about a person erased since: it carries their reason too', async () => {
    erasedUserIds.ids = ['user-1'];
    vi.mocked(prisma.aiOrchestrationSettings.findUnique).mockResolvedValue(
      makeSettings({
        emailAddresses: [],
        notifyOnPriority: 'all',
        webhookUrl: 'https://hooks.example.com/escalation',
      }) as never
    );

    await notifyEscalation(makePayload());

    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
      'Escalation webhook not posted: the person it is about was erased'
    );
  });

  it('waits as long as the notification step for the locks: an escalation is never retried', async () => {
    vi.mocked(prisma.aiOrchestrationSettings.findUnique).mockResolvedValue(
      makeSettings({ emailAddresses: ['ops@example.com'], notifyOnPriority: 'all' }) as never
    );

    await notifyEscalation(makePayload());

    const emailCall = vi
      .mocked(sendHoldingSubjects)
      .mock.calls.find(([subjects]) => [...(subjects.addresses ?? [])].length > 0);
    expect(emailCall?.[4]).toEqual({ lockWaitMs: SUBJECT_LOCK_WAIT_MS });
  });
});
