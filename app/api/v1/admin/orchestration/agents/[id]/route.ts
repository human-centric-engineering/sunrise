/**
 * Admin Orchestration — Single agent (GET / PATCH / DELETE)
 *
 * GET    /api/v1/admin/orchestration/agents/:id
 * PATCH  /api/v1/admin/orchestration/agents/:id
 *   - When `systemInstructions` changes, the previous value is pushed
 *     onto `systemInstructionsHistory` with `{instructions, changedAt, changedBy}`.
 * DELETE /api/v1/admin/orchestration/agents/:id
 *   - Soft delete: sets `isActive = false`. Hard delete would either
 *     cascade conversation/message/cost-log history or fail; soft delete
 *     preserves the audit trail.
 *
 * Authentication: Admin role required.
 */

import { Prisma } from '@prisma/client';
import { withAdminAuth } from '@/lib/auth/guards';
import { prisma } from '@/lib/db/client';
import { successResponse } from '@/lib/api/responses';
import { ForbiddenError, NotFoundError, ValidationError } from '@/lib/api/errors';
import { validateRequestBody } from '@/lib/api/validation';
import { getRouteLogger } from '@/lib/api/context';
import { adminLimiter, createRateLimitResponse } from '@/lib/security/rate-limit';
import { getClientIP } from '@/lib/security/ip';
import { logAdminAction, computeChanges } from '@/lib/orchestration/audit/admin-audit-logger';
import { emitHookEvent } from '@/lib/orchestration/hooks/registry';
import { logger } from '@/lib/logging';
import {
  systemInstructionsHistorySchema,
  updateAgentSchema,
  type SystemInstructionsHistoryEntry,
} from '@/lib/validations/orchestration';
import { cuidSchema } from '@/lib/validations/common';

function parseAgentId(raw: string): string {
  const parsed = cuidSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ValidationError('Invalid agent id', { id: ['Must be a valid CUID'] });
  }
  return parsed.data;
}

export const GET = withAdminAuth<{ id: string }>(async (request, _session, { params }) => {
  const clientIP = getClientIP(request);
  const rateLimit = adminLimiter.check(clientIP);
  if (!rateLimit.success) return createRateLimitResponse(rateLimit);

  const log = await getRouteLogger(request);
  const { id: rawId } = await params;
  const id = parseAgentId(rawId);

  const agent = await prisma.aiAgent.findUnique({ where: { id } });
  if (!agent) throw new NotFoundError(`Agent ${id} not found`);

  log.info('Agent fetched', { agentId: id });
  return successResponse(agent);
});

