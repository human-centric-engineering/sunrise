/**
 * Orchestration Config Importer
 *
 * Validates and imports a backup payload, upserting by slug.
 * Runs in a transaction so partial failures roll back cleanly.
 * Excludes secrets with a warning.
 *
 * **Scoped to one org** (§109 t-738). Everything — the provider-policy
 * warnings, the transaction, its version records — runs inside
 * `runAsOrg(scope.orgId)`, so the org's own part lands in that org whatever
 * org the caller's session is in. The shared part (capabilities, knowledge
 * tags, the `global` settings) is written only when `scope.includeShared`;
 * otherwise a bundle's shared part is skipped with a warning naming it.
 * `resolveBackupScope()` decides both and refuses a customer org that asks,
 * so this importer is what enforces the install-org rule for the import
 * route (listed in `UNDECLARED_ROUTE_EXCEPTIONS` for that reason).
 */

import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { isUniqueViolationOn, UNIQUE_CONSTRAINTS } from '@/lib/db/unique-violation';
import { isSafeProviderUrl } from '@/lib/security/safe-url';
import { prisma } from '@/lib/db/client';
import { logger } from '@/lib/logging';
import { isMultiTenant, runAsOrg } from '@/lib/tenancy/context';
import {
  backupSchema,
  IMPORTED_FROM_SLUG_KEY,
  type BackupPayload,
} from '@/lib/orchestration/backup/schema';

export { IMPORTED_FROM_SLUG_KEY };
import type { BackupScope } from '@/lib/orchestration/backup/scope';
import {
  findFreeWorkflowSlug,
  workflowSlugsHeldAnywhere,
} from '@/lib/orchestration/workflows/slug-availability';
// Direct submodule import, not the barrel: `@/lib/orchestration/capabilities`
// re-exports the dispatcher and the built-in registry, none of which a config
// restore needs pulled into its module graph.
import { changedSeedOwnedFields } from '@/lib/orchestration/capabilities/seed-owned';
import {
  isReservedAgentSlug,
  reservedAgentSlugMessage,
} from '@/lib/orchestration/agents/platform-agent-guard';
import {
  isBuiltinTemplateSlug,
  isSystemWorkflowSlug,
} from '@/lib/orchestration/workflows/template-catalogue';
import {
  createInitialVersion,
  withoutErasedRecipients,
} from '@/lib/orchestration/workflows/version-service';
import { invalidateOrchestrationSettingsCache } from '@/lib/orchestration/settings';
import { invalidateSettingsCache } from '@/lib/orchestration/llm/settings-resolver';
import { workflowDefinitionSchema } from '@/lib/validations/orchestration';
import type { WorkflowDefinition } from '@/types/orchestration';
import { isRecord } from '@/lib/utils';
import { normaliseAddress } from '@/lib/orchestration/webhooks/destination';
import { definitionRecipients } from '@/lib/privacy/config-recipients';
import {
  bundleContacts,
  escalationAddresses,
  trustedExportedAt,
} from '@/lib/orchestration/backup/export-seal';
import {
  lockSubjects,
  matchErasedSubjects,
  WRITER_TRANSACTION_OPTIONS,
  type ErasedSubjects,
} from '@/lib/privacy/erased-subjects';
import { importedAgentProviderWarnings } from '@/lib/orchestration/agents/provider-approval';
import { findUnapprovedModelOverridesIn } from '@/lib/orchestration/workflows/semantic-validator';
import {
  AGENT_BATCH_TRANSACTION_TIMEOUT_MS,
  INITIAL_VERSION_SUMMARY,
  ensureBaselineVersion,
  recordAgentVersion,
} from '@/lib/orchestration/agents/agent-versioning';

const BACKUP_VERSION_LABEL = 'Overwritten by backup import';

/**
 * How long the import transaction may run: the agent batch's own budget, plus
 * the time it may wait at the start on erasure's lock for a person the bundle
 * names (t-805, review round 2), since an erasure can hold it for its whole
 * transaction. The import holds those locks for as long as this, so erasure
 * waits for them for longer (`SUBJECT_LOCK_WAIT_MS`, t-840).
 */
export const IMPORT_TRANSACTION_TIMEOUT_MS =
  AGENT_BATCH_TRANSACTION_TIMEOUT_MS + WRITER_TRANSACTION_OPTIONS.timeout;

export interface ImportResult {
  agents: { created: number; updated: number };
  capabilities: { created: number; updated: number };
  workflows: { created: number; updated: number };
  webhooks: { created: number; skipped: number };
  knowledgeTags: { created: number; updated: number };
  settingsUpdated: boolean;
  /** The bundle carried a shared part and it was not written (§109 t-738). */
  sharedSkipped: boolean;
  warnings: string[];
}

const jsonObjectSchema = z.record(z.string(), z.unknown());

/** The workflow metadata with the renamed-import marker set. */
function withImportedFromSlug(metadata: unknown, slug: string): Prisma.InputJsonValue {
  // Bundle metadata is uploaded data the schema accepts as anything; only an
  // object is merged, anything else is replaced.
  const parsed = jsonObjectSchema.safeParse(metadata);
  return {
    ...(parsed.success ? parsed.data : {}),
    [IMPORTED_FROM_SLUG_KEY]: slug,
  };
}

/**
 * Whether a failed import lost a race for a workflow slug: another org took
 * the free slug this import planned between the plan and the create. The
 * transaction rolled back, so the import can be run again (the route answers
 * 409, as for an agent version conflict).
 */
export function isWorkflowSlugConflict(err: unknown): boolean {
  return isUniqueViolationOn(err, UNIQUE_CONSTRAINTS.workflowSlug);
}

