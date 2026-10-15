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
 * ---------------------------------------------------------------------------
 * FORK NOTE — your capability seeds are read here too
 * ---------------------------------------------------------------------------
 * The completeness check reads every seed under `prisma/seeds/`, recursively,
 * yours included, and fails on a capability with no pair. Declare your pairs in
 * `lib/app/capability-seed-pairs.ts` (`APP_CAPABILITY_PAIRS`, spread into
 * `PAIRS` below) — do not add rows to `PAIRS`, which is Sunrise's and a merge
 * conflict on every upgrade. A seed whose definitions the reader cannot name
 * (imported, read off an instance) also needs `seedFile` on its pairs (#646).
 *
 * @see .context/database/seeding.md — the seed ownership rule
 * @see lib/app/capability-seed-pairs.ts — where a fork's pairs go
 */

import { describe, it, expect } from 'vitest';

import { scanCapabilitySeeds } from '@/tests/helpers/seed-capabilities';
import { APP_CAPABILITY_PAIRS, type AppCapabilityPair } from '@/lib/app/capability-seed-pairs';

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
import { CLEANUP_CAPABILITIES } from '@/prisma/seeds/019-cleanup-capabilities';

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
import { CollapseWhitespaceCapability } from '@/lib/orchestration/capabilities/built-in/document-cleanup/collapse-whitespace';
import { DedupeLinesCapability } from '@/lib/orchestration/capabilities/built-in/document-cleanup/dedupe-lines';
import { EstimateSizeCapability } from '@/lib/orchestration/capabilities/built-in/document-cleanup/estimate-size';
import { FindInDocumentCapability } from '@/lib/orchestration/capabilities/built-in/document-cleanup/find-in-document';
import { JoinWrappedLinesCapability } from '@/lib/orchestration/capabilities/built-in/document-cleanup/join-wrapped-lines';
import { NormalisePunctuationCapability } from '@/lib/orchestration/capabilities/built-in/document-cleanup/normalise-punctuation';
import { PreviewDiffCapability } from '@/lib/orchestration/capabilities/built-in/document-cleanup/preview-diff';
import { ReadDocumentCapability } from '@/lib/orchestration/capabilities/built-in/document-cleanup/read-document';
import { RewriteSectionWithLlmCapability } from '@/lib/orchestration/capabilities/built-in/document-cleanup/rewrite-section-with-llm';
import { RewriteWithLlmCapability } from '@/lib/orchestration/capabilities/built-in/document-cleanup/rewrite-with-llm';
import { StripLinesMatchingCapability } from '@/lib/orchestration/capabilities/built-in/document-cleanup/strip-lines-matching';
import { StripMatchesCapability } from '@/lib/orchestration/capabilities/built-in/document-cleanup/strip-matches';
import { StripSpeakerLabelsCapability } from '@/lib/orchestration/capabilities/built-in/document-cleanup/strip-speaker-labels';
import { StripTimestampsCapability } from '@/lib/orchestration/capabilities/built-in/document-cleanup/strip-timestamps';

/** A seeded definition, whatever shape the seed file happens to hold it in. */
type SeededDefinition = { functionDefinition: unknown };

const byslug = (slug: string): SeededDefinition => {
  const found = CAPABILITY_DEFINITIONS.find((d) => d.slug === slug);
  if (!found) throw new Error(`005-pattern-advisor has no definition for "${slug}"`);
  return found;
};

const CLEANUP_SEED = '019-cleanup-capabilities.ts';

/**
 * 019 builds each definition from the class instance it holds, so the reader
 * cannot name them (it reports the file as opaque). Each row still pins the
 * slug to a FRESH instance of the class the test expects, which is what
 * catches the seed wiring the wrong class to a slug.
 */
const cleanup = (slug: string, instance: { functionDefinition: unknown }): AppCapabilityPair => {
  const found = CLEANUP_CAPABILITIES.find((c) => c.slug === slug);
  if (!found) throw new Error(`019-cleanup-capabilities has no capability "${slug}"`);
  return {
    slug,
    seeded: { functionDefinition: found.capability.functionDefinition },
    instance,
    seedFile: CLEANUP_SEED,
  };
};

const PAIRS: AppCapabilityPair[] = [
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
  cleanup('collapse_whitespace', new CollapseWhitespaceCapability()),
  cleanup('dedupe_lines', new DedupeLinesCapability()),
  cleanup('estimate_size', new EstimateSizeCapability()),
  cleanup('find_in_document', new FindInDocumentCapability()),
  cleanup('join_wrapped_lines', new JoinWrappedLinesCapability()),
  cleanup('normalise_punctuation', new NormalisePunctuationCapability()),
  cleanup('preview_diff', new PreviewDiffCapability()),
  cleanup('read_document', new ReadDocumentCapability()),
  cleanup('rewrite_section_with_llm', new RewriteSectionWithLlmCapability()),
  cleanup('rewrite_with_llm', new RewriteWithLlmCapability()),
  cleanup('strip_lines_matching', new StripLinesMatchingCapability()),
  cleanup('strip_matches', new StripMatchesCapability()),
  cleanup('strip_speaker_labels', new StripSpeakerLabelsCapability()),
  cleanup('strip_timestamps', new StripTimestampsCapability()),
  ...APP_CAPABILITY_PAIRS,
];

const paired = new Set(PAIRS.map((p) => p.slug));

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

    // Floor first. An earlier version read zero slugs through a regex bug, so
    // `[].filter(unpaired)` was `[]` and the assertion passed while covering
    // nothing. A derived expectation needs its own non-emptiness check.
    expect(definedNames.length).toBeGreaterThanOrEqual(10);
    expect(definedNames.filter((n) => !paired.has(n))).toEqual([]);
    expect(new Set(PAIRS.map((p) => p.slug)).size).toBe(PAIRS.length);
  });

  it('covers every seed file whose definitions the reader cannot name (#646)', () => {
    // A definition the reader cannot name used to contribute nothing, and
    // nothing was reported either — so 019's fourteen capabilities went
    // unwatched while every one of them drifted from its class. A file that
    // also names capabilities (005 and 010 re-read their own literals through
    // `def.functionDefinition`) is covered by the check above; one that names
    // none must be declared by a pair's `seedFile`.
    const { definitions, opaqueDefinitions } = scanCapabilitySeeds();
    const named = new Set(definitions.map((d) => d.file));
    const declared = new Set(PAIRS.map((p) => p.seedFile).filter(Boolean));
    const uncovered = [...new Set(opaqueDefinitions.map((o) => o.file))].filter(
      (file) => !named.has(file) && !declared.has(file)
    );
    expect(uncovered).toEqual([]);
    // A declared file must actually be opaque, or the declaration is a typo
    // that exempts nothing — and hides the file it meant.
    const opaque = new Set(opaqueDefinitions.map((o) => o.file));
    expect([...declared].filter((file) => !opaque.has(file as string))).toEqual([]);
  });

  it('pairs every capability 019 seeds', () => {
    // 019 is declared opaque above, so the reader cannot list its names; the
    // seed module can. A capability added to it without a row fails here.
    const unpaired = CLEANUP_CAPABILITIES.map((c) => c.slug).filter((s) => !paired.has(s));
    expect(unpaired).toEqual([]);
  });

  it.each(PAIRS)('$slug', ({ seeded, instance }) => {
    expect(seeded.functionDefinition).toEqual(instance.functionDefinition);
  });
});
