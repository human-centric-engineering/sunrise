/**
 * Admin Orchestration — Single agent (GET / PATCH / DELETE)
 *
 * GET    /api/v1/admin/orchestration/agents/:id
 * PATCH  /api/v1/admin/orchestration/agents/:id
 *   - When `systemInstructions` changes, the previous value is pushed
 *     onto `systemInstructionsHistory` with `{instructions, changedAt, changedBy}`.
 * DELETE /api/v1/admin/orchestration/agents/:id
 *   - Soft delete: sets `deletedAt = now()`, flips `isActive = false`, and
 *     renames the slug to a unique tombstone (`{slug}-deleted-{id}`) so
 *     the original slug is freed for reuse. `deletedAt` is the
 *     authoritative "deleted" signal that read paths filter on; the slug
 *     rename only exists to release the @unique constraint. Hard delete
 *     would either cascade conversation/message/cost-log history or
 *     fail; soft delete preserves the audit trail.
 *
 * Authentication: Admin role required.
 */

import { Prisma } from '@prisma/client';
import { withAdminAuth } from '@/lib/auth/guards';
import { prisma } from '@/lib/db/client';
import { successResponse } from '@/lib/api/responses';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '@/lib/api/errors';
import { validateRequestBody } from '@/lib/api/validation';
import { getRouteLogger } from '@/lib/api/context';
import { getClientIP } from '@/lib/security/ip';
import { logAdminAction, computeChanges } from '@/lib/orchestration/audit/admin-audit-logger';
import { emitHookEvent } from '@/lib/orchestration/hooks/registry';
import { dispatchWebhookEvent } from '@/lib/orchestration/webhooks/dispatcher';
import { logger } from '@/lib/logging';
import { buildChangeSummary } from '@/lib/orchestration/agent-version-diff';
import {
  patchAssignableScalarFields,
  versionedScalarFieldNames,
} from '@/lib/orchestration/agents/agent-field-registry';
import {
  INITIAL_VERSION_SUMMARY,
  asSnapshotJson,
  buildAgentSnapshot,
  nextAgentVersionNumber,
} from '@/lib/orchestration/agents/agent-versioning';
import { invalidateAgentAccess } from '@/lib/orchestration/knowledge/resolveAgentDocumentAccess';
import { notifyMcpAgentsChanged } from '@/lib/orchestration/mcp/resource-update-hooks';
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

/**
 * Cap on each string value inside an outbound `changes` payload. Agents'
 * `systemInstructions` can be 50k+ chars and `metadata` is unbounded; we
 * truncate so a single update doesn't blow through a typical receiver's
 * body-size limit. Matches the spirit of the 200-char error truncation in
 * `lib/orchestration/scheduling/scheduler.ts`.
 */
const WEBHOOK_FIELD_VALUE_MAX_LEN = 500;

function truncateForWebhookPayload(value: unknown): unknown {
  if (typeof value === 'string' && value.length > WEBHOOK_FIELD_VALUE_MAX_LEN) {
    return `${value.slice(0, WEBHOOK_FIELD_VALUE_MAX_LEN)}… [truncated]`;
  }
  return value;
}

function truncateChangesForPayload(
  changes: Record<string, { from: unknown; to: unknown }>
): Record<string, { from: unknown; to: unknown }> {
  const out: Record<string, { from: unknown; to: unknown }> = {};
  for (const [field, { from, to }] of Object.entries(changes)) {
    out[field] = {
      from: truncateForWebhookPayload(from),
      to: truncateForWebhookPayload(to),
    };
  }
  return out;
}

export const GET = withAdminAuth<{ id: string }>(async (request, _session, { params }) => {
  const log = await getRouteLogger(request);
  const { id: rawId } = await params;
  const id = parseAgentId(rawId);

  const agent = await prisma.aiAgent.findUnique({
    where: { id },
    include: {
      grantedTags: { select: { tagId: true } },
      grantedDocuments: { select: { documentId: true } },
    },
  });
  if (!agent || agent.deletedAt !== null) throw new NotFoundError(`Agent ${id} not found`);

  // Flatten the join-row arrays into id arrays for the form. The include is
  // always set in the query above, but defensive defaults keep tests that mock
  // findUnique with a partial shape from blowing up at runtime.
  const { grantedTags, grantedDocuments, ...rest } = agent;
  const response = {
    ...rest,
    grantedTagIds: (grantedTags ?? []).map((g) => g.tagId),
    grantedDocumentIds: (grantedDocuments ?? []).map((g) => g.documentId),
  };

  log.info('Agent fetched', { agentId: id });
  return successResponse(response);
});

