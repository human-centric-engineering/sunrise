/**
 * Tests for `lib/orchestration/backup/exporter.ts`
 *
 * Verifies that exportOrchestrationConfig(SHARED_SCOPE) queries Prisma correctly,
 * assembles the backup payload structure, and excludes secrets.
 *
 * @see lib/orchestration/backup/exporter.ts
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mocks (declared before imports) ────────────────────────────────────────

const mockFindMany = vi.fn();
const mockFindUnique = vi.fn();
/** Records `model` and the tenant org each query ran in, in call order. */
const queryLog = vi.hoisted(() => ({
  entries: [] as { model: string; orgId: string | null | undefined }[],
}));
const mockTenantOrg = vi.hoisted(() => ({ read: (): string | null | undefined => undefined }));

function logged(model: string) {
  return (...a: unknown[]) => {
    queryLog.entries.push({ model, orgId: mockTenantOrg.read() });
    return model === 'aiOrchestrationSettings' ? mockFindUnique(...a) : mockFindMany(...a);
  };
}

vi.mock('@/lib/db/client', () => ({
  prisma: {
    aiAgent: { findMany: logged('aiAgent') },
    aiCapability: { findMany: logged('aiCapability') },
    aiWorkflow: { findMany: logged('aiWorkflow') },
    aiWebhookSubscription: { findMany: logged('aiWebhookSubscription') },
    knowledgeTag: { findMany: logged('knowledgeTag') },
    aiOrchestrationSettings: { findUnique: logged('aiOrchestrationSettings') },
  },
}));

// ─── Imports after mocks ─────────────────────────────────────────────────────

import { exportOrchestrationConfig } from '@/lib/orchestration/backup/exporter';
import { getTenantContext } from '@/lib/tenancy/context';
import type { BackupScope } from '@/lib/orchestration/backup/scope';
import { BUILTIN_WORKFLOW_TEMPLATES } from '@/prisma/seeds/data/templates';

// The real tenant context is used, so a query's org is observed, not assumed.
mockTenantOrg.read = () => getTenantContext()?.orgId;

const SHARED_SCOPE: BackupScope = { orgId: 'install', includeShared: true };
const OWN_SCOPE: BackupScope = { orgId: 'org_customer', includeShared: false };

// ─── Fixtures ────────────────────────────────────────────────────────────────

const agentRow = {
  name: 'Support Bot',
  slug: 'support-bot',
  description: 'Handles support queries',
  systemInstructions: 'You are helpful.',
  model: 'gpt-4o',
  provider: 'openai',
  fallbackProviders: [],
  temperature: 0.7,
  maxTokens: 2048,
  monthlyBudgetUsd: null,
  visibility: 'internal',
  isActive: true,
  metadata: null,
  knowledgeCategories: [],
  knowledgeAccessMode: 'full',
  knowledgeRetrievalMode: 'keywords',
  topicBoundaries: [],
  brandVoiceInstructions: null,
  widgetConfig: null,
  // Discriminator + inheritance + attachment + runtime-prompt fields — these
  // were silently dropped from config backups before; distinctive values here
  // assert they now round-trip rather than reverting to defaults.
  kind: 'judge',
  reasoningEffort: 'high',
  persona: 'A terse support persona',
  guardrails: 'Never disclose internal pricing',
  personaMode: 'append',
  voiceMode: 'append',
  guardrailsMode: 'append',
  enableVoiceInput: true,
  enableImageInput: true,
  enableDocumentInput: true,
  runtimePromptManaged: true,
  runtimePromptNote: 'Prompt assembled in app code',
  // Include shape from the new exporter query — no grants for the default fixture.
  grantedTags: [],
  grantedDocuments: [],
};

const capabilityRow = {
  name: 'Web Search',
  slug: 'web-search',
  description: 'Searches the web',
  category: 'retrieval',
  functionDefinition: { type: 'object' },
  executionType: 'builtin',
  executionHandler: 'web_search',
  executionConfig: null,
  requiresApproval: false,
  rateLimit: null,
  isActive: true,
};

