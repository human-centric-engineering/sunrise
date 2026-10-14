/**
 * Unit tests: removing an erased person from configuration that names them (t-791).
 *
 * `removeFromDefinition` is pure and tested directly. `eraseFromConfigRecipients`
 * is tested against a mocked transaction client: what it reads, what it writes
 * back, and what it audits. Whether Prisma's JSON containment filter matches
 * real rows is proved against Postgres by `scripts/smoke/erasure.ts`.
 *
 * @see lib/privacy/config-recipients.ts
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Prisma } from '@prisma/client';

import { eraseFromConfigRecipients, removeFromDefinition } from '@/lib/privacy/config-recipients';

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

function approval(id: string, approverUserIds: Prisma.JsonValue) {
  return {
    id,
    name: id,
    type: 'human_approval',
    config: { prompt: 'OK?', approverUserIds },
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
});

// ---------------------------------------------------------------------------
// eraseFromConfigRecipients
// ---------------------------------------------------------------------------

function makeTx() {
  return {
    aiOrchestrationSettings: {
      findMany: vi.fn().mockResolvedValue([]),
      update: vi.fn().mockResolvedValue({}),
    },
    aiWorkflow: {
      findMany: vi.fn().mockResolvedValue([]),
      update: vi.fn().mockResolvedValue({}),
    },
    aiWorkflowVersion: { update: vi.fn().mockResolvedValue({}) },
    aiAdminAuditLog: { create: vi.fn().mockResolvedValue({}) },
  };
}

type Tx = ReturnType<typeof makeTx>;

function run(tx: Tx, address: string | null = ADDRESS) {
  return eraseFromConfigRecipients(tx as never, { userId: USER_ID, address, actorUserId: ACTOR });
}

describe('eraseFromConfigRecipients — escalation list', () => {
  let tx: Tx;
  beforeEach(() => {
    tx = makeTx();
  });

  it('removes the address and keeps the other recipients, the webhook and the priority', async () => {
    tx.aiOrchestrationSettings.findMany.mockResolvedValue([
      {
        id: 'settings-1',
        slug: 'global',
        escalationConfig: {
          emailAddresses: ['ops@example.com', ' Gone@Example.com'],
          webhookUrl: 'https://hooks.example.com/x',
          notifyOnPriority: 'high',
        },
      },
    ]);

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
    tx.aiOrchestrationSettings.findMany.mockResolvedValue([
      {
        id: 'settings-1',
        slug: 'global',
        escalationConfig: {
          emailAddresses: [ADDRESS],
          webhookUrl: 'https://hooks.example.com/x',
          notifyOnPriority: 'all',
        },
      },
    ]);

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
    tx.aiOrchestrationSettings.findMany.mockResolvedValue([
      {
        id: 'settings-1',
        slug: 'global',
        escalationConfig: { emailAddresses: ['a@example.com', ADDRESS, 'b@example.com'] },
      },
    ]);

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
    tx.aiOrchestrationSettings.findMany.mockResolvedValue([
      { id: 's', slug: 'global', escalationConfig: { emailAddresses: ['ops@example.com'] } },
    ]);

    const result = await run(tx);

    expect(tx.aiOrchestrationSettings.update).not.toHaveBeenCalled();
    expect(tx.aiAdminAuditLog.create).not.toHaveBeenCalled();
    expect(result.escalationListsChanged).toBe(0);
  });

  it('skips a row with no escalation config, or one it cannot read', async () => {
    tx.aiOrchestrationSettings.findMany.mockResolvedValue([
      { id: 's1', slug: 'global', escalationConfig: null },
      { id: 's2', slug: 'other', escalationConfig: { emailAddresses: ADDRESS } },
    ]);

    await run(tx);

    expect(tx.aiOrchestrationSettings.update).not.toHaveBeenCalled();
  });

  it('does not read the settings at all for an unverified address', async () => {
    await run(tx, null);

    expect(tx.aiOrchestrationSettings.findMany).not.toHaveBeenCalled();
  });
});

describe('eraseFromConfigRecipients — workflows', () => {
  let tx: Tx;
  beforeEach(() => {
    tx = makeTx();
  });

  it('narrows by JSON containment: approval steps naming the id, and email notification steps', async () => {
    await run(tx);

    const approvalStep = { type: 'human_approval', config: { approverUserIds: [USER_ID] } };
    const emailStep = { type: 'send_notification', config: { channel: 'email' } };
    const snapshotFilters = [
      { snapshot: { path: ['steps'], array_contains: [approvalStep] } },
      { snapshot: { path: ['steps'], array_contains: [emailStep] } },
    ];
    expect(tx.aiWorkflow.findMany).toHaveBeenCalledWith({
      where: {
        OR: [
          { draftDefinition: { path: ['steps'], array_contains: [approvalStep] } },
          { draftDefinition: { path: ['steps'], array_contains: [emailStep] } },
          { versions: { some: { OR: snapshotFilters } } },
        ],
      },
      select: expect.objectContaining({
        versions: expect.objectContaining({ where: { OR: snapshotFilters } }),
      }),
    });
  });

  it('narrows to approval steps only for an unverified address', async () => {
    await run(tx, null);

    const where = tx.aiWorkflow.findMany.mock.calls[0][0].where as { OR: unknown[] };
    expect(JSON.stringify(where)).not.toContain('send_notification');
    expect(JSON.stringify(where)).toContain(USER_ID);
  });

  it('rewrites the draft and every version that names the person, and audits once per workflow', async () => {
    tx.aiWorkflow.findMany.mockResolvedValue([
      {
        id: 'wf-1',
        name: 'Onboarding',
        orgId: 'org-1',
        draftDefinition: definition(notify('n', [ADDRESS])),
        versions: [
          { id: 'v1', version: 1, snapshot: definition(approval('ap', [USER_ID, OTHER_ID])) },
          // Matched by the narrowing (an email step) but names someone else
          { id: 'v2', version: 2, snapshot: definition(notify('n', 'ops@example.com')) },
          { id: 'v3', version: 3, snapshot: definition(notify('n', ADDRESS)) },
        ],
      },
    ]);

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

  it('rewrites versions alone when the draft does not name the person (or there is none)', async () => {
    tx.aiWorkflow.findMany.mockResolvedValue([
      {
        id: 'wf-1',
        name: 'W',
        orgId: 'org-1',
        draftDefinition: null,
        versions: [{ id: 'v1', version: 1, snapshot: definition(approval('ap', [USER_ID])) }],
      },
    ]);

    await run(tx);

    expect(tx.aiWorkflow.update).not.toHaveBeenCalled();
    expect(tx.aiWorkflowVersion.update).toHaveBeenCalledTimes(1);
    expect(tx.aiAdminAuditLog.create.mock.calls[0][0].data.metadata).toMatchObject({
      draft: false,
      versions: [1],
      stepsLeftWithoutRecipients: [],
    });
  });

  it('writes and audits nothing for a workflow the narrowing matched that names someone else', async () => {
    tx.aiWorkflow.findMany.mockResolvedValue([
      {
        id: 'wf-1',
        name: 'W',
        orgId: 'org-1',
        draftDefinition: definition(notify('n', 'ops@example.com')),
        versions: [{ id: 'v1', version: 1, snapshot: definition(notify('n', ['a@example.com'])) }],
      },
    ]);

    const result = await run(tx);

    expect(tx.aiWorkflow.update).not.toHaveBeenCalled();
    expect(tx.aiWorkflowVersion.update).not.toHaveBeenCalled();
    expect(tx.aiAdminAuditLog.create).not.toHaveBeenCalled();
    expect(result.workflowsChanged).toBe(0);
  });

  it('counts each workflow it changed', async () => {
    const wf = (id: string) => ({
      id,
      name: id,
      orgId: null,
      draftDefinition: definition(approval('ap', [USER_ID])),
      versions: [],
    });
    tx.aiWorkflow.findMany.mockResolvedValue([wf('a'), wf('b')]);

    const result = await run(tx);

    expect(result).toEqual({ escalationListsChanged: 0, workflowsChanged: 2 });
    expect(tx.aiAdminAuditLog.create).toHaveBeenCalledTimes(2);
  });
});
