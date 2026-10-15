import type { Prisma } from '@prisma/client';
import type { SeedUnit } from '@/prisma/runner';
import type { BaseCapability } from '@/lib/orchestration/capabilities/base-capability';
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

interface CleanupCap {
  /** Admin-UI presentation, operator-owned — not what the LLM reads. */
  name: string;
  /** Admin-UI presentation, operator-owned — not what the LLM reads. */
  description: string;
  /**
   * The class the dispatcher runs. Its `functionDefinition` IS the seeded one,
   * so the schema the LLM is shown cannot drift from the schema the handler
   * accepts (#545, #646) — a hand-written copy here had drifted on all 14 —
   * and the row's slug and handler are its `slug` and class name.
   */
  capability: BaseCapability;
  rateLimit: number;
}

const DETERMINISTIC: CleanupCap[] = [
  {
    name: 'Strip Lines Matching',
    description:
      'Remove whole lines from the cleanup document where a regex matches anywhere in the line.',
    capability: new StripLinesMatchingCapability(),
    rateLimit: 60,
  },
  {
    name: 'Strip Matches',
    description:
      'Remove inline regex matches from the cleanup document, leaving surrounding text intact.',
    capability: new StripMatchesCapability(),
    rateLimit: 60,
  },
  {
    name: 'Strip Timestamps',
    description: 'Remove timestamp markers (00:00, [12:34:56], etc.) from the cleanup document.',
    capability: new StripTimestampsCapability(),
    rateLimit: 60,
  },
  {
    name: 'Strip Speaker Labels',
    description: 'Remove "Name:" or "[Name]" speaker labels at the start of lines.',
    capability: new StripSpeakerLabelsCapability(),
    rateLimit: 60,
  },
  {
    name: 'Collapse Whitespace',
    description: 'Collapse runs of spaces/tabs, trim trailing whitespace, and squash blank lines.',
    capability: new CollapseWhitespaceCapability(),
    rateLimit: 60,
  },
  {
    name: 'Dedupe Lines',
    description: 'Remove duplicate lines (adjacent or document-wide).',
    capability: new DedupeLinesCapability(),
    rateLimit: 60,
  },
  {
    name: 'Join Wrapped Lines',
    description:
      'Rejoin sentences a PDF or fixed-width renderer wrapped across lines, and rejoin hyphen-split words.',
    capability: new JoinWrappedLinesCapability(),
    rateLimit: 60,
  },
  {
    name: 'Normalise Punctuation',
    description: 'Convert typographic punctuation (smart quotes, dashes, ellipsis) to ASCII.',
    capability: new NormalisePunctuationCapability(),
    rateLimit: 60,
  },
];

const READ_ONLY: CleanupCap[] = [
  {
    name: 'Read Document',
    description:
      'Read a window of the cleanup document as numbered lines — the only capability that returns actual text.',
    capability: new ReadDocumentCapability(),
    rateLimit: 120,
  },
  {
    name: 'Find In Document',
    description:
      'Find lines matching a regex, returning line numbers and text. Checks a pattern before a destructive transform uses it.',
    capability: new FindInDocumentCapability(),
    rateLimit: 120,
  },
  {
    name: 'Preview Diff',
    description: 'Summarise the difference between the original and current cleanup state.',
    capability: new PreviewDiffCapability(),
    rateLimit: 120,
  },
  {
    name: 'Estimate Size',
    description:
      'Report token count and size class (small/medium/large/too-large) for the current cleanup state.',
    capability: new EstimateSizeCapability(),
    rateLimit: 120,
  },
];

const LLM_BACKED: CleanupCap[] = [
  {
    name: 'Rewrite With LLM',
    description: 'LLM rewrite of the entire cleanup document per natural-language instructions.',
    capability: new RewriteWithLlmCapability(),
    rateLimit: 6,
  },
  {
    name: 'Rewrite Section With LLM',
    description: 'LLM rewrite of a single matched section of the cleanup document.',
    capability: new RewriteSectionWithLlmCapability(),
    rateLimit: 12,
  },
];

export const CLEANUP_CAPABILITIES: readonly CleanupCap[] = [
  ...DETERMINISTIC,
  ...READ_ONLY,
  ...LLM_BACKED,
];

// Seeds the Document Clean Up capabilities the Cleanup Agent owns.
// Idempotent — re-seeding re-applies the code-owned fields and isSystem, so
// admin edits (name, description, rate limit) survive. The Cleanup Agent's
// binding lives in lib/orchestration/agents/platform-agent-definitions/
// cleanup-agent.ts, reconciled by 021-platform-agents.
//
// `hashInputs` names every class file, because the definition the seed writes
// now lives there: editing a class alone must re-run this unit, or the row
// keeps the old schema (the runner only re-seeds when the hash moves).
const unit: SeedUnit = {
  name: '019-cleanup-capabilities',
  hashInputs: [
    '../../lib/orchestration/capabilities/built-in/document-cleanup/collapse-whitespace.ts',
    '../../lib/orchestration/capabilities/built-in/document-cleanup/dedupe-lines.ts',
    '../../lib/orchestration/capabilities/built-in/document-cleanup/estimate-size.ts',
    '../../lib/orchestration/capabilities/built-in/document-cleanup/find-in-document.ts',
    '../../lib/orchestration/capabilities/built-in/document-cleanup/join-wrapped-lines.ts',
    '../../lib/orchestration/capabilities/built-in/document-cleanup/normalise-punctuation.ts',
    '../../lib/orchestration/capabilities/built-in/document-cleanup/preview-diff.ts',
    '../../lib/orchestration/capabilities/built-in/document-cleanup/read-document.ts',
    '../../lib/orchestration/capabilities/built-in/document-cleanup/rewrite-section-with-llm.ts',
    '../../lib/orchestration/capabilities/built-in/document-cleanup/rewrite-with-llm.ts',
    '../../lib/orchestration/capabilities/built-in/document-cleanup/strip-lines-matching.ts',
    '../../lib/orchestration/capabilities/built-in/document-cleanup/strip-matches.ts',
    '../../lib/orchestration/capabilities/built-in/document-cleanup/strip-speaker-labels.ts',
    '../../lib/orchestration/capabilities/built-in/document-cleanup/strip-timestamps.ts',
  ],
  async run({ prisma, logger }) {
    logger.info('🧼 Seeding document cleanup capabilities...');
    for (const cap of CLEANUP_CAPABILITIES) {
      const { slug } = cap.capability;
      const codeOwned = {
        executionType: 'internal' as const,
        executionHandler: cap.capability.constructor.name,
        // Internal, typed data (the class's own definition), not external input.
        functionDefinition: cap.capability.functionDefinition as unknown as Prisma.InputJsonValue,
      };
      await prisma.aiCapability.upsert({
        where: { slug },
        update: { isSystem: true, ...codeOwned },
        create: {
          slug,
          name: cap.name,
          description: cap.description,
          category: 'document_cleanup',
          rateLimit: cap.rateLimit,
          isActive: true,
          isSystem: true,
          ...codeOwned,
        },
      });
    }
    logger.info(`✅ Seeded ${CLEANUP_CAPABILITIES.length} document cleanup capabilities`);
  },
};

export default unit;