/**
 * The slug each bundle workflow will be created under when another org holds
 * its own: asked once, before the transaction, so the probes — each its own
 * system-scope read — never wait on a second pooled connection while the
 * import holds the first (with a pool of one they would never get it).
 *
 * Two queries, not one per slug: which of the bundle's slugs any org holds
 * (the system-scope probe), and which this org holds (an ordinary read, which
 * the policy limits to it). A slug this org holds is updated in place, so only
 * the rest — held by another org — are planned. System and built-in template
 * slugs are skipped by the import loop, so they are not asked about. Planned
 * slugs avoid every slug the bundle carries and every slug already planned,
 * so two workflows never land on one slug and a later workflow in the bundle
 * is not mistaken for an earlier one's renamed copy. At `single` every row is
 * the install org's and the transaction's own read sees it, so there is
 * nothing to plan.
 *
 * Runs inside the target org (the caller's `runAsOrg`), outside the transaction.
 */
async function planWorkflowSlugs(
  workflows: ReadonlyArray<{ slug: string; isTemplate: boolean }>
): Promise<Map<string, string>> {
  const planned = new Map<string, string>();
  if (!isMultiTenant()) return planned;
  const bundleSlugs = new Set(workflows.map((wf) => wf.slug));
  const asked = [
    ...new Set(
      workflows
        .filter(
          (wf) =>
            !isSystemWorkflowSlug(wf.slug) && !(wf.isTemplate && isBuiltinTemplateSlug(wf.slug))
        )
        .map((wf) => wf.slug)
    ),
  ];
  const heldAnywhere = await workflowSlugsHeldAnywhere(asked);
  if (heldAnywhere.size === 0) return planned;
  const heldHere = new Set(
    (
      await prisma.aiWorkflow.findMany({
        where: { slug: { in: [...heldAnywhere] } },
        select: { slug: true },
      })
    ).map((row) => row.slug)
  );
  const reserved = new Set<string>();
  for (const slug of asked) {
    if (!heldAnywhere.has(slug) || heldHere.has(slug)) continue;
    const free = await findFreeWorkflowSlug(
      slug,
      (candidate) => bundleSlugs.has(candidate) || reserved.has(candidate)
    );
    reserved.add(free);
    planned.set(slug, free);
  }
  return planned;
}

/** The warning for a system workflow the import refused, by slug or by row flag. */
function systemWorkflowSkipped(slug: string): string {
  return `System workflow '${slug}' skipped — system workflows cannot be overwritten by backup import`;
}

/**
 * What a bundle's shared part holds, as the words of a skip warning — or null
 * when it holds nothing, so an empty shared part (a customer org's own export)
 * is not reported as skipped.
 */
function describeSharedPart(parsed: BackupPayload): string | null {
  const { data } = parsed;
  const parts: string[] = [];
  if (data.capabilities.length > 0) parts.push(`${data.capabilities.length} capabilities`);
  if (data.knowledgeTags.length > 0) parts.push(`${data.knowledgeTags.length} knowledge tags`);
  // A v1 bundle carries no tags, but its agents' categories become tags on
  // import — a shared write too, so its skip is reported with the rest.
  if (parsed.schemaVersion === 1) {
    const categories = new Set(
      data.agents.flatMap((agent) => (agent.knowledgeCategories ?? []).map((c) => c.trim()))
    );
    categories.delete('');
    if (categories.size > 0) parts.push(`${categories.size} knowledge tags from v1 categories`);
  }
  if (data.settings !== null) parts.push('the orchestration settings');
  return parts.length > 0 ? parts.join(', ') : null;
}

/** Validate a backup and import it into `scope.orgId` — see the module header. */
export async function importOrchestrationConfig(
  raw: unknown,
  userId: string,
  scope: BackupScope
): Promise<ImportResult> {
  const parsed = backupSchema.parse(raw);
  return runAsOrg(scope.orgId, () =>
    importParsed(parsed, userId, scope.includeShared, scope.orgId)
  );
}