const workflowRow = {
  name: 'Onboarding Flow',
  slug: 'onboarding-flow',
  description: 'New user onboarding',
  // Definition is now sourced from the published version relation, not a
  // top-level column. The exporter flattens this back to `workflowDefinition`
  // in the wire payload.
  publishedVersion: { snapshot: { steps: [] } },
  patternsUsed: [],
  isActive: true,
  isTemplate: false,
  metadata: null,
};

// Webhook row as returned by Prisma select (no secret field selected)
const webhookRow = {
  url: 'https://example.com/hook',
  events: ['workflow.completed'],
  description: null,
  isActive: true,
};

const settingsRow = {
  defaultModels: { chat: 'gpt-4o' },
  globalMonthlyBudgetUsd: null,
  searchConfig: null,
  defaultApprovalTimeoutMs: null,
  approvalDefaultAction: null,
  inputGuardMode: null,
  outputGuardMode: null,
  citationGuardMode: null,
  webhookRetentionDays: null,
  costLogRetentionDays: null,
  auditLogRetentionDays: null,
  maxConversationsPerUser: null,
  maxMessagesPerConversation: null,
  escalationConfig: null,
};

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('exportOrchestrationConfig', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    queryLog.entries.length = 0;
  });

  it('returns payload with schemaVersion: 3', async () => {
    mockFindMany
      .mockResolvedValueOnce([]) // agents
      .mockResolvedValueOnce([]) // capabilities
      .mockResolvedValueOnce([]) // workflows
      .mockResolvedValueOnce([]); // webhooks
    mockFindMany.mockResolvedValueOnce([]); // knowledgeTags
    mockFindUnique.mockResolvedValue(null);

    const payload = await exportOrchestrationConfig(SHARED_SCOPE);

    expect(payload.schemaVersion).toBe(3);
  });

  it('returns payload with exportedAt as an ISO string', async () => {
    mockFindMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);
    mockFindMany.mockResolvedValueOnce([]); // knowledgeTags
    mockFindUnique.mockResolvedValue(null);

    const before = new Date().toISOString();
    const payload = await exportOrchestrationConfig(SHARED_SCOPE);
    const after = new Date().toISOString();

    expect(typeof payload.exportedAt).toBe('string');
    // exportedAt should be a valid ISO date between before and after
    expect(payload.exportedAt.localeCompare(before)).toBeGreaterThanOrEqual(0);
    expect(payload.exportedAt.localeCompare(after)).toBeLessThanOrEqual(0);
  });

  it('maps agents array from DB rows', async () => {
    mockFindMany
      .mockResolvedValueOnce([agentRow]) // agents
      .mockResolvedValueOnce([]) // capabilities
      .mockResolvedValueOnce([]) // workflows
      .mockResolvedValueOnce([]); // webhooks
    mockFindMany.mockResolvedValueOnce([]); // knowledgeTags
    mockFindUnique.mockResolvedValue(null);

    const payload = await exportOrchestrationConfig(SHARED_SCOPE);

    expect(payload.data.agents).toHaveLength(1);
    const exported = payload.data.agents[0];
    expect(exported.name).toBe('Support Bot');
    expect(exported.slug).toBe('support-bot');
    // Fields that a config backup previously dropped — assert they survive.
    expect(exported.kind).toBe('judge');
    expect(exported.reasoningEffort).toBe('high');
    expect(exported.persona).toBe('A terse support persona');
    expect(exported.guardrails).toBe('Never disclose internal pricing');
    expect(exported.personaMode).toBe('append');
    expect(exported.voiceMode).toBe('append');
    expect(exported.guardrailsMode).toBe('append');
    expect(exported.enableVoiceInput).toBe(true);
    expect(exported.enableImageInput).toBe(true);
    expect(exported.enableDocumentInput).toBe(true);
    expect(exported.runtimePromptManaged).toBe(true);
    expect(exported.runtimePromptNote).toBe('Prompt assembled in app code');
  });

  it('queries agents with where: { isSystem: false }', async () => {
    mockFindMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);
    mockFindMany.mockResolvedValueOnce([]); // knowledgeTags
    mockFindUnique.mockResolvedValue(null);

    await exportOrchestrationConfig(SHARED_SCOPE);

    // First findMany call is for agents
    const firstCall = mockFindMany.mock.calls[0][0] as { where?: { isSystem?: boolean } };
    expect(firstCall?.where?.isSystem).toBe(false);
  });

  it('returns data.settings as null when no settings record exists', async () => {
    mockFindMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);
    mockFindMany.mockResolvedValueOnce([]); // knowledgeTags
    mockFindUnique.mockResolvedValue(null);

    const payload = await exportOrchestrationConfig(SHARED_SCOPE);

    expect(payload.data.settings).toBeNull();
  });

  it('includes settings fields when a settings record exists', async () => {
    mockFindMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);
    mockFindMany.mockResolvedValueOnce([]); // knowledgeTags
    mockFindUnique.mockResolvedValue(settingsRow);

    const payload = await exportOrchestrationConfig(SHARED_SCOPE);

    expect(payload.data.settings).not.toBeNull();
    expect(payload.data.settings?.defaultModels).toEqual({ chat: 'gpt-4o' });
    expect(payload.data.settings?.globalMonthlyBudgetUsd).toBeNull();
  });

  it('reads and exports the failed-webhook retention window (#838)', async () => {
    mockFindMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);
    mockFindMany.mockResolvedValueOnce([]); // knowledgeTags
    mockFindUnique.mockResolvedValue({ ...settingsRow, webhookDlqRetentionDays: 120 });

    const payload = await exportOrchestrationConfig(SHARED_SCOPE);

    // The mock ignores `select`, so assert the column is actually asked for.
    expect(mockFindUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        select: expect.objectContaining({ webhookDlqRetentionDays: true }),
      })
    );
    expect(payload.data.settings?.webhookDlqRetentionDays).toBe(120);
  });

  it('webhook entries do not have a secret field (secrets are never exported)', async () => {
    // The Prisma select excludes secret — the row never has it
    mockFindMany
      .mockResolvedValueOnce([]) // agents
      .mockResolvedValueOnce([]) // capabilities
      .mockResolvedValueOnce([]) // workflows
      .mockResolvedValueOnce([webhookRow]); // webhooks — no secret
    mockFindMany.mockResolvedValueOnce([]); // knowledgeTags
    mockFindUnique.mockResolvedValue(null);

    const payload = await exportOrchestrationConfig(SHARED_SCOPE);

    expect(payload.data.webhooks).toHaveLength(1);
    expect(payload.data.webhooks[0]).not.toHaveProperty('secret');
    expect(payload.data.webhooks[0].url).toBe('https://example.com/hook');
  });

  it('narrows an email-channel webhook to the "email" literal', async () => {
    mockFindMany
      .mockResolvedValueOnce([]) // agents
      .mockResolvedValueOnce([]) // capabilities
      .mockResolvedValueOnce([]) // workflows
      .mockResolvedValueOnce([
        { ...webhookRow, channel: 'email', emailAddress: 'ops@example.com' },
      ]);
    mockFindMany.mockResolvedValueOnce([]); // knowledgeTags
    mockFindUnique.mockResolvedValue(null);

    const payload = await exportOrchestrationConfig(SHARED_SCOPE);

    expect(payload.data.webhooks[0].channel).toBe('email');
  });

  it('returns all four data collections in the correct positions', async () => {
    mockFindMany
      .mockResolvedValueOnce([agentRow])
      .mockResolvedValueOnce([capabilityRow])
      .mockResolvedValueOnce([workflowRow])
      .mockResolvedValueOnce([webhookRow]);
    mockFindMany.mockResolvedValueOnce([]); // knowledgeTags
    mockFindUnique.mockResolvedValue(settingsRow);

    const payload = await exportOrchestrationConfig(SHARED_SCOPE);

    expect(payload.data.agents).toHaveLength(1);
    expect(payload.data.capabilities).toHaveLength(1);
    expect(payload.data.workflows).toHaveLength(1);
    expect(payload.data.webhooks).toHaveLength(1);
    expect(payload.data.settings).not.toBeNull();
  });

  describe('the renamed-copy marker', () => {
    /** Export the given workflow rows and return the metadata of each exported workflow. */
    async function exportedMetadata(...metadata: unknown[]) {
      const rows = metadata.map((m, i) => ({ ...workflowRow, slug: `wf-${i}`, metadata: m }));
      mockFindMany
        .mockResolvedValueOnce([]) // agents
        .mockResolvedValueOnce([]) // capabilities
        .mockResolvedValueOnce(rows) // workflows
        .mockResolvedValueOnce([]); // webhooks
      mockFindMany.mockResolvedValueOnce([]); // knowledgeTags
      mockFindUnique.mockResolvedValue(null);
      const payload = await exportOrchestrationConfig(SHARED_SCOPE);
      return payload.data.workflows.map((w) => w.metadata);
    }

    it('strips importedFromSlug and keeps the rest of the metadata', async () => {
      const [meta] = await exportedMetadata({
        owner: 'ops',
        nested: { a: 1 },
        importedFromSlug: 'other-org-slug',
      });

      expect(meta).toEqual({ owner: 'ops', nested: { a: 1 } });
      expect(meta).not.toHaveProperty('importedFromSlug');
    });

    it('leaves metadata without the marker untouched', async () => {
      const original = { owner: 'ops' };

      const [meta] = await exportedMetadata(original);

      expect(meta).toEqual({ owner: 'ops' });
    });

    it('exports metadata holding only the marker as an empty object', async () => {
      const [meta] = await exportedMetadata({ importedFromSlug: 'x' });

      expect(meta).toEqual({});
    });

    it.each([
      ['null', null],
      ['an array', ['importedFromSlug', 'x']],
      ['a string', 'importedFromSlug'],
      ['a number', 7],
    ])('passes %s through unchanged', async (_label, value) => {
      const [meta] = await exportedMetadata(value);

      expect(meta).toEqual(value);
    });
  });

  it('skips workflows that have no published version (no exportable snapshot)', async () => {
    // Edge case: a workflow row with publishedVersion=null can't be exported
    // because the snapshot lives there in the new model. The exporter's
    // flatMap drops such rows rather than emitting an entry with no
    // workflowDefinition.
    const unpublishedRow = { ...workflowRow, slug: 'never-published', publishedVersion: null };
    mockFindMany
      .mockResolvedValueOnce([]) // agents
      .mockResolvedValueOnce([]) // capabilities
      .mockResolvedValueOnce([workflowRow, unpublishedRow]) // workflows: one with, one without
      .mockResolvedValueOnce([]); // webhooks
    mockFindMany.mockResolvedValueOnce([]); // knowledgeTags
    mockFindUnique.mockResolvedValue(null);

    const payload = await exportOrchestrationConfig(SHARED_SCOPE);

    expect(payload.data.workflows).toHaveLength(1);
    expect(payload.data.workflows[0].slug).toBe('onboarding-flow');
  });

  it('exports knowledgeTags when present in the DB', async () => {
    const tagRow = { slug: 'support', name: 'Support', description: 'support topics' };
    mockFindMany
      .mockResolvedValueOnce([]) // agents
      .mockResolvedValueOnce([]) // capabilities
      .mockResolvedValueOnce([]) // workflows
      .mockResolvedValueOnce([]); // webhooks
    mockFindMany.mockResolvedValueOnce([tagRow]); // knowledgeTags
    mockFindUnique.mockResolvedValue(null);

    const payload = await exportOrchestrationConfig(SHARED_SCOPE);

    expect(payload.data.knowledgeTags).toHaveLength(1);
    expect(payload.data.knowledgeTags[0].slug).toBe('support');
    expect(payload.data.knowledgeTags[0].name).toBe('Support');
  });

  it('emits knowledgeAccessMode as "restricted" when the DB row has that value', async () => {
    // This exercises the ternary on line ~142: knowledgeAccessMode === 'restricted'
    const restrictedAgentRow = {
      ...agentRow,
      knowledgeAccessMode: 'restricted',
    };
    mockFindMany
      .mockResolvedValueOnce([restrictedAgentRow]) // agents
      .mockResolvedValueOnce([]) // capabilities
      .mockResolvedValueOnce([]) // workflows
      .mockResolvedValueOnce([]); // webhooks
    mockFindMany.mockResolvedValueOnce([]); // knowledgeTags
    mockFindUnique.mockResolvedValue(null);

    const payload = await exportOrchestrationConfig(SHARED_SCOPE);

    expect(payload.data.agents[0].knowledgeAccessMode).toBe('restricted');
  });

  it('emits knowledgeAccessMode as "full" for any non-restricted value', async () => {
    // Any value that is not 'restricted' coerces to 'full' (the else branch)
    const fullAgentRow = {
      ...agentRow,
      knowledgeAccessMode: 'full',
    };
    mockFindMany
      .mockResolvedValueOnce([fullAgentRow]) // agents
      .mockResolvedValueOnce([]) // capabilities
      .mockResolvedValueOnce([]) // workflows
      .mockResolvedValueOnce([]); // webhooks
    mockFindMany.mockResolvedValueOnce([]); // knowledgeTags
    mockFindUnique.mockResolvedValue(null);

    const payload = await exportOrchestrationConfig(SHARED_SCOPE);

    expect(payload.data.agents[0].knowledgeAccessMode).toBe('full');
  });

  it('narrows the discriminator/inheritance/reasoning enums on the fallback side', async () => {
    // The default fixture exercises judge/append/high/keywords; this row covers
    // the other branch of each narrowing: chat, override, an unrecognised
    // reasoningEffort coerced to null, and an unrecognised retrieval mode coerced
    // to 'model'.
    const fallbackAgentRow = {
      ...agentRow,
      kind: 'chat',
      personaMode: 'override',
      voiceMode: 'override',
      guardrailsMode: 'override',
      reasoningEffort: 'not-a-real-effort',
      knowledgeRetrievalMode: 'not-a-real-mode',
    };
    mockFindMany
      .mockResolvedValueOnce([fallbackAgentRow]) // agents
      .mockResolvedValueOnce([]) // capabilities
      .mockResolvedValueOnce([]) // workflows
      .mockResolvedValueOnce([]); // webhooks
    mockFindMany.mockResolvedValueOnce([]); // knowledgeTags
    mockFindUnique.mockResolvedValue(null);

    const payload = await exportOrchestrationConfig(SHARED_SCOPE);

    const exported = payload.data.agents[0];
    expect(exported.kind).toBe('chat');
    expect(exported.personaMode).toBe('override');
    expect(exported.voiceMode).toBe('override');
    expect(exported.guardrailsMode).toBe('override');
    expect(exported.reasoningEffort).toBeNull();
    expect(exported.knowledgeRetrievalMode).toBe('model');
  });

  it('flattens grantedTags into grantedTagSlugs array', async () => {
    const agentWithGrants = {
      ...agentRow,
      grantedTags: [{ tag: { slug: 'billing' } }, { tag: { slug: 'support' } }],
      grantedDocuments: [],
    };
    mockFindMany
      .mockResolvedValueOnce([agentWithGrants]) // agents
      .mockResolvedValueOnce([]) // capabilities
      .mockResolvedValueOnce([]) // workflows
      .mockResolvedValueOnce([]); // webhooks
    mockFindMany.mockResolvedValueOnce([]); // knowledgeTags
    mockFindUnique.mockResolvedValue(null);

    const payload = await exportOrchestrationConfig(SHARED_SCOPE);

    expect(payload.data.agents[0].grantedTagSlugs).toEqual(['billing', 'support']);
  });

  it('flattens grantedDocuments into grantedDocumentSlugs array (v3 — by slug)', async () => {
    const agentWithDocs = {
      ...agentRow,
      grantedTags: [],
      grantedDocuments: [
        { document: { slug: 'doc-one-abc123ab' } },
        { document: { slug: 'doc-two-def456cd' } },
      ],
    };
    mockFindMany
      .mockResolvedValueOnce([agentWithDocs]) // agents
      .mockResolvedValueOnce([]) // capabilities
      .mockResolvedValueOnce([]) // workflows
      .mockResolvedValueOnce([]); // webhooks
    mockFindMany.mockResolvedValueOnce([]); // knowledgeTags
    mockFindUnique.mockResolvedValue(null);

    const payload = await exportOrchestrationConfig(SHARED_SCOPE);

    expect(payload.data.agents[0].grantedDocumentSlugs).toEqual([
      'doc-one-abc123ab',
      'doc-two-def456cd',
    ]);
    // v3 no longer emits the legacy fileHash-keyed field.
    expect(payload.data.agents[0].grantedDocumentHashes).toBeUndefined();
  });

  it('always emits empty knowledgeCategories array (legacy field kept on wire)', async () => {
    // knowledgeCategories was dropped from the DB in Phase 6 but the backup
    // schema keeps the field on the wire. The exporter always emits [] for it.
    mockFindMany
      .mockResolvedValueOnce([agentRow]) // agents
      .mockResolvedValueOnce([]) // capabilities
      .mockResolvedValueOnce([]) // workflows
      .mockResolvedValueOnce([]); // webhooks
    mockFindMany.mockResolvedValueOnce([]); // knowledgeTags
    mockFindUnique.mockResolvedValue(null);

    const payload = await exportOrchestrationConfig(SHARED_SCOPE);

    expect(payload.data.agents[0].knowledgeCategories).toEqual([]);
  });

  it('queries capabilities with where: { isSystem: false }', async () => {
    mockFindMany
      .mockResolvedValueOnce([]) // agents
      .mockResolvedValueOnce([]) // capabilities
      .mockResolvedValueOnce([]) // workflows
      .mockResolvedValueOnce([]); // webhooks
    mockFindMany.mockResolvedValueOnce([]); // knowledgeTags
    mockFindUnique.mockResolvedValue(null);

    await exportOrchestrationConfig(SHARED_SCOPE);

    // Second findMany call is for capabilities
    const capCall = mockFindMany.mock.calls[1][0] as { where?: { isSystem?: boolean } };
    expect(capCall?.where?.isSystem).toBe(false);
  });
  it('leaves out system workflows and template rows holding a built-in slug, and nothing else (§116 t-727, t-729)', async () => {
    mockFindMany
      .mockResolvedValueOnce([]) // agents
      .mockResolvedValueOnce([]) // capabilities
      .mockResolvedValueOnce([]) // workflows
      .mockResolvedValueOnce([]); // webhooks
    mockFindMany.mockResolvedValueOnce([]); // knowledgeTags
    mockFindUnique.mockResolvedValue(null);

    await exportOrchestrationConfig(SHARED_SCOPE);

    // Third findMany call is for workflows. Two kinds are left out: a system
    // workflow, by its flag or its reserved slug (the seed's, as system agents
    // and capabilities are; the importer refuses the slug, so a bundle must
    // not carry it — t-729),
    // and a TEMPLATE row with a built-in slug, a seed-era copy of a template
    // served from code. The same slug on an ordinary workflow (a retired row
    // an install switched back on) is live config and must be backed up.
    const wfCall = mockFindMany.mock.calls[2][0] as {
      where?: {
        isSystem?: boolean;
        slug?: { notIn?: string[] };
        NOT?: { isTemplate?: boolean; slug?: { in?: string[] } };
      };
    };
    expect(wfCall?.where).toEqual({
      isSystem: false,
      slug: { notIn: ['tpl-provider-model-audit'] },
      NOT: { isTemplate: true, slug: { in: expect.any(Array) } },
    });
    expect([...(wfCall?.where?.NOT?.slug?.in ?? [])].sort()).toEqual(
      BUILTIN_WORKFLOW_TEMPLATES.map((t) => t.slug).sort()
    );
  });
});

