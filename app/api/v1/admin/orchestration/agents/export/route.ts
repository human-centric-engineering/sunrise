/**
 * Admin Orchestration — Export agents bundle
 *
 * POST /api/v1/admin/orchestration/agents/export
 *   Body: { agentIds: string[] }
 *   Returns a versioned `AgentBundle` containing the selected agents, their
 *   attached capabilities, the linked profile, and granted knowledge tags and
 *   documents — all carried by slug so they re-link on import. Server-owned
 *   fields (`id`, `createdAt`, `updatedAt`, `createdBy`) are stripped so the
 *   bundle is portable across environments. Document grants use
 *   `AiKnowledgeDocument.slug` (the stable cross-environment key — #338).
 *
 *   Built-in (system) agents are left out, as the backup export leaves them
 *   out: every install already has its own, they start with an empty
 *   provider and model the bundle schema rejects, and the import would skip
 *   them anyway (#721). A selection of only built-in agents is a 400; a mixed
 *   one says how many it left out in `X-Skipped-System-Agents`, so the admin
 *   is told rather than finding out at import.
 *
 *   The response sets `Content-Disposition: attachment` so hitting the
 *   route directly from a browser triggers a "Save As" dialog.
 *
 * Authentication: Admin role required.
 */

import { z } from 'zod';
import { withAdminAuth } from '@/lib/auth/guards';
import { prisma } from '@/lib/db/client';
import { NotFoundError, ValidationError } from '@/lib/api/errors';
import { successResponse } from '@/lib/api/responses';
import { validateRequestBody } from '@/lib/api/validation';
import { getRouteLogger } from '@/lib/api/context';
import { logger } from '@/lib/logging';
import { REASONING_EFFORTS } from '@/lib/orchestration/llm/types';
import {
  narrowProviderTools,
  narrowServiceTier,
  narrowVerbosity,
} from '@/lib/orchestration/llm/model-params';
import {
  exportAgentsSchema,
  systemInstructionsHistorySchema,
  type AgentBundle,
  type SystemInstructionsHistoryEntry,
} from '@/lib/validations/orchestration';

const jsonRecord = z.record(z.string(), z.unknown()).nullable().catch(null);
const guardModeSchema = z.enum(['log_only', 'warn_and_continue', 'block']).nullable();
const visibilitySchema = z.enum(['internal', 'public', 'invite_only']);
const reasoningEffortSchema = z.enum(REASONING_EFFORTS).nullable().optional();
// Non-null enum columns — `.catch(default)` so a single legacy/malformed row
// degrades to the default instead of failing the whole export.
const kindSchema = z.enum(['chat', 'judge']).catch('chat');
const knowledgeAccessModeSchema = z.enum(['full', 'restricted']).catch('full');
const knowledgeRetrievalModeSchema = z
  .enum(['model', 'first_turn', 'every_turn', 'keywords'])
  .catch('model');
const inheritanceModeSchema = z.enum(['override', 'append']).catch('override');

