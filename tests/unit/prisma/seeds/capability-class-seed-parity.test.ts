/**
 * Invariant: each built-in capability's seeded `functionDefinition` matches the
 * one its class declares.
 *
 * The seed row is what the LLM and every MCP client are shown; the class is
 * what actually validates and runs. When they disagree the model is told about
 * a tool that does not exist as described — either missing a parameter it could
 * have used, or offered one the handler will reject.
 *
 * Nothing enforced this before. #545 assumed a parity test already pinned
 * "class ↔ seed constant" and that only the DB write was unguarded; that was
 * not so, and `call_external_api` had silently drifted — the class advertises a
 * `multipart` parameter (added for endpoints like Gotenberg that need named
 * file parts) that the seed never gained, so no agent could ever use it.
 *
 * That drift matters more now than it did: since #545 the seed is re-applied to
 * existing rows on every deploy, so a stale constant is not merely never
 * propagated, it is actively re-asserted over anything an operator fixed by
 * hand.
 *
 * Deep equality on purpose. Comparing parameter *names* would have caught the
 * missing `multipart` but not the `body` description that had also drifted out
 * of step with it — and a description is not cosmetic here, it is how the model
 * decides which parameter to use.
 *
 * @see .context/database/seeding.md — the seed ownership rule
 */

import { describe, it, expect } from 'vitest';

import { scanCapabilitySeeds } from '@/tests/helpers/seed-capabilities';

import { CAPABILITY_DEFINITIONS } from '@/prisma/seeds/005-pattern-advisor';
import {
  ADD_PROVIDER_MODELS_DEFINITION,
  APPLY_AUDIT_CHANGES_DEFINITION,
  DEACTIVATE_PROVIDER_MODELS_DEFINITION,
} from '@/prisma/seeds/010-model-auditor';
import { CALL_EXTERNAL_API_IMPL } from '@/prisma/seeds/011-call-external-api';
import { RUN_WORKFLOW_IMPL } from '@/prisma/seeds/012-run-workflow';
import { UPLOAD_TO_STORAGE_IMPL } from '@/prisma/seeds/013-upload-to-storage';
import { SEND_MESSAGE_IMPL } from '@/prisma/seeds/014-send-message-to-channel';

import { AddProviderModelsCapability } from '@/lib/orchestration/capabilities/built-in/add-provider-models';
import { ApplyAuditChangesCapability } from '@/lib/orchestration/capabilities/built-in/apply-audit-changes';
import { CallExternalApiCapability } from '@/lib/orchestration/capabilities/built-in/call-external-api';
import { DeactivateProviderModelsCapability } from '@/lib/orchestration/capabilities/built-in/deactivate-provider-models';
import { EstimateCostCapability } from '@/lib/orchestration/capabilities/built-in/estimate-cost';
import { GetPatternDetailCapability } from '@/lib/orchestration/capabilities/built-in/get-pattern-detail';
import { RunWorkflowCapability } from '@/lib/orchestration/capabilities/built-in/run-workflow';
import { SearchKnowledgeCapability } from '@/lib/orchestration/capabilities/built-in/search-knowledge';
import { SendMessageToChannelCapability } from '@/lib/orchestration/capabilities/built-in/send-message-to-channel';
import { UploadToStorageCapability } from '@/lib/orchestration/capabilities/built-in/upload-to-storage';

/** A seeded definition, whatever shape the seed file happens to hold it in. */
type SeededDefinition = { functionDefinition: unknown };

const byslug = (slug: string): SeededDefinition => {
  const found = CAPABILITY_DEFINITIONS.find((d) => d.slug === slug);
  if (!found) throw new Error(`005-pattern-advisor has no definition for "${slug}"`);
  return found;
};

const PAIRS: {
  slug: string;
  seeded: SeededDefinition;
  instance: { functionDefinition: unknown };
}[] = [
  {
    slug: 'search_knowledge_base',
    seeded: byslug('search_knowledge_base'),
    instance: new SearchKnowledgeCapability(),
  },
  {
    slug: 'get_pattern_detail',
    seeded: byslug('get_pattern_detail'),
    instance: new GetPatternDetailCapability(),
  },
  {
    slug: 'estimate_workflow_cost',
    seeded: byslug('estimate_workflow_cost'),
    instance: new EstimateCostCapability(),
  },
  {
    slug: 'apply_audit_changes',
    seeded: APPLY_AUDIT_CHANGES_DEFINITION,
    instance: new ApplyAuditChangesCapability(),
  },
  {
    slug: 'add_provider_models',
    seeded: ADD_PROVIDER_MODELS_DEFINITION,
    instance: new AddProviderModelsCapability(),
  },
  {
    slug: 'deactivate_provider_models',
    seeded: DEACTIVATE_PROVIDER_MODELS_DEFINITION,
    instance: new DeactivateProviderModelsCapability(),
  },
  {
    slug: 'call_external_api',
    seeded: CALL_EXTERNAL_API_IMPL,
    instance: new CallExternalApiCapability(),
  },
  { slug: 'run_workflow', seeded: RUN_WORKFLOW_IMPL, instance: new RunWorkflowCapability() },
  {
    slug: 'upload_to_storage',
    seeded: UPLOAD_TO_STORAGE_IMPL,
    instance: new UploadToStorageCapability(),
  },
  {
    slug: 'send_message_to_channel',
    seeded: SEND_MESSAGE_IMPL,
    instance: new SendMessageToChannelCapability(),
  },
];

describe('built-in capabilities — seed definition matches the class (#545)', () => {
  it('covers every capability the seeds define', () => {
    // Derived from the seeds, not asserted against a literal. The first version
    // hardcoded `toHaveLength(10)` and deferred coverage to the companion
    // check, which counts upsert STATEMENTS with a `>=` floor — so a review
    // added an 11th capability in a fresh seed file and both suites stayed
    // green while its class↔seed parity went unwatched. That is the exact
    // failure this pair exists to close.
    //
    // Keyed on `functionDefinition.name`, not the `where:` slug: only four of
    // the eight upserts pass a literal slug (005 loops, 010 reads `def.slug`),
    // so slugs would have covered under half of them.
    const { definedNames } = scanCapabilitySeeds();
    const paired = new Set(PAIRS.map((p) => p.slug));

    // Floor first. An earlier version read zero slugs through a regex bug, so
    // `[].filter(unpaired)` was `[]` and the assertion passed while covering
    // nothing. A derived expectation needs its own non-emptiness check.
    expect(definedNames.length).toBeGreaterThanOrEqual(10);
    expect(definedNames.filter((n) => !paired.has(n))).toEqual([]);
    expect(new Set(PAIRS.map((p) => p.slug)).size).toBe(PAIRS.length);
  });

  it.each(PAIRS)('$slug', ({ seeded, instance }) => {
    expect(seeded.functionDefinition).toEqual(instance.functionDefinition);
  });
});