export const PATCH = withAdminAuth<{ id: string }>(async (request, session, { params }) => {
  const clientIP = getClientIP(request);

  const log = await getRouteLogger(request);
  const { id: rawId } = await params;
  const id = parseAgentId(rawId);

  const current = await prisma.aiAgent.findUnique({
    where: { id },
    include: {
      grantedTags: { select: { tagId: true } },
      grantedDocuments: { select: { documentId: true } },
    },
  });
  if (!current || current.deletedAt !== null) throw new NotFoundError(`Agent ${id} not found`);

  const currentGrantedTagIds = (current.grantedTags ?? []).map((g) => g.tagId).sort();
  const currentGrantedDocumentIds = (current.grantedDocuments ?? [])
    .map((g) => g.documentId)
    .sort();

  const body = await validateRequestBody(request, updateAgentSchema);

  // System-agent read-only guards. These three fields are the
  // SYSTEM_AGENT_PROTECTED_FIELDS set (lib/orchestration/agents/agent-field-registry.ts) —
  // the version-restore route skips the same set. Keep both in step: a new
  // protected field is added to the constant AND guarded here (the messages are
  // field-specific, so the guards aren't a generic loop).

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
  // Plain scalar fields are assigned generically from the registry's
  // patch-assignable set, so a new agent field is picked up here automatically.
  // systemInstructions (history) and profileId (relation) are special-write
  // fields, handled explicitly below.
  const data: Prisma.AiAgentUpdateInput = {};
  const bodyRecord = body as Record<string, unknown>;
  const dataRecord = data as Record<string, unknown>;
  for (const field of patchAssignableScalarFields()) {
    if (bodyRecord[field] !== undefined) dataRecord[field] = bodyRecord[field];
  }
  if (body.profileId !== undefined) {
    // Use the relation form so null cleanly detaches the agent. Setting
    // the scalar `profileId` directly works for non-null values but
    // Prisma 7 prefers `disconnect` for clears.
    data.profile =
      body.profileId === null ? { disconnect: true } : { connect: { id: body.profileId } };
  }

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
    data.systemInstructionsHistory = history;
  }

  // Version-triggering fields — snapshot the current config before the update
  // if any of these are changing. Derived from the agent field registry (the
  // single source of truth), so the audit trail is complete by construction:
  // every versioned scalar is included and a new field can't silently lose
  // recovery surface. Grant relations are versioned too but detected separately
  // below (they're join-row writes, not entries in `data`). `profileId` is a
  // pointer, not content, so it's non-versioned in the registry — the
  // inheritance change surfaces through the resolved persona/voice/guardrails.
  const VERSIONED_FIELDS = versionedScalarFieldNames();

  // Only treat a versioned field as "changed" if the new value actually
  // differs from the stored value. Previously this filtered on
  // `data[f] !== undefined` alone — but the form sends back its full
  // state on every save, so every versioned field was always in `data`
  // and every save bumped the version with a misleading "X changed"
  // summary. Now we compare against `current`:
  //   - Primitive equality for scalars
  //   - Shallow elementwise for string[] (fallbackProviders,
  //     topicBoundaries)
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

  const currentRecord = current as unknown as Record<string, unknown>;
  const changedVersionedFields = VERSIONED_FIELDS.filter(
    (f) => dataRecord[f] !== undefined && isFieldChanged(dataRecord[f], currentRecord[f])
  );

  // Grant changes don't go through the `data` object (they're join-row writes),
  // but they're versioned in the snapshot so callers can roll them back. Detect
  // sorted-array equality to avoid spurious version bumps on no-op reorder.
  function arraysEqualUnordered(a: string[], b: string[]): boolean {
    if (a.length !== b.length) return false;
    const sortedA = [...a].sort();
    const sortedB = [...b].sort();
    for (let i = 0; i < sortedA.length; i++) {
      if (sortedA[i] !== sortedB[i]) return false;
    }
    return true;
  }
  const tagGrantsChanged =
    body.grantedTagIds !== undefined &&
    !arraysEqualUnordered(body.grantedTagIds, currentGrantedTagIds);
  const docGrantsChanged =
    body.grantedDocumentIds !== undefined &&
    !arraysEqualUnordered(body.grantedDocumentIds, currentGrantedDocumentIds);
  const grantsChanged = tagGrantsChanged || docGrantsChanged;

  // Captured inside the version-snapshot branch and surfaced in the
  // agent_updated payload so subscribers can fetch the snapshot via
  // /agents/:id/versions/:v. Stays null when the PATCH only touched
  // unversioned fields.
  let bumpedToVersion: number | null = null;

  const versionEvent = changedVersionedFields.length > 0 || grantsChanged;
  const summaryFields = [
    ...changedVersionedFields,
    ...(tagGrantsChanged ? (['grantedTagIds'] as const) : []),
    ...(docGrantsChanged ? (['grantedDocumentIds'] as const) : []),
  ];

  // The grant lists as they will be AFTER this PATCH — the body's lists when it
  // sent them, otherwise unchanged. Drives the post-update snapshot below.
  const newGrantedTagIds = body.grantedTagIds ?? currentGrantedTagIds;
  const newGrantedDocumentIds = body.grantedDocumentIds ?? currentGrantedDocumentIds;

  try {
    // Point-in-time versioning: a version row holds the config AS OF that
    // version. When versioned fields/grants change we snapshot the POST-update
    // state (not the pre-update state), so "restore to vN" reproduces the agent
    // as it was at vN and the newest row always equals live. Snapshot + update
    // run in one transaction so a failure can't orphan a version row.
    const agent = await prisma.$transaction(async (tx) => {
      // Decide the version numbering up front with a single query.
      // `nextAgentVersionNumber` returns 1 iff the agent has no version rows yet
      // — a legacy agent created before create-time versioning. In that case we
      // backfill its PRE-update state as v1 ("Initial configuration") so the
      // original isn't lost when the post-update row lands, and the post-update
      // row becomes v2. New agents already have v1 from create, so the next
      // number is ≥ 2 and no backfill happens.
      let postVersion = 0;
      if (versionEvent) {
        const firstNumber = await nextAgentVersionNumber(tx, id);
        if (firstNumber === 1) {
          await tx.aiAgentVersion.create({
            data: {
              agentId: id,
              version: 1,
              snapshot: asSnapshotJson(
                buildAgentSnapshot(current, {
                  grantedTagIds: currentGrantedTagIds,
                  grantedDocumentIds: currentGrantedDocumentIds,
                })
              ),
              changeSummary: INITIAL_VERSION_SUMMARY,
              createdBy: session.user.id,
            },
          });
          postVersion = 2;
        } else {
          postVersion = firstNumber;
        }
      }

      // Replace tag grants if the body provided a new list.
      if (body.grantedTagIds !== undefined) {
        await tx.aiAgentKnowledgeTag.deleteMany({ where: { agentId: id } });
        if (body.grantedTagIds.length > 0) {
          await tx.aiAgentKnowledgeTag.createMany({
            data: body.grantedTagIds.map((tagId) => ({ agentId: id, tagId })),
            skipDuplicates: true,
          });
        }
      }
      // Replace document grants if the body provided a new list.
      if (body.grantedDocumentIds !== undefined) {
        await tx.aiAgentKnowledgeDocument.deleteMany({ where: { agentId: id } });
        if (body.grantedDocumentIds.length > 0) {
          await tx.aiAgentKnowledgeDocument.createMany({
            data: body.grantedDocumentIds.map((documentId) => ({ agentId: id, documentId })),
            skipDuplicates: true,
          });
        }
      }

      const updated = await tx.aiAgent.update({ where: { id }, data });

      // Snapshot the post-update config (incl. the just-written grants) as the
      // new version, numbered above (post-backfill in the legacy case).
      if (versionEvent) {
        bumpedToVersion = postVersion;

        await tx.aiAgentVersion.create({
          data: {
            agentId: id,
            version: postVersion,
            snapshot: asSnapshotJson(
              buildAgentSnapshot(updated, {
                grantedTagIds: newGrantedTagIds,
                grantedDocumentIds: newGrantedDocumentIds,
              })
            ),
            changeSummary: buildChangeSummary(summaryFields),
            createdBy: session.user.id,
          },
        });

        log.info('Agent version snapshot created', {
          agentId: id,
          version: postVersion,
          changes: summaryFields,
        });
      }

      return updated;
    });

    // Evict the resolver cache so the next chat turn sees the new grants.
    if (grantsChanged || body.knowledgeAccessMode !== undefined) {
      invalidateAgentAccess(id);
    }

    // Shallow diff of before-vs-after. `Object.keys(data)` would over-report —
    // it includes every field in the PATCH body even when the submitted value
    // matches the existing one (e.g. a form save where only one field was
    // edited still ships the whole form payload).
    //
    // Ignored keys:
    //   - `updatedAt` — Prisma's `@updatedAt` bumps on every `update()` call,
    //     so it would mark every PATCH as a change even when the user-visible
    //     state is identical. The whole point of the diff is "did the user
    //     change anything?", not "did the row get touched?".
    //   - `createdAt` — never changes on update, but safe to filter.
    //   - `grantedTags` / `grantedDocuments` — `current` carries these from
    //     the initial `findUnique({ include: ... })`, but `agent` is the
    //     return from `tx.aiAgent.update` with no `include`, so they'd be
    //     reported as `array → undefined` on every PATCH. The grant changes
    //     are tracked separately via `grantsChanged` higher up.
    const changes = computeChanges(current, agent, {
      ignoreKeys: ['updatedAt', 'createdAt', 'grantedTags', 'grantedDocuments'],
    });
    const fieldsChanged = changes ? Object.keys(changes) : [];

    log.info('Agent updated', {
      agentId: id,
      adminId: session.user.id,
      fieldsChanged,
    });

    logAdminAction({
      userId: session.user.id,
      action: 'agent.update',
      entityType: 'agent',
      entityId: id,
      entityName: agent.name,
      changes,
      clientIp: clientIP,
    });

    // Only notify subscribers when something actually changed. A no-op PATCH
    // (form save with no edits) shouldn't generate webhook traffic.
    if (changes) {
      const agentUpdatedPayload = {
        agentId: id,
        // Post-update slug + name so receivers have human-readable
        // identifiers without an extra API call. When the rename is the
        // change itself, these reflect the new values and `changes.name`
        // / `changes.slug` carry the from/to transition.
        agentSlug: agent.slug,
        agentName: agent.name,
        // Who initiated the change — `actorUserId` matches the convention
        // already used by `execution.force_failed`. `actorUserName` is
        // the display-name counterpart, same reasoning as `agentName`:
        // human-readable text for Slack / email receivers without an
        // extra API call. Email is intentionally omitted — names are
        // already shown in the admin UI; emails are stronger PII and
        // should stay server-side.
        actorUserId: session.user.id,
        actorUserName: session.user.name,
        // Number of the snapshot this PATCH created (so receivers can
        // GET /agents/:id/versions/:v). Null when only unversioned
        // fields were touched and no snapshot was created — not every
        // PATCH bumps the version.
        agentVersion: bumpedToVersion,
        // `{ field: { from, to } }` matches GitHub's `changes` and Stripe's
        // `previous_attributes` conventions. Large string values are
        // truncated to keep payloads under receiver size limits — agents'
        // `systemInstructions` can be 50k+ chars and would otherwise blow
        // through a typical 1MB webhook receiver cap.
        changes: truncateChangesForPayload(changes),
      };

      // Two distinct outbound subsystems — see .context/orchestration/hooks.md.
      // Event hooks (AiEventHook) use dotted event names; webhook subscriptions
      // (AiWebhookSubscription) use underscore names. Dual-dispatch so admins
      // configured via either surface receive the notification.
      emitHookEvent('agent.updated', agentUpdatedPayload);
      void dispatchWebhookEvent('agent_updated', agentUpdatedPayload);
    }

    notifyMcpAgentsChanged();

    return successResponse(agent);
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      // Disambiguate which unique constraint collided. A slug clash is a real
      // user error; a collision on @@unique([agentId, version]) means two
      // concurrent PATCHes raced for the same version number — surface that as a
      // retryable conflict, not a misleading "slug already in use".
      const target = err.meta?.target;
      const onSlug = Array.isArray(target)
        ? target.includes('slug')
        : typeof target === 'string' && target.includes('slug');
      if (onSlug) {
        throw new ValidationError(`Agent with slug '${body.slug}' already exists`, {
          slug: ['Slug is already in use'],
        });
      }
      throw new ConflictError('Agent update conflicted with a concurrent change. Please retry.');
    }
    throw err;
  }
});