export const POST = withAdminAuth(
  async (request, session) => {
    const log = await getRouteLogger(request);
    const body = await validateRequestBody(request, exportAgentsSchema);
    const uniqueIds = [...new Set(body.agentIds)];

    const agents = await prisma.aiAgent.findMany({
      where: { id: { in: uniqueIds } },
      include: {
        capabilities: {
          include: {
            capability: { select: { slug: true } },
          },
        },
        profile: { select: { slug: true } },
        grantedTags: { select: { tag: { select: { slug: true } } } },
        grantedDocuments: { select: { document: { select: { slug: true } } } },
      },
    });

    if (agents.length !== uniqueIds.length) {
      const foundIds = new Set(agents.map((a) => a.id));
      const missing = uniqueIds.filter((id) => !foundIds.has(id));
      throw new NotFoundError(`Agents not found: ${missing.join(', ')}`);
    }

    const exportable = agents.filter((agent) => !agent.isSystem);
    if (exportable.length === 0) {
      throw new ValidationError(
        'Built-in agents cannot be exported: every install already has its own. Select at least one of your own agents.',
        { agentIds: ['Every selected agent is a built-in agent'] }
      );
    }

    const bundle: AgentBundle = {
      version: '1',
      exportedAt: new Date().toISOString(),
      agents: exportable.map((agent) => {
        const historyParse = systemInstructionsHistorySchema.safeParse(
          agent.systemInstructionsHistory
        );
        const history: SystemInstructionsHistoryEntry[] = historyParse.success
          ? historyParse.data
          : [];
        if (!historyParse.success) {
          logger.warn('export: systemInstructionsHistory malformed, exporting empty array', {
            agentId: agent.id,
            issues: historyParse.error.issues,
          });
        }

        return {
          name: agent.name,
          slug: agent.slug,
          isSystem: agent.isSystem,
          description: agent.description,
          systemInstructions: agent.systemInstructions,
          systemInstructionsHistory: history,
          model: agent.model,
          provider: agent.provider,
          providerConfig: jsonRecord.parse(agent.providerConfig),
          temperature: agent.temperature,
          maxTokens: agent.maxTokens,
          reasoningEffort: reasoningEffortSchema.parse(agent.reasoningEffort),
          stopSequences: agent.stopSequences,
          topP: agent.topP,
          verbosity: narrowVerbosity(agent.verbosity) ?? null,
          parallelToolCalls: agent.parallelToolCalls,
          serviceTier: narrowServiceTier(agent.serviceTier) ?? null,
          providerTools: narrowProviderTools(agent.providerTools) ?? null,
          monthlyBudgetUsd: agent.monthlyBudgetUsd,
          maxCostPerTurnUsd: agent.maxCostPerTurnUsd,
          metadata: jsonRecord.parse(agent.metadata),
          isActive: agent.isActive,
          fallbackProviders: agent.fallbackProviders,
          rateLimitRpm: agent.rateLimitRpm,
          inputGuardMode: guardModeSchema.parse(agent.inputGuardMode),
          outputGuardMode: guardModeSchema.parse(agent.outputGuardMode),
          citationGuardMode: guardModeSchema.parse(agent.citationGuardMode),
          maxHistoryTokens: agent.maxHistoryTokens,
          maxHistoryMessages: agent.maxHistoryMessages,
          retentionDays: agent.retentionDays,
          visibility: visibilitySchema.parse(agent.visibility),
          topicBoundaries: agent.topicBoundaries,
          brandVoiceInstructions: agent.brandVoiceInstructions,
          widgetConfig: jsonRecord.parse(agent.widgetConfig),
          kind: kindSchema.parse(agent.kind),
          knowledgeAccessMode: knowledgeAccessModeSchema.parse(agent.knowledgeAccessMode),
          knowledgeRetrievalMode: knowledgeRetrievalModeSchema.parse(agent.knowledgeRetrievalMode),
          knowledgeTriggerKeywords: agent.knowledgeTriggerKeywords,
          persona: agent.persona,
          guardrails: agent.guardrails,
          personaMode: inheritanceModeSchema.parse(agent.personaMode),
          voiceMode: inheritanceModeSchema.parse(agent.voiceMode),
          guardrailsMode: inheritanceModeSchema.parse(agent.guardrailsMode),
          enableVoiceInput: agent.enableVoiceInput,
          enableImageInput: agent.enableImageInput,
          enableDocumentInput: agent.enableDocumentInput,
          runtimePromptManaged: agent.runtimePromptManaged,
          runtimePromptNote: agent.runtimePromptNote,
          // Cross-environment relations by stable reference (slug); re-linked on import.
          profileSlug: agent.profile?.slug ?? null,
          knowledgeTagSlugs: agent.grantedTags.map((g) => g.tag.slug),
          knowledgeDocumentSlugs: agent.grantedDocuments.map((g) => g.document.slug),
          capabilities: agent.capabilities.map((link) => ({
            slug: link.capability.slug,
            isEnabled: link.isEnabled,
            customConfig: jsonRecord.parse(link.customConfig),
            customRateLimit: link.customRateLimit,
          })),
        };
      }),
    };

    log.info('Agents exported', {
      count: bundle.agents.length,
      skippedSystemAgents: agents.length - exportable.length,
      adminId: session.user.id,
    });

    const filename = `agents-export-${bundle.exportedAt.replace(/:/g, '-')}.json`;
    return successResponse(bundle, undefined, {
      headers: {
        'Content-Disposition': `attachment; filename="${filename}"`,
        'X-Skipped-System-Agents': String(agents.length - exportable.length),
      },
    });
  },
  {
    tier: 'org',
    ownership: {
      decidedBy: 'nothing',
      because:
        'Agents and what hangs off them (capabilities, tokens, versions, widget config) are the org’s configuration, not anyone’s personal rows; row isolation bounds them to the entered org.',
    },
  }
);
