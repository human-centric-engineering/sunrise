/**
 * Tests for `lib/orchestration/backup/export-seal.ts` (§122 t-902).
 *
 * The seal is what lets a backup import trust `exportedAt`, so each way a seal
 * must fail to verify is its own case.
 *
 * @see lib/orchestration/backup/export-seal.ts
 */

import { createHmac } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';

const { SECRET } = vi.hoisted(() => ({
  SECRET: 'test-secret-that-is-at-least-32-characters-long',
}));

vi.mock('@/lib/env', () => ({ env: { BETTER_AUTH_SECRET: SECRET } }));

import {
  bundleContacts,
  isSealedByThisInstall,
  sealExport,
  trustedExportedAt,
} from '@/lib/orchestration/backup/export-seal';
import { generateApprovalToken } from '@/lib/orchestration/approval-tokens';

const AT = '2026-06-01T09:30:00.000Z';
const subs = (...subscriptions: string[]) => ({
  subscriptions,
  escalation: [] as string[],
  workflows: [] as string[],
});
const FACTS = { exportedAt: AT, orgId: 'install', contacts: subs('ops@example.com') };
const MESSAGE = `orchestration-backup-exported-at\n${JSON.stringify([AT, 'install', ['ops@example.com'], [], []])}`;

function macOf(secret: string, message: string): string {
  return createHmac('sha256', secret).update(message, 'utf8').digest('base64url');
}

describe('sealExport / isSealedByThisInstall', () => {
  it('verifies the seal this install made over the same facts', () => {
    expect(isSealedByThisInstall(FACTS, sealExport(FACTS))).toBe(true);
  });

  it('is an HMAC-SHA256 over the tag and the facts as one JSON array, keyed by the install secret', () => {
    expect(sealExport(FACTS)).toBe(macOf(SECRET, MESSAGE));
  });

  it('reads case, spaces and order as the same list', () => {
    const seal = sealExport(FACTS);
    expect(isSealedByThisInstall({ ...FACTS, contacts: subs(' OPS@example.com ') }, seal)).toBe(
      true
    );
    const two = sealExport({ ...FACTS, contacts: subs('b@example.com', 'a@example.com') });
    expect(
      isSealedByThisInstall({ ...FACTS, contacts: subs('a@example.com', 'b@example.com') }, two)
    ).toBe(true);
  });

  it.each([
    ['another date', { ...FACTS, exportedAt: '2026-06-01T09:30:00.001Z' }],
    ['another org', { ...FACTS, orgId: 'org_customer' }],
    ['an added contact', { ...FACTS, contacts: subs('ops@example.com', 'gone@example.com') }],
    ['a removed contact', { ...FACTS, contacts: subs() }],
    ['a repeat of a contact', { ...FACTS, contacts: subs('ops@example.com', 'ops@example.com') }],
    [
      'the contact moved to the escalation list',
      { ...FACTS, contacts: { subscriptions: [], escalation: ['ops@example.com'], workflows: [] } },
    ],
    [
      'the contact moved into a workflow (t-900)',
      { ...FACTS, contacts: { subscriptions: [], escalation: [], workflows: ['ops@example.com'] } },
    ],
    [
      'a workflow recipient added (t-900)',
      { ...FACTS, contacts: { ...subs('ops@example.com'), workflows: ['gone@example.com'] } },
    ],
    [
      'the contact copied to the escalation list',
      {
        ...FACTS,
        contacts: {
          subscriptions: ['ops@example.com'],
          escalation: ['ops@example.com'],
          workflows: [],
        },
      },
    ],
  ])('refuses a seal checked against %s', (_label, facts) => {
    expect(isSealedByThisInstall(facts, sealExport(FACTS))).toBe(false);
  });

  it('refuses a missing or empty seal', () => {
    expect(isSealedByThisInstall(FACTS, undefined)).toBe(false);
    expect(isSealedByThisInstall(FACTS, '')).toBe(false);
  });

  it('refuses a seal another install made, with its own secret', () => {
    const message = `orchestration-backup-exported-at\n${JSON.stringify([AT, 'install', ['ops@example.com']])}`;
    expect(
      isSealedByThisInstall(FACTS, macOf('another-install-secret-at-least-32-chars', message))
    ).toBe(false);
  });

  it('refuses a MAC over the facts without the scheme tag', () => {
    const untagged = macOf(SECRET, JSON.stringify([AT, 'install', ['ops@example.com'], [], []]));
    expect(isSealedByThisInstall(FACTS, untagged)).toBe(false);
  });

  it("refuses an approval token's signature, made with the same secret", () => {
    const { token } = generateApprovalToken('cmjbv4i3x00003wsloputgwul', 'approve', 60);
    const [payload, signature] = token.split('.');
    expect(isSealedByThisInstall({ ...FACTS, exportedAt: payload }, signature)).toBe(false);
  });

  it('refuses a truncated seal, one of the wrong length, and junk, without throwing', () => {
    const seal = sealExport(FACTS);
    expect(isSealedByThisInstall(FACTS, seal.slice(0, -2))).toBe(false);
    expect(isSealedByThisInstall(FACTS, `${seal}AA`)).toBe(false);
    expect(isSealedByThisInstall(FACTS, '!!!not base64!!!')).toBe(false);
  });
});

