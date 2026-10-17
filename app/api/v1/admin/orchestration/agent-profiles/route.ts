/**
 * Admin Orchestration — Agent Profiles (list + create)
 *
 * GET  /api/v1/admin/orchestration/agent-profiles — paginated list.
 *      Each row carries `agentCount` so the table can show how many
 *      agents are inheriting from each profile.
 * POST /api/v1/admin/orchestration/agent-profiles — create.
 *
 * Authentication: Admin role required.
 *
 * Profiles supply default persona / brand voice / guardrails text that
 * agents inherit when their own field is blank. See
 * lib/orchestration/agents/resolve-effective-prompt.ts for the merge
 * rules and `.context/admin/orchestration-agent-profiles.md` for the
 * operator surface.
 */

import { Prisma } from '@prisma/client';
import { isUniqueViolationOn, UNIQUE_CONSTRAINTS } from '@/lib/db/unique-violation';
import { withAdminAuth } from '@/lib/auth/guards';
import { administersPlatform } from '@/lib/auth/admin-viewer';
import { prisma } from '@/lib/db/client';
import { paginatedResponse, successResponse } from '@/lib/api/responses';
import { ConflictError } from '@/lib/api/errors';
import { validateQueryParams, validateRequestBody } from '@/lib/api/validation';
import { getRouteLogger } from '@/lib/api/context';
import { getClientIP } from '@/lib/security/ip';
import {
  agentProfileFormSchema,
  listAgentProfilesQuerySchema,
} from '@/lib/validations/orchestration';
import { logAdminAction } from '@/lib/orchestration/audit/admin-audit-logger';
import { agentProfileUsage } from '@/lib/orchestration/admin/global-config-usage';

export const GET = withAdminAuth(
  async (request, session) => {
    const log = await getRouteLogger(request);

    const { searchParams } = new URL(request.url);
    const { page, limit, q } = validateQueryParams(searchParams, listAgentProfilesQuerySchema);
    const skip = (page - 1) * limit;

    const where: Prisma.AiAgentProfileWhereInput = {};
    if (q) {
      where.OR = [
        { name: { contains: q, mode: 'insensitive' } },
        { slug: { contains: q, mode: 'insensitive' } },
      ];
    }

    const [rows, total] = await Promise.all([
      prisma.aiAgentProfile.findMany({
        where,
        orderBy: { updatedAt: 'desc' },
        skip,
        take: limit,
      }),
      prisma.aiAgentProfile.count({ where }),
    ]);

    // Attached agents in every org (t-731): a profile is global config, and a
    // plain `_count` at `multi` would count only the caller's org's agents.
    // Other orgs' usage is counted for a platform admin's delete check. A
    // customer org's admin sees only their own org's (§111 t-811): how many
    // of another tenant's agents use a shared row is not theirs to know.
    const platform = await administersPlatform(session.principal);
    const profileIds = rows.map((r) => r.id);
    const attached = await (platform
      ? agentProfileUsage(profileIds)
      : agentProfileUsage(profileIds, { acrossOrgs: false }));
    const data = rows.map((profile) => ({
      ...profile,
      agentCount: attached.get(profile.id) ?? 0,
    }));

    log.info('Agent profiles listed', { count: rows.length, total, page, limit });

    return paginatedResponse(data, { page, limit, total });
  },
  {
    tier: 'org',
    ownership: {
      decidedBy: 'nothing',
      because: 'Shared configuration every org reads; it holds nobody’s personal rows.',
    },
  }
);

export const POST = withAdminAuth(
  async (request, session) => {
    const clientIP = getClientIP(request);

    const log = await getRouteLogger(request);
    const body = await validateRequestBody(request, agentProfileFormSchema);

    try {
      const profile = await prisma.aiAgentProfile.create({
        data: {
          name: body.name,
          slug: body.slug,
          description: body.description ?? null,
          persona: body.persona ?? null,
          brandVoiceInstructions: body.brandVoiceInstructions ?? null,
          guardrails: body.guardrails ?? null,
          createdBy: session.user.id,
        },
      });

      log.info('Agent profile created', {
        profileId: profile.id,
        slug: profile.slug,
        adminId: session.user.id,
      });

      logAdminAction({
        userId: session.user.id,
        action: 'agent_profile.create',
        entityType: 'agent_profile',
        entityId: profile.id,
        entityName: profile.name,
        clientIp: clientIP,
      });

      return successResponse({ ...profile, agentCount: 0 }, undefined, { status: 201 });
    } catch (err) {
      if (isUniqueViolationOn(err, UNIQUE_CONSTRAINTS.agentProfileSlug)) {
        throw new ConflictError(`Agent profile with slug '${body.slug}' already exists`);
      }
      throw err;
    }
  },
  { writesSharedSettings: true }
);