describe('exportOrchestrationConfig — scope (§109 t-738)', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    queryLog.entries.length = 0;
    mockFindMany.mockResolvedValue([]);
    mockFindUnique.mockResolvedValue(null);
  });

  it('runs every query inside the target org, not outside any tenant context', async () => {
    await exportOrchestrationConfig({ orgId: 'org_customer', includeShared: true });

    // All six queries ran, each seeing the target org as its tenant context.
    expect(queryLog.entries.map((e) => e.model).sort()).toEqual([
      'aiAgent',
      'aiCapability',
      'aiOrchestrationSettings',
      'aiWebhookSubscription',
      'aiWorkflow',
      'knowledgeTag',
    ]);
    expect(queryLog.entries.every((e) => e.orgId === 'org_customer')).toBe(true);
    // The scope does not leak out once the export has returned.
    expect(getTenantContext()).toBeNull();
  });

  it('reads no shared-part table when includeShared is false, and emits them empty', async () => {
    mockFindMany.mockResolvedValue([]);

    const payload = await exportOrchestrationConfig(OWN_SCOPE);

    expect(queryLog.entries.map((e) => e.model).sort()).toEqual([
      'aiAgent',
      'aiWebhookSubscription',
      'aiWorkflow',
    ]);
    expect(queryLog.entries.every((e) => e.orgId === 'org_customer')).toBe(true);
    expect(payload.data.capabilities).toEqual([]);
    expect(payload.data.knowledgeTags).toEqual([]);
    expect(payload.data.settings).toBeNull();
  });

  it('keeps the org-owned part when includeShared is false', async () => {
    mockFindMany
      .mockResolvedValueOnce([agentRow]) // agents
      .mockResolvedValueOnce([workflowRow]) // workflows
      .mockResolvedValueOnce([webhookRow]); // webhooks

    const payload = await exportOrchestrationConfig(OWN_SCOPE);

    expect(payload.data.agents.map((a) => a.slug)).toEqual(['support-bot']);
    expect(payload.data.workflows.map((w) => w.slug)).toEqual(['onboarding-flow']);
    expect(payload.data.webhooks.map((w) => w.url)).toEqual(['https://example.com/hook']);
  });

  it('emits capabilities, tags and settings when includeShared is true', async () => {
    mockFindMany.mockImplementation(async () => []);
    mockFindMany
      .mockResolvedValueOnce([]) // agents
      .mockResolvedValueOnce([capabilityRow]) // capabilities
      .mockResolvedValueOnce([]) // workflows
      .mockResolvedValueOnce([]) // webhooks
      .mockResolvedValueOnce([{ slug: 'support', name: 'Support', description: null }]);
    mockFindUnique.mockResolvedValue(settingsRow);

    const payload = await exportOrchestrationConfig(SHARED_SCOPE);

    expect(payload.data.capabilities.map((c) => c.slug)).toEqual(['web-search']);
    expect(payload.data.knowledgeTags).toEqual([
      { slug: 'support', name: 'Support', description: null },
    ]);
    expect(payload.data.settings).toMatchObject({ defaultModels: { chat: 'gpt-4o' } });
    expect(mockFindUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { slug: 'global' } })
    );
  });
});
