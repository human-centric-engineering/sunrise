/**
 * Unit tests: removing an erased person from configuration that names them (t-791).
 *
 * `removeFromDefinition` is pure and tested directly. `eraseFromConfigRecipients`
 * is tested against a mocked transaction client: what it reads, what it writes
 * back, and what it audits. Whether the SQL narrowing finds real rows — the
 * text search, the ASCII fold, the non-ASCII fallback — is proved against
 * Postgres by `scripts/smoke/erasure-config-recipients.ts`.
 *
 * @see lib/privacy/config-recipients.ts
 */

import { describe, it, expect, vi } from 'vitest';
import type { Prisma } from '@prisma/client';

import {
  approvalRecipients,
  asciiSearchTerm,
  definitionRecipients,
  eraseFromConfigRecipients,
  removeFromDefinition,
} from '@/lib/privacy/config-recipients';

const USER_ID = 'cmsubject0000000000000000';
const OTHER_ID = 'cmcolleague00000000000000';
const ADDRESS = 'gone@example.com';
const ACTOR = 'admin-1';

function notify(id: string, to: Prisma.JsonValue, channel = 'email') {
  return {
    id,
    name: id,
    type: 'send_notification',
    config: { channel, to, subject: 'Hi', bodyTemplate: '{{input}}' },
    nextSteps: [],
  };
}

function approval(
  id: string,
  approverUserIds: Prisma.JsonValue,
  notificationChannel?: Prisma.JsonValue
) {
  return {
    id,
    name: id,
    type: 'human_approval',
    config: {
      prompt: 'OK?',
      approverUserIds,
      ...(notificationChannel !== undefined ? { notificationChannel } : {}),
    },
    nextSteps: [],
  };
}

function definition(...steps: Prisma.JsonValue[]) {
  return { steps, entryStepId: 'a', errorStrategy: 'fail' };
}

function stepConfig(def: unknown, index: number): Record<string, unknown> {
  return (def as { steps: Array<{ config: Record<string, unknown> }> }).steps[index].config;
}