async function importParsed(
  parsed: BackupPayload,
  userId: string,
  includeShared: boolean,
  orgId: string
): Promise<ImportResult> {
  const result: ImportResult = {
    agents: { created: 0, updated: 0 },
    capabilities: { created: 0, updated: 0 },
    workflows: { created: 0, updated: 0 },
    webhooks: { created: 0, skipped: 0 },
    knowledgeTags: { created: 0, updated: 0 },
    settingsUpdated: false,
    sharedSkipped: false,
    warnings: [],
  };

  const sharedContent = describeSharedPart(parsed);
  if (!includeShared && sharedContent !== null) {
    result.sharedSkipped = true;
    result.warnings.push(
      `Shared settings not imported: ${sharedContent}. ` +
        (isMultiTenant()
          ? 'They apply to every organisation, so they are imported only from the install ' +
            'organisation, and only when asked for (shared=true).'
          : 'This import was asked to leave them out (shared=false).')
    );
  }

  // At multi, agents and workflow steps naming a provider the org is not
  // approved for are imported and flagged, not refused (§120 t-743). Asked
  // once, before the transaction, so the policy read neither holds its
  // connection nor fails the import: these are warnings.
  const [agentProviders, workflowProviders] = await Promise.all([
    importedAgentProviderWarnings(parsed.data.agents),
    importedWorkflowProviderWarnings(parsed.data.workflows),
  ]);
  for (const unchecked of [agentProviders.unchecked, workflowProviders.unchecked]) {
    if (unchecked) result.warnings.push(unchecked);
  }
  const plannedWorkflowSlugs = await planWorkflowSlugs(parsed.data.workflows);

  await prisma.$transaction(
    async (tx) => {
      // People the bundle names who have been erased since it was taken (t-805).
      // A backup from before an erasure would otherwise restore their address
      // or approver id into the escalation list, a subscription or a workflow.
      // Found once, under the locks erasure takes, and stripped from every
      // write below with a warning — an import is not refused for it. For
      // addresses, only erasures since a date this install sealed count (§122
      // t-902, t-900); see erasedSinceBundle.
      const since = trustedExportedAt(parsed, orgId, new Date());
      if (parsed.exportSeal !== undefined && !since) result.warnings.push(SEAL_REJECTED_WARNING);
      const erased = await erasedSinceBundle(tx, bundleRecipients(parsed.data, includeShared), {
        since,
      });
      // Addresses erased before a sealed export that this import writes back,
      // noted where each is written, so a skipped row is not counted; and
      // counted once each, however many places it appears.
      const keptContacts = new Set<string>();
      const noteKept = (addresses: Iterable<string>) => {
        for (const a of addresses) {
          const address = normaliseAddress(a);
          if (erased.everContacts.includes(address)) keptContacts.add(address);
        }
      };

      // Knowledge tags first — agents reference them by slug, so create/refresh
      // them before the agent import so grant resolution succeeds.
      const tagIdBySlug = new Map<string, string>();
      for (const tag of includeShared ? parsed.data.knowledgeTags : []) {
        const upserted = await tx.knowledgeTag.upsert({
          where: { slug: tag.slug },
          create: { slug: tag.slug, name: tag.name, description: tag.description ?? null },
          update: { name: tag.name, description: tag.description ?? null },
        });
        tagIdBySlug.set(upserted.slug, upserted.id);
        if (upserted.createdAt.getTime() === upserted.updatedAt.getTime()) {
          result.knowledgeTags.created++;
        } else {
          result.knowledgeTags.updated++;
        }
      }

      // v1 → v2 compatibility: when the backup is v1 (no `knowledgeTags`) but an
      // agent carries non-empty `knowledgeCategories`, infer tag slugs from those
      // strings so the new resolver model has something to work with.
      function slugifyFor(input: string): string {
        return input
          .trim()
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '-')
          .replace(/^-+|-+$/g, '')
          .slice(0, 64);
      }
      // Creating a tag is a shared write, so only with the shared part.
      if (parsed.schemaVersion === 1 && includeShared) {
        const inferredCategories = new Set<string>();
        for (const a of parsed.data.agents) {
          for (const c of a.knowledgeCategories ?? []) {
            if (c.trim()) inferredCategories.add(c.trim());
          }
        }
        for (const name of inferredCategories) {
          const slug = slugifyFor(name);
          if (!slug || tagIdBySlug.has(slug)) continue;
          const upserted = await tx.knowledgeTag.upsert({
            where: { slug },
            create: { slug, name },
            update: { name },
          });
          tagIdBySlug.set(slug, upserted.id);
          result.knowledgeTags.created++;
        }
      }

      // A grant may name a tag this import did not write — the shared part was
      // left out, or the bundle simply did not carry the tag. Tags are shared
      // rows every org reads, so an existing one is granted rather than
      // reported missing. One lookup for every slug the grants name.
      const grantSlugs = new Set<string>();
      for (const agent of parsed.data.agents) {
        for (const slug of agent.grantedTagSlugs) grantSlugs.add(slug);
        if (parsed.schemaVersion === 1) {
          for (const c of agent.knowledgeCategories ?? []) {
            const slug = slugifyFor(c);
            if (slug) grantSlugs.add(slug);
          }
        }
      }
      const unresolvedSlugs = [...grantSlugs].filter((slug) => !tagIdBySlug.has(slug));
      if (unresolvedSlugs.length > 0) {
        const existingTags = await tx.knowledgeTag.findMany({
          where: { slug: { in: unresolvedSlugs } },
          select: { id: true, slug: true },
        });
        for (const tag of existingTags) tagIdBySlug.set(tag.slug, tag.id);
      }

      // Import agents by slug upsert
      for (const agent of parsed.data.agents) {
        const existing = await tx.aiAgent.findFirst({ where: { slug: agent.slug } });
        if (existing?.isSystem) {
          result.warnings.push(
            `System agent '${agent.slug}' skipped — system agents cannot be overwritten by backup import`
          );
          continue;
        }
        // A platform agent's slug is never an org's own agent's (§116 t-725):
        // the reconcile creates this org's instance, not the backup.
        if (isReservedAgentSlug(agent.slug)) {
          result.warnings.push(
            `Agent '${agent.slug}' skipped — ${reservedAgentSlugMessage(agent.slug)}`
          );
          continue;
        }
        // Imported and flagged, not refused (§120 t-743).
        const unapproved = agentProviders.bySlug.get(agent.slug);
        if (unapproved) result.warnings.push(unapproved);
        if (existing) {
          await ensureBaselineVersion(tx, existing.id, userId);
          await tx.aiAgent.update({
            where: { id: existing.id },
            data: {
              name: agent.name,
              description: agent.description,
              systemInstructions: agent.systemInstructions,
              model: agent.model,
              provider: agent.provider,
              fallbackProviders: agent.fallbackProviders,
              temperature: agent.temperature,
              maxTokens: agent.maxTokens,
              reasoningEffort: agent.reasoningEffort ?? null,
              stopSequences: agent.stopSequences ?? [],
              topP: agent.topP ?? null,
              verbosity: agent.verbosity ?? null,
              parallelToolCalls: agent.parallelToolCalls ?? null,
              serviceTier: agent.serviceTier ?? null,
              providerTools: agent.providerTools ?? Prisma.JsonNull,
              monthlyBudgetUsd: agent.monthlyBudgetUsd,
              // Older backup bundles omit this field — treat absent as
              // null (no per-turn cap). The schema validator allows the
              // omission via `optional()`.
              maxCostPerTurnUsd: agent.maxCostPerTurnUsd ?? null,
              visibility: agent.visibility,
              isActive: agent.isActive,
              metadata: (agent.metadata as Prisma.InputJsonValue) ?? Prisma.JsonNull,
              knowledgeAccessMode: agent.knowledgeAccessMode,
              knowledgeRetrievalMode: agent.knowledgeRetrievalMode,
              knowledgeTriggerKeywords: agent.knowledgeTriggerKeywords,
              topicBoundaries: agent.topicBoundaries,
              brandVoiceInstructions: agent.brandVoiceInstructions,
              rateLimitRpm: agent.rateLimitRpm,
              inputGuardMode: agent.inputGuardMode,
              outputGuardMode: agent.outputGuardMode,
              citationGuardMode: agent.citationGuardMode,
              maxHistoryTokens: agent.maxHistoryTokens,
              maxHistoryMessages: agent.maxHistoryMessages,
              retentionDays: agent.retentionDays,
              providerConfig: (agent.providerConfig as Prisma.InputJsonValue) ?? Prisma.JsonNull,
              widgetConfig: (agent.widgetConfig as Prisma.InputJsonValue) ?? Prisma.JsonNull,
              // Discriminator + inheritance + attachment + runtime-prompt fields.
              // The schema defaults them for older bundles, so an overwrite always
              // applies a coherent value rather than silently leaving the prior one.
              kind: agent.kind,
              persona: agent.persona,
              guardrails: agent.guardrails,
              personaMode: agent.personaMode,
              voiceMode: agent.voiceMode,
              guardrailsMode: agent.guardrailsMode,
              enableVoiceInput: agent.enableVoiceInput,
              enableImageInput: agent.enableImageInput,
              enableDocumentInput: agent.enableDocumentInput,
              runtimePromptManaged: agent.runtimePromptManaged,
              runtimePromptNote: agent.runtimePromptNote,
            },
          });
          result.agents.updated++;
        } else {
          // Strip every backup-only field that is NOT an `AiAgent` column before
          // spreading into `create` — Prisma rejects unknown args. `knowledgeCategories`
          // is kept on the wire for old-bundle back-compat (and the v1->v2 tag
          // backfill above still reads it off `agent`), but the column was dropped
          // in Phase 6, so it must not reach `create` (#353). The grant arrays are
          // applied separately below.
          const {
            grantedTagSlugs: _ignoreTagSlugs,
            grantedDocumentSlugs: _ignoreDocSlugs,
            grantedDocumentHashes: _ignoreDocHashes,
            knowledgeCategories: _ignoreKnowledgeCategories,
            ...createAgent
          } = agent;
          await tx.aiAgent.create({
            data: {
              ...createAgent,
              metadata: (createAgent.metadata as Prisma.InputJsonValue) ?? Prisma.JsonNull,
              providerConfig:
                (createAgent.providerConfig as Prisma.InputJsonValue) ?? Prisma.JsonNull,
              widgetConfig: (createAgent.widgetConfig as Prisma.InputJsonValue) ?? Prisma.JsonNull,
              providerTools: createAgent.providerTools ?? Prisma.JsonNull,
              createdBy: userId,
            },
          });
          result.agents.created++;
        }

        // Apply grants after upsert. For v1 backups (where the slug arrays are
        // empty and we synthesised tag rows from knowledgeCategories above),
        // fall back to looking up by category-derived slug so the agent ends up
        // with the same effective scope as before the migration.
        const target = await tx.aiAgent.findFirst({
          where: { slug: agent.slug },
          select: { id: true },
        });
        if (!target) continue; // upsert just succeeded — should never happen

        const tagSlugs =
          agent.grantedTagSlugs.length > 0
            ? agent.grantedTagSlugs
            : parsed.schemaVersion === 1
              ? (agent.knowledgeCategories ?? [])
                  .map((c) => slugifyFor(c))
                  .filter((s) => s.length > 0)
              : [];

        const resolvedTagIds: string[] = [];
        for (const slug of tagSlugs) {
          const tagId = tagIdBySlug.get(slug);
          if (tagId) {
            resolvedTagIds.push(tagId);
          } else {
            result.warnings.push(
              `Agent '${agent.slug}' references missing knowledge-tag slug '${slug}'; grant skipped`
            );
          }
        }

        await tx.aiAgentKnowledgeTag.deleteMany({ where: { agentId: target.id } });
        if (resolvedTagIds.length > 0) {
          await tx.aiAgentKnowledgeTag.createMany({
            data: resolvedTagIds.map((tagId) => ({ agentId: target.id, tagId })),
            skipDuplicates: true,
          });
        }

        // Document grants resolve via slug (v3 — the stable cross-env key, #338).
        // v2 backups carried `grantedDocumentHashes` instead; fall back to fileHash
        // lookup only when no slugs are present, so older bundles still restore.
        const docSlugs = agent.grantedDocumentSlugs ?? [];
        let resolvedDocIds: string[] = [];
        if (docSlugs.length > 0) {
          const docs = await tx.aiKnowledgeDocument.findMany({
            where: { slug: { in: docSlugs } },
            select: { id: true, slug: true },
          });
          const presentSlugs = new Set(docs.map((d) => d.slug));
          for (const slug of docSlugs) {
            if (!presentSlugs.has(slug)) {
              result.warnings.push(
                `Agent '${agent.slug}' references missing knowledge document slug '${slug}'; grant skipped`
              );
            }
          }
          resolvedDocIds = docs.map((d) => d.id);
        } else {
          const docHashes = agent.grantedDocumentHashes ?? [];
          if (docHashes.length > 0) {
            const docs = await tx.aiKnowledgeDocument.findMany({
              where: { fileHash: { in: docHashes } },
              select: { id: true, fileHash: true },
            });
            const presentHashes = new Set(docs.map((d) => d.fileHash));
            for (const h of docHashes) {
              if (!presentHashes.has(h)) {
                result.warnings.push(
                  `Agent '${agent.slug}' references missing knowledge document (fileHash ${h.slice(0, 12)}…); grant skipped`
                );
              }
            }
            // A single fileHash can match multiple documents (content dedup is
            // advisory, not unique) — restrict to one grant per agent+document.
            resolvedDocIds = [...new Set(docs.map((d) => d.id))];
          }
        }
        await tx.aiAgentKnowledgeDocument.deleteMany({ where: { agentId: target.id } });
        if (resolvedDocIds.length > 0) {
          await tx.aiAgentKnowledgeDocument.createMany({
            data: resolvedDocIds.map((documentId) => ({ agentId: target.id, documentId })),
            skipDuplicates: true,
          });
        }

        // Save the restored config (row and grants) as the agent's next version
        // (v1 for a new agent), so the newest version equals what it now runs.
        // Nothing is written when the backup left the config unchanged.
        await recordAgentVersion(tx, target.id, {
          label: existing ? BACKUP_VERSION_LABEL : INITIAL_VERSION_SUMMARY,
          createdBy: userId,
        });
      }

      // Import capabilities by slug upsert — the shared part.
      for (const cap of includeShared ? parsed.data.capabilities : []) {
        const existing = await tx.aiCapability.findUnique({ where: { slug: cap.slug } });
        if (existing) {
          const data: Prisma.AiCapabilityUpdateInput = {
            name: cap.name,
            description: cap.description,
            category: cap.category,
            executionConfig: (cap.executionConfig as Prisma.InputJsonValue) ?? Prisma.JsonNull,
            requiresApproval: cap.requiresApproval,
            rateLimit: cap.rateLimit,
          };

          // `PATCH /capabilities/{id}` refuses `isActive: false` on a system row —
          // deactivating a built-in is treated as equivalent to deleting it — and
          // nothing puts it back: every capability seed sets `isActive` only in
          // its `create` branch, so a re-seed will not undo it. An import must not
          // do what the API refuses, or a hand-edited bundle carrying
          // `{"slug":"upload_to_storage","isActive":false}` silently disables a
          // built-in for good, through the same call that declines to import that
          // bundle's `executionHandler`.
          //
          // Re-ACTIVATING stays allowed, exactly as PATCH allows it.
          if (existing.isSystem && cap.isActive === false) {
            result.warnings.push(
              `System capability '${cap.slug}' — isActive:false not imported; deactivating a built-in is equivalent to deleting it and no re-seed restores it`
            );
          } else {
            data.isActive = cap.isActive;
          }

          // On a system row the seeds own the execution fields, so importing them
          // would write a change the next re-seed reverts with no audit entry.
          // Skip just those fields rather than skipping the row (which is what
          // the agent path above does): an import is a whole-config restore, and
          // refusing it because the bundle carries a built-in's shipped
          // definition would make routine restores unusable. Everything the
          // operator owns — name, description, category, rate limit, approval —
          // still restores.
          //
          // Sunrise's own exporter filters `isSystem: false`, so a bundle this
          // produced never reaches here with a system capability. A hand-edited
          // or foreign bundle can, and that is the case worth being correct for.
          const seedOwned = existing.isSystem ? changedSeedOwnedFields(existing, cap) : [];
          if (seedOwned.length > 0) {
            // Only warn when a value actually differs — a routine restore of an
            // unmodified bundle carries the shipped definition verbatim, and
            // warning on that would be noise on every import.
            result.warnings.push(
              `System capability '${cap.slug}' — ${seedOwned.join(', ')} not imported; these are seeded from code and a re-seed would revert them`
            );
          }
          if (!existing.isSystem) {
            data.functionDefinition = cap.functionDefinition as Prisma.InputJsonValue;
            data.executionType = cap.executionType;
            data.executionHandler = cap.executionHandler;
          }

          await tx.aiCapability.update({ where: { slug: cap.slug }, data });
          result.capabilities.updated++;
        } else {
          await tx.aiCapability.create({
            data: {
              ...cap,
              functionDefinition: cap.functionDefinition as Prisma.InputJsonValue,
              executionConfig: (cap.executionConfig as Prisma.InputJsonValue) ?? Prisma.JsonNull,
            },
          });
          result.capabilities.created++;
        }
      }

      // Import workflows by slug upsert. The wire format carries one
      // `workflowDefinition` per workflow — on import it becomes either a
      // new published version (update path: published draft promoted to vN+1)
      // or the initial v1 (create path).
      for (const wf of parsed.data.workflows) {
        // A system workflow is the seed's, as a platform agent is, so it is
        // recognised by slug before anything else: a bundle exported before
        // t-729 carries the provider-model audit, and on a target where that row
        // is absent (or another org's, at `multi`) the row check further down
        // cannot see it.
        if (isSystemWorkflowSlug(wf.slug)) {
          result.warnings.push(systemWorkflowSkipped(wf.slug));
          continue;
        }
        // A built-in template is served from code (§116 t-727). A backup taken
        // before the upgrade carries the seed-era template row; importing it
        // would bring that row back as a template. An ordinary workflow holding
        // the slug (one an install switched back on or converted) imports as
        // any other.
        if (wf.isTemplate && isBuiltinTemplateSlug(wf.slug)) {
          result.warnings.push(
            `Workflow '${wf.slug}' skipped — built-in templates are served from code, not restored from a backup`
          );
          continue;
        }
        // Read in this org: at `multi` the policy hides every other org's rows.
        // When another org holds the slug, the workflow may still be this
        // org's own earlier import of it, created under another slug and
        // marked. Asked only then, so a marker that travelled in some other
        // bundle can never redirect a workflow whose slug is simply free.
        const existing =
          (await tx.aiWorkflow.findUnique({ where: { slug: wf.slug } })) ??
          (plannedWorkflowSlugs.has(wf.slug)
            ? await tx.aiWorkflow.findFirst({
                where: { metadata: { path: [IMPORTED_FROM_SLUG_KEY], equals: wf.slug } },
                // The oldest, so a repeat import always picks the same row.
                orderBy: { createdAt: 'asc' },
              })
            : null);
        // The row flag catches a system workflow the slug list does not know (a
        // fork's own seed). Versioning over one would republish whatever
        // definition the bundle carried, and the update below could deactivate
        // it or change its template status — both of which PATCH refuses.
        if (existing?.isSystem) {
          result.warnings.push(systemWorkflowSkipped(wf.slug));
          continue;
        }
        // Parsed only after both system checks, so a skipped row never reports a
        // definition problem as its reason.
        const defParsed = workflowDefinitionSchema.safeParse(wf.workflowDefinition);
        if (!defParsed.success) {
          result.warnings.push(`Workflow '${wf.slug}' skipped — definition failed validation`);
          continue;
        }
        const unapprovedSteps = workflowProviders.bySlug.get(wf.slug);
        if (unapprovedSteps) result.warnings.push(unapprovedSteps);
        const definition = withoutErasedRecipients(defParsed.data, erased.inWorkflows);
        if (definition !== defParsed.data) {
          result.warnings.push(
            `Workflow '${wf.slug}': recipients or approvers belonging to people whose data was erased were removed`
          );
        }
        // Every path below writes the definition.
        noteKept(definitionRecipients(definition as unknown as Prisma.JsonValue).addresses);
        if (existing) {
          // Promote the imported snapshot to a new version on the existing workflow.
          const lastVersion = await tx.aiWorkflowVersion.findFirst({
            where: { workflowId: existing.id },
            orderBy: { version: 'desc' },
            select: { version: true },
          });
          const newVersion = await tx.aiWorkflowVersion.create({
            data: {
              workflowId: existing.id,
              version: (lastVersion?.version ?? 0) + 1,
              snapshot: definition as unknown as Prisma.InputJsonValue,
              changeSummary: 'Imported from backup',
              createdBy: userId,
            },
          });
          await tx.aiWorkflow.update({
            where: { id: existing.id },
            data: {
              name: wf.name,
              description: wf.description,
              patternsUsed: wf.patternsUsed,
              isActive: wf.isActive,
              isTemplate: wf.isTemplate,
              // A row found by the marker keeps it, or the next import misses it.
              metadata:
                existing.slug !== wf.slug
                  ? withImportedFromSlug(wf.metadata, wf.slug)
                  : ((wf.metadata as Prisma.InputJsonValue) ?? Prisma.JsonNull),
              publishedVersionId: newVersion.id,
            },
          });
          result.workflows.updated++;
        } else {
          // `AiWorkflow.slug` is unique across every org, so a slug another org
          // holds would fail the create and roll the whole import back (t-728).
          // Take the first free one instead and say so. The probe answers
          // yes/no only, and also covers another org's system workflow, which
          // the `isSystem` check above cannot see.
          //
          // Planned before the transaction (see planWorkflowSlugs).
          const slug = plannedWorkflowSlugs.get(wf.slug) ?? wf.slug;
          if (slug !== wf.slug) {
            result.warnings.push(
              `Workflow '${wf.slug}' imported as '${slug}' — that slug is already used by another organisation`
            );
          }
          const created = await tx.aiWorkflow.create({
            data: {
              name: wf.name,
              slug,
              description: wf.description,
              patternsUsed: wf.patternsUsed,
              isActive: wf.isActive,
              isTemplate: wf.isTemplate,
              // Renamed: mark it, so importing this bundle again updates it.
              metadata:
                slug !== wf.slug
                  ? withImportedFromSlug(wf.metadata, wf.slug)
                  : ((wf.metadata as Prisma.InputJsonValue) ?? Prisma.JsonNull),
              createdBy: userId,
            },
          });
          await createInitialVersion({
            tx,
            workflowId: created.id,
            definition,
            userId,
          });
          result.workflows.created++;
        }
      }

      // Import event subscriptions (webhook + email channels).
      // Skip duplicates by destination — url for webhook rows,
      // emailAddress for email rows.
      for (const wh of parsed.data.webhooks) {
        const channel = wh.channel ?? 'webhook';
        const destination = channel === 'webhook' ? wh.url : wh.emailAddress;
        if (!destination) {
          result.warnings.push(
            `Skipped event subscription with channel "${channel}" and no destination value`
          );
          continue;
        }

        // A bundle is operator-supplied data that becomes a DESTINATION, so both
        // channels are validated here rather than trusted. Per row, with a
        // warning, matching the skip above — validating in the schema instead
        // would abort the whole restore over one bad subscription, taking agents,
        // capabilities, workflows and settings with it. It would also reject an
        // email row carrying a stale `url` left behind by a channel switch, which
        // the importer never even reads.
        if (channel === 'webhook' && !isSafeProviderUrl(destination)) {
          result.warnings.push(
            `Skipped webhook for ${destination} — private or internal addresses are not allowed as a destination`
          );
          continue;
        }
        if (channel === 'email' && !z.string().email().safeParse(destination).success) {
          result.warnings.push(
            `Skipped email subscription — "${destination}" is not a valid address`
          );
          continue;
        }

        if (channel === 'email' && erased.contacts.includes(normaliseAddress(destination))) {
          // Not echoed: it is the address being kept out.
          result.warnings.push(
            'Skipped an email subscription — its address belongs to a person whose data was erased'
          );
          continue;
        }

        const existing = await tx.aiWebhookSubscription.findFirst({
          where: channel === 'webhook' ? { url: destination } : { emailAddress: destination },
        });
        if (existing) {
          result.webhooks.skipped++;
          continue;
        }
        if (channel === 'email') noteKept([destination]);

        if (channel === 'webhook') {
          result.warnings.push(
            `Webhook for ${destination} imported inactive — set the signing secret and re-enable manually`
          );
          await tx.aiWebhookSubscription.create({
            data: {
              channel: 'webhook',
              url: destination,
              events: wh.events,
              description: wh.description ?? null,
              secret: '', // Secrets are never exported
              isActive: false, // Force inactive: empty secret would sign dispatches with an empty HMAC key
              createdBy: userId,
            },
          });
        } else {
          // Forced inactive and warned about, exactly like the webhook branch.
          // It used to honour the bundle's own `isActive`, and email delivery
          // needs no secret — so an imported bundle could stand up a LIVE
          // subscription mailing every matching event, with its full payload, to
          // an address of the bundle author's choosing, from the deployment's own
          // verified sender, with nothing in the result to say so. Quieter than
          // the webhook hole beside it, and cheaper.
          result.warnings.push(
            `Email subscription for ${destination} imported inactive — review the address and enable manually`
          );
          await tx.aiWebhookSubscription.create({
            data: {
              channel: 'email',
              emailAddress: destination,
              events: wh.events,
              description: wh.description ?? null,
              isActive: false,
              createdBy: userId,
            },
          });
        }
        result.webhooks.created++;
      }

      // Import settings — the shared part.
      if (includeShared && parsed.data.settings) {
        const s = parsed.data.settings;
        const escalationConfig = escalationWithoutErased(s.escalationConfig, erased.contacts);
        if (escalationConfig !== s.escalationConfig) {
          result.warnings.push(
            'Escalation list: addresses belonging to people whose data was erased were removed'
          );
        }
        noteKept(escalationAddresses(escalationConfig));
        await tx.aiOrchestrationSettings.upsert({
          where: { slug: 'global' },
          create: {
            slug: 'global',
            defaultModels: s.defaultModels as Prisma.InputJsonValue,
            globalMonthlyBudgetUsd: s.globalMonthlyBudgetUsd,
            searchConfig: (s.searchConfig as Prisma.InputJsonValue) ?? Prisma.JsonNull,
            defaultApprovalTimeoutMs: s.defaultApprovalTimeoutMs,
            approvalDefaultAction: s.approvalDefaultAction,
            inputGuardMode: s.inputGuardMode,
            outputGuardMode: s.outputGuardMode,
            citationGuardMode: s.citationGuardMode,
            webhookRetentionDays: s.webhookRetentionDays,
            webhookDlqRetentionDays: s.webhookDlqRetentionDays,
            costLogRetentionDays: s.costLogRetentionDays,
            auditLogRetentionDays: s.auditLogRetentionDays,
            executionRetentionDays: s.executionRetentionDays,
            evaluationRetentionDays: s.evaluationRetentionDays,
            maxConversationsPerUser: s.maxConversationsPerUser,
            maxMessagesPerConversation: s.maxMessagesPerConversation,
            escalationConfig: (escalationConfig as Prisma.InputJsonValue) ?? Prisma.JsonNull,
          },
          update: {
            defaultModels: s.defaultModels as Prisma.InputJsonValue,
            globalMonthlyBudgetUsd: s.globalMonthlyBudgetUsd,
            searchConfig: (s.searchConfig as Prisma.InputJsonValue) ?? Prisma.JsonNull,
            defaultApprovalTimeoutMs: s.defaultApprovalTimeoutMs,
            approvalDefaultAction: s.approvalDefaultAction,
            inputGuardMode: s.inputGuardMode,
            outputGuardMode: s.outputGuardMode,
            citationGuardMode: s.citationGuardMode,
            webhookRetentionDays: s.webhookRetentionDays,
            webhookDlqRetentionDays: s.webhookDlqRetentionDays,
            costLogRetentionDays: s.costLogRetentionDays,
            auditLogRetentionDays: s.auditLogRetentionDays,
            executionRetentionDays: s.executionRetentionDays,
            evaluationRetentionDays: s.evaluationRetentionDays,
            maxConversationsPerUser: s.maxConversationsPerUser,
            maxMessagesPerConversation: s.maxMessagesPerConversation,
            escalationConfig: (escalationConfig as Prisma.InputJsonValue) ?? Prisma.JsonNull,
          },
        });
        result.settingsUpdated = true;
      }
      if (keptContacts.size > 0) result.warnings.push(keptContactsWarning(keptContacts.size));
    },
    { timeout: IMPORT_TRANSACTION_TIMEOUT_MS }
  );

  if (result.settingsUpdated) {
    // As the settings PATCH does: the restored settings, the global budget cap
    // among them, take effect on this process's next read rather than up to
    // 30s later.
    invalidateOrchestrationSettingsCache();
    invalidateSettingsCache();
  }

  logger.info('Orchestration config imported', { ...result });
  return result;
}