export const DELETE = withAdminAuth<{ id: string }>(async (request, session, { params }) => {
  const clientIP = getClientIP(request);

  const log = await getRouteLogger(request);
  const { id: rawId } = await params;
  const id = parseAgentId(rawId);

  const current = await prisma.aiAgent.findUnique({ where: { id } });
  if (!current || current.deletedAt !== null) throw new NotFoundError(`Agent ${id} not found`);

  if (current.isSystem) {
    throw new ForbiddenError('System agents cannot be deleted');
  }

  // Release the slug so the operator can recreate an agent with the same
  // name. The slug column is @unique, so a soft-delete that left the slug
  // in place would block reuse forever. Rename to a collision-free
  // tombstone; truncate to leave room for the suffix (slug max is 100
  // chars at the validation layer). The already-tombstoned guard is
  // defensive — the `deletedAt` check above already short-circuits any
  // second DELETE on the same row.
  const tombstoneSuffix = `-deleted-${id}`;
  const alreadyTombstoned = current.slug.endsWith(tombstoneSuffix);
  const tombstoneSlug = alreadyTombstoned
    ? current.slug
    : `${current.slug.slice(0, Math.max(0, 100 - tombstoneSuffix.length))}${tombstoneSuffix}`;

  const agent = await prisma.aiAgent.update({
    where: { id },
    data: { isActive: false, slug: tombstoneSlug, deletedAt: new Date() },
  });

  log.info('Agent soft-deleted', {
    agentId: id,
    previousSlug: current.slug,
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

  notifyMcpAgentsChanged();

  return successResponse({ id, isActive: false });
});