describe('removeFromDefinition', () => {
  const subject = { userId: USER_ID, address: ADDRESS };

  it('an address-only subject (no id) never matches an empty approver entry (review rounds 1–2)', () => {
    const definition = {
      steps: [
        {
          id: 'ap',
          type: 'human_approval',
          config: { prompt: 'OK?', approverUserIds: ['', 'cmuser00000000000000other'] },
        },
      ],
    };
    expect(removeFromDefinition(definition, { userId: null, address: ADDRESS })).toBeNull();
  });

  it('returns null for something that is not a definition', () => {
    expect(removeFromDefinition(null, subject)).toBeNull();
    expect(removeFromDefinition('x', subject)).toBeNull();
    expect(removeFromDefinition({ steps: 'nope' }, subject)).toBeNull();
  });

  it('returns null when nothing names the person', () => {
    const def = definition(notify('a', 'someone@example.com'), approval('b', [OTHER_ID]));

    expect(removeFromDefinition(def, subject)).toBeNull();
  });

  it('empties a single-recipient `to` typed in another case and with whitespace', () => {
    const def = definition(notify('a', '  Gone@EXAMPLE.com '));

    const change = removeFromDefinition(def, subject);

    expect(stepConfig(change?.definition, 0).to).toBe('');
    expect(change?.notificationStepIds).toEqual(['a']);
    expect(change?.emptiedStepIds).toEqual(['a']);
  });

  it('removes only the person from a list, keeping colleagues and templates in order', () => {
    const def = definition(
      notify('a', ['ops@example.com', 'GONE@example.com', '{{input.userEmail}}'])
    );

    const change = removeFromDefinition(def, subject);

    expect(stepConfig(change?.definition, 0).to).toEqual([
      'ops@example.com',
      '{{input.userEmail}}',
    ]);
    expect(change?.notificationStepIds).toEqual(['a']);
    expect(change?.emptiedStepIds).toEqual([]);
  });

  it('leaves an empty list when the person was its only entry', () => {
    const def = definition(notify('a', [ADDRESS, ' gone@example.com']));

    const change = removeFromDefinition(def, subject);

    expect(stepConfig(change?.definition, 0).to).toEqual([]);
    expect(change?.emptiedStepIds).toEqual(['a']);
  });

  it('matches exactly: a longer address that contains this one is someone else', () => {
    const def = definition(notify('a', ['xgone@example.com', 'gone@example.com.au']));

    expect(removeFromDefinition(def, subject)).toBeNull();
  });

  it('never touches a webhook notification step', () => {
    const def = definition(notify('a', ADDRESS, 'webhook'));

    expect(removeFromDefinition(def, subject)).toBeNull();
  });

  it('touches no address when it was never verified, but still removes the approver id', () => {
    const def = definition(notify('a', ADDRESS), approval('b', [USER_ID]));

    const change = removeFromDefinition(def, { userId: USER_ID, address: null });

    expect(stepConfig(change?.definition, 0).to).toBe(ADDRESS);
    expect(stepConfig(change?.definition, 1).approverUserIds).toEqual([]);
    expect(change?.notificationStepIds).toEqual([]);
    expect(change?.approvalStepIds).toEqual(['b']);
  });

  it('removes the approver and keeps the other approvers', () => {
    const def = definition(approval('b', [OTHER_ID, USER_ID]));

    const change = removeFromDefinition(def, subject);

    expect(stepConfig(change?.definition, 0).approverUserIds).toEqual([OTHER_ID]);
    expect(change?.approvalStepIds).toEqual(['b']);
  });

  it('keeps every other field of the definition and its steps, and does not mutate the input', () => {
    const step = notify('a', [ADDRESS, 'ops@example.com']);
    const def = definition(step, { id: 'c', junk: true }, 7);
    const before = structuredClone(def);

    const change = removeFromDefinition(def, subject);

    expect(def).toEqual(before);
    expect(change?.definition).toEqual({
      ...before,
      steps: [
        { ...step, config: { ...step.config, to: ['ops@example.com'] } },
        { id: 'c', junk: true },
        7,
      ],
    });
  });

  it('clears an approval step’s notification target that is the address, keeping the channel', () => {
    const def = definition(
      approval('b', [OTHER_ID], {
        type: 'email',
        target: ' GONE@example.com',
        metadata: { k: 'v' },
      })
    );

    const change = removeFromDefinition(def, subject);

    expect(stepConfig(change?.definition, 0).notificationChannel).toEqual({
      type: 'email',
      metadata: { k: 'v' },
    });
    expect(stepConfig(change?.definition, 0).approverUserIds).toEqual([OTHER_ID]);
    expect(change?.approvalStepIds).toEqual(['b']);
  });

  it('removes both the approver and the target from one step, counting the step once', () => {
    const def = definition(approval('b', [USER_ID], { type: 'email', target: ADDRESS }));

    const change = removeFromDefinition(def, subject);

    expect(stepConfig(change?.definition, 0)).toMatchObject({
      approverUserIds: [],
      notificationChannel: { type: 'email' },
    });
    expect(change?.approvalStepIds).toEqual(['b']);
  });

  it('leaves a channel string, another target, or an unverified address’s target alone', () => {
    expect(removeFromDefinition(definition(approval('b', [], 'email')), subject)).toBeNull();
    expect(
      removeFromDefinition(
        definition(approval('b', [], { type: 'slack', target: 'C123' })),
        subject
      )
    ).toBeNull();
    expect(
      removeFromDefinition(definition(approval('b', [], { type: 'email', target: ADDRESS })), {
        userId: USER_ID,
        address: null,
      })
    ).toBeNull();
  });
});

describe('definitionRecipients (t-805)', () => {
  it('collects a single address and a list of addresses from email notification steps', () => {
    const result = definitionRecipients(
      definition(
        notify('a', 'one@example.com'),
        notify('b', ['two@example.com', 'three@example.com'])
      )
    );

    expect(result.addresses).toEqual(['one@example.com', 'two@example.com', 'three@example.com']);
    expect(result.userIds).toEqual([]);
  });

  it('collects approver ids and a notification channel target from approval steps', () => {
    const result = definitionRecipients(
      definition(approval('a', [USER_ID, OTHER_ID], { type: 'email', target: 'boss@example.com' }))
    );

    expect(result.userIds).toEqual([USER_ID, OTHER_ID]);
    expect(result.addresses).toEqual(['boss@example.com']);
  });

  it('ignores a notification step whose channel is not email', () => {
    const result = definitionRecipients(definition(notify('a', 'one@example.com', 'webhook')));

    expect(result).toEqual({ addresses: [], userIds: [] });
  });

  it('ignores non-string entries and an approval step with no recipients', () => {
    const result = definitionRecipients(
      definition(notify('a', ['ok@example.com', 5, null]), approval('b', [], undefined))
    );

    expect(result).toEqual({ addresses: ['ok@example.com'], userIds: [] });
  });

  it('returns nothing for a definition that does not parse', () => {
    expect(definitionRecipients(null)).toEqual({ addresses: [], userIds: [] });
    expect(definitionRecipients(undefined)).toEqual({ addresses: [], userIds: [] });
    expect(definitionRecipients({ steps: 'nope' })).toEqual({ addresses: [], userIds: [] });
  });
});