describe('bundleContacts', () => {
  it("reads the email subscriptions, the escalation list and the workflows' addresses, and nothing else", () => {
    expect(
      bundleContacts({
        webhooks: [
          { channel: 'email', emailAddress: 'ops@example.com' },
          { channel: 'webhook', emailAddress: 'ignored@example.com' },
          { channel: 'email', emailAddress: null },
        ],
        settings: { escalationConfig: { emailAddresses: ['oncall@example.com', 7] } },
        workflows: [
          {
            workflowDefinition: {
              steps: [
                {
                  id: 'n',
                  name: 'N',
                  type: 'send_notification',
                  config: {
                    channel: 'email',
                    to: ['flow@example.com'],
                    subject: 's',
                    bodyTemplate: 'b',
                  },
                  nextSteps: [],
                },
                {
                  id: 'a',
                  name: 'A',
                  type: 'human_approval',
                  config: { prompt: 'ok?', approverUserIds: ['cmjbv4i3x00003wsloputuser'] },
                  nextSteps: [],
                },
              ],
              entryStepId: 'n',
              errorStrategy: 'fail',
            },
          },
          // Does not parse, so the importer skips it and so does the seal.
          { workflowDefinition: { steps: 'nope' } },
        ],
      })
    ).toEqual({
      subscriptions: ['ops@example.com'],
      escalation: ['oncall@example.com'],
      // An approver id is not an address.
      workflows: ['flow@example.com'],
    });
  });

  it('reads no escalation list from a bundle without settings, or with a malformed one', () => {
    const none = { subscriptions: [], escalation: [], workflows: [] };
    expect(bundleContacts({ webhooks: [], settings: null, workflows: [] })).toEqual(none);
    expect(
      bundleContacts({ webhooks: [], settings: { escalationConfig: 'nope' }, workflows: [] })
    ).toEqual(none);
  });
});

describe('trustedExportedAt', () => {
  const NOW = new Date('2026-10-22T12:00:00Z');
  const DATA = {
    webhooks: [{ channel: 'email', emailAddress: 'ops@example.com' }],
    settings: null,
    workflows: [],
  };
  const bundle = (exportSeal: string | undefined, exportedAt = AT) => ({
    exportedAt,
    exportSeal,
    data: DATA,
  });

  it("trusts a date this install sealed over this org and the bundle's contacts", () => {
    expect(trustedExportedAt(bundle(sealExport(FACTS)), 'install', NOW)).toEqual(new Date(AT));
  });

  it('counts every erasure for an unsealed bundle, or one imported into another org', () => {
    expect(trustedExportedAt(bundle(undefined), 'install', NOW)).toBeUndefined();
    expect(trustedExportedAt(bundle(sealExport(FACTS)), 'org_customer', NOW)).toBeUndefined();
  });

  it('counts every erasure for a sealed string that is not a date', () => {
    const seal = sealExport({ ...FACTS, exportedAt: 'not a date' });
    expect(trustedExportedAt(bundle(seal, 'not a date'), 'install', NOW)).toBeUndefined();
  });

  it('clamps a sealed date ahead of now to now', () => {
    const ahead = '2026-10-22T12:03:00.000Z';
    const seal = sealExport({ ...FACTS, exportedAt: ahead });
    expect(trustedExportedAt(bundle(seal, ahead), 'install', NOW)).toEqual(NOW);
  });
});