/**
 * A warning per imported workflow with a step overriding to a model whose
 * provider the org is not approved for, keyed by workflow slug (§120 t-743).
 * The workflow is still imported and published — the call-time gate refuses
 * those steps — as agents are; see `importedAgentProviderWarnings`. One batched
 * policy question for every workflow; a policy that cannot be read yields one
 * general warning instead.
 */
async function importedWorkflowProviderWarnings(
  workflows: ReadonlyArray<{ slug: string; workflowDefinition: unknown }>
): Promise<{ bySlug: Map<string, string>; unchecked: string | null }> {
  const defs = new Map<string, WorkflowDefinition>();
  for (const wf of workflows) {
    const parsed = workflowDefinitionSchema.safeParse(wf.workflowDefinition);
    // An unparseable one is reported as a skip by the import loop.
    if (parsed.success) defs.set(wf.slug, parsed.data);
  }
  let found: Map<string, { stepId: string }[]>;
  try {
    found = await findUnapprovedModelOverridesIn(defs);
  } catch (error) {
    logger.error('Backup import could not check workflows against the org provider policy', {
      error: error instanceof Error ? error.message : String(error),
    });
    return {
      bySlug: new Map(),
      unchecked:
        "Workflows were imported without checking their model overrides against this organisation's approved providers, which could not be read",
    };
  }
  const bySlug = new Map<string, string>();
  for (const [slug, errors] of found) {
    if (errors.length === 0) continue;
    bySlug.set(
      slug,
      `Workflow '${slug}': imported, but steps ${errors.map((e) => `"${e.stepId}"`).join(', ')} ` +
        'override to providers this organisation is not approved to use — those steps are refused until a platform admin grants them'
    );
  }
  return { bySlug, unchecked: null };
}