export const PATCH = withAdminAuth<{ id: string }>(async (request, session, { params }) => {
  const clientIP = getClientIP(request);
  const rateLimit = adminLimiter.check(clientIP);
  if (!rateLimit.success) return createRateLimitResponse(rateLimit);

  const log = await getRouteLogger(request);
  const { id: rawId } = await params;
  const id = parseAgentId(rawId);

  const current = await prisma.aiAgent.findUnique({ where: { id } });
  if (!current) throw new NotFoundError(`Agent ${id} not found`);

  const body = await validateRequestBody(request, updateAgentSchema);

  // System agents cannot be deactivated via PATCH (equivalent to deletion).
  if (current.isSystem && body.isActive === false) {
    throw new ForbiddenError('System agents cannot be deactivated');
  }

  // System agent slugs are used internally — prevent mutation.
  if (current.isSystem && body.slug !== undefined && body.slug !== current.slug) {
    throw new ForbiddenError('System agent slugs cannot be changed');
  }

  // System agent instructions are read-only to preserve rollback consistency.
  if (
    current.isSystem &&
    body.systemInstructions !== undefined &&
    body.systemInstructions !== current.systemInstructions
  ) {
    throw new ForbiddenError('System agent instructions cannot be modified');
  }

  // Build the update payload. Only include fields the caller actually sent.
  const data: Prisma.AiAgentUpdateInput = {};
  if (body.name !== undefined) data.name = body.name;
  if (body.slug !== undefined) data.slug = body.slug;
  if (body.description !== undefined) data.description = body.description;
  if (body.model !== undefined) data.model = body.model;
  if (body.provider !== undefined) data.provider = body.provider;
  if (body.providerConfig !== undefined) {
    data.providerConfig = body.providerConfig as Prisma.InputJsonValue;
  }
  if (body.temperature !== undefined) data.temperature = body.temperature;
  if (body.maxTokens !== undefined) data.maxTokens = body.maxTokens;
  if (body.monthlyBudgetUsd !== undefined) data.monthlyBudgetUsd = body.monthlyBudgetUsd;
  if (body.metadata !== undefined) {
    data.metadata = body.metadata as Prisma.InputJsonValue;
  }
  if (body.isActive !== undefined) data.isActive = body.isActive;
  if (body.knowledgeCategories !== undefined) data.knowledgeCategories = body.knowledgeCategories;
  if (body.topicBoundaries !== undefined) data.topicBoundaries = body.topicBoundaries;
  if (body.brandVoiceInstructions !== undefined)
    data.brandVoiceInstructions = body.brandVoiceInstructions;
  if (body.rateLimitRpm !== undefined) data.rateLimitRpm = body.rateLimitRpm;
  if (body.visibility !== undefined) data.visibility = body.visibility;
  if (body.fallbackProviders !== undefined) data.fallbackProviders = body.fallbackProviders;
  if (body.inputGuardMode !== undefined) data.inputGuardMode = body.inputGuardMode;
  if (body.outputGuardMode !== undefined) data.outputGuardMode = body.outputGuardMode;
  if (body.citationGuardMode !== undefined) data.citationGuardMode = body.citationGuardMode;
  if (body.maxHistoryTokens !== undefined) data.maxHistoryTokens = body.maxHistoryTokens;
  if (body.retentionDays !== undefined) data.retentionDays = body.retentionDays;
  if (body.enableVoiceInput !== undefined) data.enableVoiceInput = body.enableVoiceInput;
  if (body.enableImageInput !== undefined) data.enableImageInput = body.enableImageInput;
  if (body.enableDocumentInput !== undefined) data.enableDocumentInput = body.enableDocumentInput;

  // Audit: if systemInstructions actually changed, push the old value
  // onto the history column before writing the new one.
  if (
    body.systemInstructions !== undefined &&
    body.systemInstructions !== current.systemInstructions
  ) {
    const historyParse = systemInstructionsHistorySchema.safeParse(
      current.systemInstructionsHistory
    );
    if (!historyParse.success) {
      logger.warn('Agent PATCH: systemInstructionsHistory malformed, resetting', {
        agentId: id,
        issues: historyParse.error.issues,
      });
    }
    const history: SystemInstructionsHistoryEntry[] = historyParse.success ? historyParse.data : [];
    history.push({
      instructions: current.systemInstructions,
      changedAt: new Date().toISOString(),
      changedBy: session.user.id,
    });
    data.systemInstructions = body.systemInstructions;
    data.systemInstructionsHistory = history as unknown as Prisma.InputJsonValue;
  }

  // Version-triggering fields — snapshot the current config before
  // the update if any of these are changing. `name`, `slug`,
  // `description`, and `isActive` are intentionally excluded: they're
  // metadata / operational state, not part of the agent's behavioural
  // fingerprint. Everything the agent form exposes that affects
  // runtime behaviour belongs here.
  const VERSIONED_FIELDS = [
    'systemInstructions',
    'model',
    'temperature',
    'maxTokens',
    'topicBoundaries',
    'brandVoiceInstructions',
    'provider',
    'fallbackProviders',
    'knowledgeCategories',
    'rateLimitRpm',
    'visibility',
    'inputGuardMode',
    'outputGuardMode',
    'citationGuardMode',
    'maxHistoryTokens',
    'retentionDays',
    'providerConfig',
    'monthlyBudgetUsd',
    'metadata',
    'enableVoiceInput',
    'enableImageInput',
    'enableDocumentInput',
  ] as const;

  // Only treat a versioned field as "changed" if the new value actually
  // differs from the stored value. Previously this filtered on
  // `data[f] !== undefined` alone — but the form sends back its full
  // state on every save, so every versioned field was always in `data`
  // and every save bumped the version with a misleading "X changed"
  // summary. Now we compare against `current`:
  //   - Primitive equality for scalars
  //   - Shallow elementwise for string[] (fallbackProviders,
  //     knowledgeCategories, topicBoundaries — all string arrays)
  //   - JSON-stringify for the Prisma `Json` columns (providerConfig,
  //     metadata) which round-trip as plain values
  const isFieldChanged = (newValue: unknown, currentValue: unknown): boolean => {
    if (Array.isArray(newValue) && Array.isArray(currentValue)) {
      if (newValue.length !== currentValue.length) return true;
      for (let i = 0; i < newValue.length; i++) {
        if (newValue[i] !== currentValue[i]) return true;
      }
      return false;
    }
    if (
      (newValue !== null && typeof newValue === 'object') ||
      (currentValue !== null && typeof currentValue === 'object')
    ) {
      return JSON.stringify(newValue ?? null) !== JSON.stringify(currentValue ?? null);
    }
    return newValue !== currentValue;
  };

  const changedVersionedFields = VERSIONED_FIELDS.filter(
    (f) =>
      data[f] !== undefined &&
      isFieldChanged(data[f], (current as unknown as Record<string, unknown>)[f])
  );

  try {
    // Auto-create version snapshot if versioned fields changed.
    // Both the snapshot and the update run inside a transaction so an
    // update failure doesn't leave an orphaned version entry.
    const agent = await prisma.$transaction(async (tx) => {
      if (changedVersionedFields.length > 0) {
        // Get next version number
        const lastVersion = await tx.aiAgentVersion.findFirst({
          where: { agentId: id },
          orderBy: { version: 'desc' },
          select: { version: true },
        });
        const nextVersion = (lastVersion?.version ?? 0) + 1;

        // Snapshot the current (pre-update) agent config
        const snapshot = {
          systemInstructions: current.systemInstructions,
          model: current.model,
          provider: current.provider,
          fallbackProviders: current.fallbackProviders,
          temperature: current.temperature,
          maxTokens: current.maxTokens,
          topicBoundaries: current.topicBoundaries,
          brandVoiceInstructions: current.brandVoiceInstructions,
          metadata: current.metadata,
          knowledgeCategories: current.knowledgeCategories,
          rateLimitRpm: current.rateLimitRpm,
          visibility: current.visibility,
          inputGuardMode: current.inputGuardMode,
          outputGuardMode: current.outputGuardMode,
          citationGuardMode: current.citationGuardMode,
          maxHistoryTokens: current.maxHistoryTokens,
          retentionDays: current.retentionDays,
          providerConfig: current.providerConfig,
          monthlyBudgetUsd: current.monthlyBudgetUsd,
          enableVoiceInput: current.enableVoiceInput,
        };

        const changeSummary = changedVersionedFields.map((f) => `${f} changed`).join(', ');

        await tx.aiAgentVersion.create({
          data: {
            agentId: id,
            version: nextVersion,
            snapshot: snapshot as unknown as Prisma.InputJsonValue,
            changeSummary,
            createdBy: session.user.id,
          },
        });

        log.info('Agent version snapshot created', {
          agentId: id,
          version: nextVersion,
          changes: changedVersionedFields,
        });
      }

      return tx.aiAgent.update({ where: { id }, data });
    });

    log.info('Agent updated', {
      agentId: id,
      adminId: session.user.id,
      fieldsChanged: Object.keys(data),
    });

    logAdminAction({
      userId: session.user.id,
      action: 'agent.update',
      entityType: 'agent',
      entityId: id,
      entityName: agent.name,
      changes: computeChanges(
        current as unknown as Record<string, unknown>,
        agent as unknown as Record<string, unknown>
      ),
      clientIp: clientIP,
    });

    emitHookEvent('agent.updated', {
      agentId: id,
      agentSlug: agent.slug,
      fieldsChanged: Object.keys(data),
    });

    return successResponse(agent);
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      throw new ValidationError(`Agent with slug '${body.slug}' already exists`, {
        slug: ['Slug is already in use'],
      });
    }
    throw err;
  }
});

export const DELETE = withAdminAuth<{ id: string }>(async (request, session, { params }) => {
  const clientIP = getClientIP(request);
  const rateLimit = adminLimiter.check(clientIP);
  if (!rateLimit.success) return createRateLimitResponse(rateLimit);

  const log = await getRouteLogger(request);
  const { id: rawId } = await params;
  const id = parseAgentId(rawId);

  const current = await prisma.aiAgent.findUnique({ where: { id } });
  if (!current) throw new NotFoundError(`Agent ${id} not found`);

  if (current.isSystem) {
    throw new ForbiddenError('System agents cannot be deleted');
  }

  const agent = await prisma.aiAgent.update({
    where: { id },
    data: { isActive: false },
  });

  log.info('Agent soft-deleted', {
    agentId: id,
    slug: agent.slug,
    adminId: session.user.id,
  });

  logAdminAction({
    userId: session.user.id,
    action: 'agent.delete',
    entityType: 'agent',
    entityId: id,
    entityName: current.name,
    clientIp: clientIP,
  });

  return successResponse({ id, isActive: false });
});