describe('approvalRecipients (t-841)', () => {
  it('names the approvers and the target, as definitionRecipients does for a step', () => {
    expect(
      approvalRecipients({
        approverUserIds: [USER_ID, OTHER_ID, 7],
        notificationChannel: { type: 'email', target: 'Gone@Example.com' },
      })
    ).toEqual({ addresses: ['Gone@Example.com'], userIds: [USER_ID, OTHER_ID] });
    expect(approvalRecipients({ notificationChannel: 'slack', approverUserIds: 'x' })).toEqual({
      addresses: [],
      userIds: [],
    });
  });
});

describe('asciiSearchTerm', () => {
  it('searches for a plain ASCII address as it is', () => {
    expect(asciiSearchTerm('a.b+c_d%e@example.com')).toBe('a.b+c_d%e@example.com');
  });

  it('refuses what the SQL text search could miss: non-ASCII, and characters JSON escapes', () => {
    expect(asciiSearchTerm('zoë@example.com')).toBeNull();
    expect(asciiSearchTerm('"quoted"@example.com')).toBeNull();
    expect(asciiSearchTerm('back\\slash@example.com')).toBeNull();
    expect(asciiSearchTerm('tab\tx@example.com')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// eraseFromConfigRecipients
// ---------------------------------------------------------------------------

interface Rows {
  settings?: unknown[];
  drafts?: unknown[];
  versions?: unknown[];
}

/** The SQL text of a `$queryRaw` tagged-template call. */
function sqlOf(call: unknown[]): string {
  return (call[0] as TemplateStringsArray).join('?');
}

function makeTx(rows: Rows = {}) {
  const tx = {
    $queryRaw: vi.fn(async (strings: TemplateStringsArray) => {
      const sql = strings.join('?');
      if (sql.includes('ai_orchestration_settings')) return rows.settings ?? [];
      if (sql.includes('ai_workflow_version')) return rows.versions ?? [];
      if (sql.includes('ai_workflow')) return rows.drafts ?? [];
      throw new Error(`unexpected query: ${sql}`);
    }),
    aiOrchestrationSettings: { update: vi.fn().mockResolvedValue({}) },
    aiWorkflow: { update: vi.fn().mockResolvedValue({}) },
    aiWorkflowVersion: { update: vi.fn().mockResolvedValue({}) },
    aiAdminAuditLog: { create: vi.fn().mockResolvedValue({}) },
  };
  return tx;
}

type Tx = ReturnType<typeof makeTx>;

function run(tx: Tx, address: string | null = ADDRESS) {
  return eraseFromConfigRecipients(tx as never, { userId: USER_ID, address, actorUserId: ACTOR });
}

function queries(tx: Tx): Array<{ sql: string; values: unknown[] }> {
  return tx.$queryRaw.mock.calls.map((call) => ({
    sql: sqlOf(call),
    values: (call as unknown[]).slice(1),
  }));
}

describe('eraseFromConfigRecipients — escalation list', () => {
  const settingsRow = (escalationConfig: unknown) => ({
    id: 'settings-1',
    slug: 'global',
    escalationConfig,
  });

  it('reads the settings row locked, so a save made meanwhile waits instead of being overwritten', async () => {
    const tx = makeTx();

    await run(tx);

    const [settings] = queries(tx);
    expect(settings.sql).toContain('FROM ai_orchestration_settings');
    expect(settings.sql).toContain('FOR NO KEY UPDATE');
  });

  it('removes the address and keeps the other recipients, the webhook and the priority', async () => {
    const tx = makeTx({
      settings: [
        settingsRow({
          emailAddresses: ['ops@example.com', ' Gone@Example.com'],
          webhookUrl: 'https://hooks.example.com/x',
          notifyOnPriority: 'high',
        }),
      ],
    });

    const result = await run(tx);

    expect(tx.aiOrchestrationSettings.update).toHaveBeenCalledWith({
      where: { id: 'settings-1' },
      data: {
        escalationConfig: {
          emailAddresses: ['ops@example.com'],
          webhookUrl: 'https://hooks.example.com/x',
          notifyOnPriority: 'high',
        },
      },
    });
    expect(result.escalationListsChanged).toBe(1);
  });

  it('leaves the list empty, webhook kept, when the person was its only recipient', async () => {
    const tx = makeTx({
      settings: [
        settingsRow({
          emailAddresses: [ADDRESS],
          webhookUrl: 'https://hooks.example.com/x',
          notifyOnPriority: 'all',
        }),
      ],
    });

    await run(tx);

    expect(tx.aiOrchestrationSettings.update).toHaveBeenCalledWith({
      where: { id: 'settings-1' },
      data: {
        escalationConfig: {
          emailAddresses: [],
          webhookUrl: 'https://hooks.example.com/x',
          notifyOnPriority: 'all',
        },
      },
    });
  });

  it('audits the change as the actor, by count, never naming the address', async () => {
    const tx = makeTx({
      settings: [settingsRow({ emailAddresses: ['a@example.com', ADDRESS, 'b@example.com'] })],
    });

    await run(tx);

    expect(tx.aiAdminAuditLog.create).toHaveBeenCalledTimes(1);
    const audit = tx.aiAdminAuditLog.create.mock.calls[0][0];
    expect(audit).toEqual({
      data: {
        userId: ACTOR,
        action: 'settings.escalation_recipient_erased',
        entityType: 'settings',
        entityId: 'global',
        entityName: 'Escalation routing',
        changes: { escalationRecipientCount: { from: 3, to: 2 } },
        metadata: { reason: expect.any(String) },
      },
    });
    expect(JSON.stringify(audit).toLowerCase()).not.toContain(ADDRESS);
  });

  it('writes nothing when the list does not name the person', async () => {
    const tx = makeTx({ settings: [settingsRow({ emailAddresses: ['ops@example.com'] })] });

    const result = await run(tx);

    expect(tx.aiOrchestrationSettings.update).not.toHaveBeenCalled();
    expect(tx.aiAdminAuditLog.create).not.toHaveBeenCalled();
    expect(result.escalationListsChanged).toBe(0);
  });

  it('skips a row whose escalation config it cannot read', async () => {
    const tx = makeTx({
      settings: [settingsRow('not-an-object'), settingsRow({ emailAddresses: ADDRESS })],
    });

    await run(tx);

    expect(tx.aiOrchestrationSettings.update).not.toHaveBeenCalled();
  });

  it('does not read the settings at all for an unverified address', async () => {
    const tx = makeTx();

    await run(tx, null);

    expect(queries(tx).some((q) => q.sql.includes('ai_orchestration_settings'))).toBe(false);
  });
});

describe('eraseFromConfigRecipients — workflows', () => {
  const draftRow = (id: string, draftDefinition: unknown, name = id) => ({
    id,
    name,
    orgId: 'org-1',
    draftDefinition,
  });
  const versionRow = (id: string, workflowId: string, version: number, snapshot: unknown) => ({
    id,
    workflowId,
    version,
    snapshot,
    name: `name of ${workflowId}`,
    orgId: 'org-1',
  });

  it('narrows drafts and versions in SQL by the user id and the folded address, locking what it reads', async () => {
    const tx = makeTx();

    await run(tx);

    const [, drafts, versions] = queries(tx);
    for (const q of [drafts, versions]) {
      expect(q.sql).toContain('strpos(f.folded');
      // ASCII letters and U+212A KELVIN SIGN, which toLowerCase() folds to "k"
      expect(q.sql).toContain('translate(');
      expect(q.sql).toContain("'ABCDEFGHIJKLMNOPQRSTUVWXYZ\u212A', 'abcdefghijklmnopqrstuvwxyzk'");
      expect(q.sql).not.toMatch(/\blower\(|ILIKE/i);
      // NO KEY: a new run's FK insert takes FOR KEY SHARE on these rows, which FOR UPDATE would block
      expect(q.sql).toContain('FOR NO KEY UPDATE');
      // userId, the search term (null test and search), the fallback flag, the two fallback documents
      expect(q.values).toEqual([
        USER_ID,
        ADDRESS,
        ADDRESS,
        false,
        expect.any(String),
        expect.any(String),
      ]);
    }
    expect(drafts.sql).toContain('FROM ai_workflow w');
    expect(versions.sql).toContain('FROM ai_workflow_version v');
  });

  it('falls back to every email step and approval channel for an address SQL cannot fold', async () => {
    const tx = makeTx();

    await eraseFromConfigRecipients(tx as never, {
      userId: USER_ID,
      address: 'zoë@example.com',
      actorUserId: ACTOR,
    });

    const [, drafts] = queries(tx);
    expect(drafts.values).toEqual([
      USER_ID,
      null,
      null,
      true,
      expect.any(String),
      expect.any(String),
    ]);
    expect(JSON.parse(drafts.values[4] as string)).toEqual({
      steps: [{ type: 'send_notification', config: { channel: 'email' } }],
    });
    expect(JSON.parse(drafts.values[5] as string)).toEqual({
      steps: [{ type: 'human_approval', config: { notificationChannel: {} } }],
    });
  });

  it('searches by the user id alone for an unverified address', async () => {
    const tx = makeTx();

    await run(tx, null);

    const [drafts] = queries(tx);
    expect(drafts.values).toEqual([
      USER_ID,
      null,
      null,
      false,
      expect.any(String),
      expect.any(String),
    ]);
  });

  it('rewrites the draft and every version that names the person, and audits once per workflow', async () => {
    const tx = makeTx({
      drafts: [draftRow('wf-1', definition(notify('n', [ADDRESS])), 'Onboarding')],
      versions: [
        versionRow('v1', 'wf-1', 1, definition(approval('ap', [USER_ID, OTHER_ID]))),
        // Matched by the narrowing but names someone else
        versionRow('v2', 'wf-1', 2, definition(notify('n', 'xgone@example.com'))),
        versionRow('v3', 'wf-1', 3, definition(notify('n', ADDRESS))),
      ],
    });

    const result = await run(tx);

    expect(tx.aiWorkflow.update).toHaveBeenCalledWith({
      where: { id: 'wf-1' },
      data: { draftDefinition: definition(notify('n', [])) },
    });
    expect(tx.aiWorkflowVersion.update).toHaveBeenCalledTimes(2);
    expect(tx.aiWorkflowVersion.update).toHaveBeenCalledWith({
      where: { id: 'v1' },
      data: { snapshot: definition(approval('ap', [OTHER_ID])) },
    });
    expect(tx.aiWorkflowVersion.update).toHaveBeenCalledWith({
      where: { id: 'v3' },
      data: { snapshot: definition(notify('n', '')) },
    });

    expect(tx.aiAdminAuditLog.create).toHaveBeenCalledTimes(1);
    const audit = tx.aiAdminAuditLog.create.mock.calls[0][0];
    expect(audit).toEqual({
      data: {
        userId: ACTOR,
        action: 'workflow.recipient_erased',
        entityType: 'workflow',
        entityId: 'wf-1',
        entityName: 'Onboarding',
        metadata: {
          reason: expect.any(String),
          orgId: 'org-1',
          draft: true,
          versions: [1, 3],
          notificationStepIds: ['n'],
          approvalStepIds: ['ap'],
          stepsLeftWithoutRecipients: ['n'],
        },
      },
    });
    expect(JSON.stringify(audit).toLowerCase()).not.toContain(ADDRESS);
    expect(result.workflowsChanged).toBe(1);
  });

  it('rewrites versions alone, named from the joined workflow, when no draft matched', async () => {
    const tx = makeTx({
      versions: [versionRow('v1', 'wf-1', 1, definition(approval('ap', [USER_ID])))],
    });

    await run(tx);

    expect(tx.aiWorkflow.update).not.toHaveBeenCalled();
    expect(tx.aiWorkflowVersion.update).toHaveBeenCalledTimes(1);
    expect(tx.aiAdminAuditLog.create.mock.calls[0][0].data).toMatchObject({
      entityId: 'wf-1',
      entityName: 'name of wf-1',
      metadata: { draft: false, versions: [1], stepsLeftWithoutRecipients: [] },
    });
  });

  it('writes and audits nothing for rows the narrowing matched that name someone else', async () => {
    const tx = makeTx({
      drafts: [draftRow('wf-1', definition(notify('n', 'xgone@example.com')))],
      versions: [versionRow('v1', 'wf-1', 1, definition(notify('n', ['gone@example.com.au'])))],
    });

    const result = await run(tx);

    expect(tx.aiWorkflow.update).not.toHaveBeenCalled();
    expect(tx.aiWorkflowVersion.update).not.toHaveBeenCalled();
    expect(tx.aiAdminAuditLog.create).not.toHaveBeenCalled();
    expect(result.workflowsChanged).toBe(0);
  });

  it('counts each workflow it changed', async () => {
    const tx = makeTx({
      drafts: [
        draftRow('a', definition(approval('ap', [USER_ID]))),
        draftRow('b', definition(approval('ap', [USER_ID]))),
      ],
    });

    const result = await run(tx);

    expect(result).toEqual({ escalationListsChanged: 0, workflowsChanged: 2 });
    expect(tx.aiAdminAuditLog.create).toHaveBeenCalledTimes(2);
  });
});