/**
 * The erased among a bundle's subjects, under erasure's locks, taken once for
 * every subject before any is asked about.
 *
 * - **`contacts`**: the addresses (the email subscriptions', the escalation
 *   list's and the workflow definitions') erased since `since` (§122 t-902,
 *   t-900): the date this install sealed, over the bundle's contacts and this
 *   org (`export-seal.ts`). One erased earlier that such a copy still names
 *   was re-added on purpose. With no `since`, every erasure.
 *   **`everContacts`** is every erased one, so the import can count the
 *   re-added addresses it writes back.
 * - **`inWorkflows`**: what to strip from the definitions: those same
 *   addresses, and every approver id ever erased. An id is never issued
 *   again, so nobody can have re-added one.
 */
async function erasedSinceBundle(
  tx: Prisma.TransactionClient,
  subjects: BundleSubjects,
  { since }: { since: Date | undefined }
): Promise<{ inWorkflows: ErasedSubjects; contacts: string[]; everContacts: string[] }> {
  const addresses = [...subjects.workflows.addresses, ...subjects.contacts];
  await lockSubjects(tx, { addresses, userIds: subjects.workflows.userIds });
  const { userIds } = await matchErasedSubjects(tx, { userIds: subjects.workflows.userIds });
  const ever = (await matchErasedSubjects(tx, { addresses })).addresses;
  const recent = since ? (await matchErasedSubjects(tx, { addresses }, { since })).addresses : ever;
  return { inWorkflows: { addresses: recent, userIds }, contacts: recent, everContacts: ever };
}

/** The import's word when a bundle carries a seal this install does not accept. */
const SEAL_REJECTED_WARNING =
  "This backup's seal did not verify — it was edited, exported from another organisation or " +
  'install, or the install secret has changed since — so everyone ever erased was removed ' +
  'from its workflows, email subscriptions and escalation list';

/** Says how many re-added addresses a sealed import kept, never which. */
function keptContactsWarning(count: number): string {
  return (
    `Kept ${count} contact address${count === 1 ? '' : 'es'} belonging to people whose data ` +
    'was erased before this backup was taken: this install sealed the backup with them in it, ' +
    'so they were re-added after the erasure'
  );
}

interface BundleSubjects {
  /** Every address and approver id the workflow definitions name. */
  workflows: { addresses: string[]; userIds: string[] };
  /** The email subscriptions' addresses, and the escalation list's when imported. */
  contacts: string[];
}

/**
 * Every address and approver id a bundle names, for the erased-person check
 * (t-805): workflow definitions, email subscriptions, and — when shared
 * settings are imported — the escalation list.
 */
function bundleRecipients(
  data: {
    workflows: Array<{ workflowDefinition: unknown }>;
    webhooks: Array<{ channel?: string | null; emailAddress?: string | null }>;
    settings?: { escalationConfig: unknown } | null;
  },
  includeShared: boolean
): BundleSubjects {
  // Addresses from the same lists the seal covers (`bundleContacts`), so the
  // two cannot drift; approver ids, which the seal does not cover, alongside.
  const { subscriptions, escalation, workflows: addresses } = bundleContacts(data);
  const userIds: string[] = [];
  for (const wf of data.workflows) {
    const parsed = workflowDefinitionSchema.safeParse(wf.workflowDefinition);
    if (!parsed.success) continue;
    userIds.push(...definitionRecipients(parsed.data as unknown as Prisma.JsonValue).userIds);
  }
  const contacts = [...subscriptions, ...(includeShared ? escalation : [])];
  return { workflows: { addresses: [...addresses], userIds }, contacts };
}

/** The escalation config without erased addresses — the same object when none were. */
function escalationWithoutErased(config: unknown, erased: string[]): unknown {
  if (erased.length === 0 || !isRecord(config)) return config;
  const list = config.emailAddresses;
  if (!Array.isArray(list)) return config;
  const kept = list.filter((a) => typeof a !== 'string' || !erased.includes(normaliseAddress(a)));
  return kept.length === list.length ? config : { ...config, emailAddresses: kept };
}
