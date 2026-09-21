/**
 * Document Clean Up concurrency smoke script.
 *
 * Proves the one thing a mocked test cannot: that N cleanup capabilities
 * dispatched AT THE SAME TIME against one document all land, in some order,
 * with no lost update and no unique-constraint failure.
 *
 * This is not hypothetical. The chat tool loop dispatches a turn's tool calls
 * with `Promise.allSettled` (streaming-handler.ts), so an agent that answers
 * "yes, proceed" with a five-step cleanup plan fires five mutating
 * capabilities concurrently. Before the document row lock:
 *
 *   - every capability read the same `processedContent`, so the last write
 *     won and silently discarded the others (observed: a 5-step plan that
 *     reduced a 40,902-char document by 63 chars, then by 0);
 *   - `writeRevision` allocated its version with `max(version)+1`, so the
 *     concurrent inserts collided on the (documentId, version) unique index
 *     and surfaced a raw P2002 to the agent, which relayed it to the admin as
 *     "there was an error processing this step".
 *
 * The assertions below fail if either regression returns: step 3 requires
 * every mutation to be present in the final content (composition, not
 * last-write-wins) and step 4 requires one revision per mutation with a
 * contiguous version sequence.
 *
 * Skips cleanly (exit 0) when no database is reachable, so it is safe to
 * invoke anywhere — it only does real work where a DB exists.
 *
 * Self-cleaning: creates one `smoke-test-cleanup-concurrency_*` knowledge base,
 * document and conversation and removes them on every path, plus a
 * prefix-scoped sweep at startup for the one path `finally` cannot cover — a
 * signal between the create and the delete. Never touches seed data, never
 * uses an unscoped delete.
 *
 * Run with:
 *   npm run smoke:cleanup-concurrency
 *   npx tsx --env-file=.env.local scripts/smoke/cleanup-concurrency.ts
 */

import { prisma } from '@/lib/db/client';
import { CollapseWhitespaceCapability } from '@/lib/orchestration/capabilities/built-in/document-cleanup/collapse-whitespace';
import { DedupeLinesCapability } from '@/lib/orchestration/capabilities/built-in/document-cleanup/dedupe-lines';
import { NormalisePunctuationCapability } from '@/lib/orchestration/capabilities/built-in/document-cleanup/normalise-punctuation';
import { StripSpeakerLabelsCapability } from '@/lib/orchestration/capabilities/built-in/document-cleanup/strip-speaker-labels';
import { StripTimestampsCapability } from '@/lib/orchestration/capabilities/built-in/document-cleanup/strip-timestamps';
import type { CapabilityContext } from '@/lib/orchestration/capabilities/types';
import { runAsOrg } from '@/lib/tenancy/context';
import { INSTALL_ORG_ID } from '@/lib/tenancy/constants';

const PREFIX = 'smoke-test-cleanup-concurrency';
const stamp = Date.now();
const NAME = `${PREFIX}_${stamp}`;

// One line per mutation so each capability's effect is independently visible
// in the final content. Every marker below must survive; a lost update drops
// one of them.
const SOURCE = [
  '[Alice] 00:12 she said \u201chello\u201d \u2013 twice',
  'DUPLICATE LINE',
  'DUPLICATE LINE',
  'Bob: 01:45 and then   he   left',
  'TRAILING WHITESPACE HERE   ',
].join('\n');

interface Expectation {
  label: string;
  /** Must hold of the final content if this capability's write survived. */
  holds: (content: string) => boolean;
}

const EXPECTATIONS: Expectation[] = [
  { label: 'strip_timestamps', holds: (c) => !c.includes('00:12') && !c.includes('01:45') },
  { label: 'strip_speaker_labels', holds: (c) => !c.includes('[Alice]') && !c.includes('Bob:') },
  {
    label: 'dedupe_lines',
    holds: (c) => c.split('\n').filter((l) => l.includes('DUPLICATE LINE')).length === 1,
  },
  { label: 'collapse_whitespace', holds: (c) => !/[ \t]{2,}/.test(c) && !/[ \t]+$/m.test(c) },
  {
    label: 'normalise_punctuation',
    holds: (c) => !/[\u201c\u201d\u2013]/.test(c) && c.includes('"hello"'),
  },
];

async function sweep(): Promise<void> {
  const docs = await prisma.aiKnowledgeDocument.findMany({
    where: { name: { startsWith: PREFIX } },
    select: { id: true },
  });
  for (const doc of docs) {
    await prisma.aiConversation.deleteMany({
      where: { contextType: 'knowledge_document', contextId: doc.id },
    });
    await prisma.aiKnowledgeDocumentRevision.deleteMany({ where: { documentId: doc.id } });
    await prisma.aiKnowledgeDocument.delete({ where: { id: doc.id } }).catch(() => {});
  }
  await prisma.aiKnowledgeBase.deleteMany({ where: { name: { startsWith: PREFIX } } });
}

async function main(): Promise<void> {
  await sweep();

  // An agent row is required by AiConversation.agentId. Reuse whichever agent
  // exists — the capabilities resolve their target from the conversation's
  // context, not from the agent.
  const agent = await prisma.aiAgent.findFirst({ select: { id: true } });
  if (!agent) {
    console.log('⏭  No agent rows in this database — nothing to bind a conversation to. Skipping.');
    return;
  }

  const base = await prisma.aiKnowledgeBase.create({
    data: { name: NAME, slug: `${PREFIX}-${stamp}`, description: 'smoke fixture' },
  });
  const doc = await prisma.aiKnowledgeDocument.create({
    data: {
      knowledgeBaseId: base.id,
      slug: `${PREFIX}-${stamp}`,
      name: NAME,
      fileName: `${NAME}.md`,
      fileHash: `smoke${stamp}`,
      status: 'cleaning',
      originalContent: SOURCE,
    },
  });
  const conversation = await prisma.aiConversation.create({
    data: {
      agentId: agent.id,
      contextType: 'knowledge_document',
      contextId: doc.id,
      title: NAME,
    },
  });

  let failures = 0;
  try {
    const context: CapabilityContext = {
      // null rather than a synthetic id: revision.actorId is a real FK to
      // User, and the script must not create or depend on a user row.
      userId: null,
      agentId: agent.id,
      conversationId: conversation.id,
    };

    // Step 1–2: fire all five at once, exactly as the chat tool loop does.
    console.log('▶  Dispatching 5 mutating capabilities concurrently…');
    const results = await Promise.all([
      new StripTimestampsCapability().execute({}, context),
      new StripSpeakerLabelsCapability().execute({}, context),
      new DedupeLinesCapability().execute({}, context),
      new CollapseWhitespaceCapability().execute({}, context),
      new NormalisePunctuationCapability().execute({}, context),
    ]);

    const errors = results.filter((r) => !r.success);
    if (errors.length > 0) {
      failures++;
      console.error(`❌ ${errors.length}/5 capabilities returned an error:`);
      for (const e of errors) {
        console.error(`   ${e.error?.code ?? 'unknown'}: ${e.error?.message ?? ''}`);
      }
    } else {
      console.log('✅ All 5 capabilities succeeded (no unique-constraint failure).');
    }

    // Step 3: every mutation must be visible in the final content.
    const after = await prisma.aiKnowledgeDocument.findUniqueOrThrow({
      where: { id: doc.id },
      select: { processedContent: true },
    });
    const finalContent = after.processedContent ?? '';
    const lost = EXPECTATIONS.filter((e) => !e.holds(finalContent));
    if (lost.length > 0) {
      failures++;
      console.error(
        `❌ ${lost.length}/5 mutations were lost: ${lost.map((l) => l.label).join(', ')}`
      );
      console.error('   Final content:\n' + finalContent);
    } else {
      console.log('✅ All 5 mutations present in the final content (writes composed).');
    }

    // Step 4: one revision per mutation, versions contiguous from 1.
    const revisions = await prisma.aiKnowledgeDocumentRevision.findMany({
      where: { documentId: doc.id },
      orderBy: { version: 'asc' },
      select: { version: true, source: true },
    });
    const versions = revisions.map((r) => r.version);
    const expected = Array.from({ length: 5 }, (_, i) => i + 1);
    if (JSON.stringify(versions) !== JSON.stringify(expected)) {
      failures++;
      console.error(
        `❌ Expected revision versions ${expected.join(',')}, got ${versions.join(',')}`
      );
    } else {
      console.log('✅ 5 revisions written with contiguous versions 1–5.');
    }
  } finally {
    await prisma.aiConversation.delete({ where: { id: conversation.id } }).catch(() => {});
    await prisma.aiKnowledgeDocumentRevision.deleteMany({ where: { documentId: doc.id } });
    await prisma.aiKnowledgeDocument.delete({ where: { id: doc.id } }).catch(() => {});
    await prisma.aiKnowledgeBase.delete({ where: { id: base.id } }).catch(() => {});
  }

  if (failures > 0) {
    console.error(`\n${failures} check(s) failed.`);
    process.exitCode = 1;
  } else {
    console.log('\nAll checks passed.');
  }
}

// The install org is the org a smoke runs for: at `multi` a tenant-owned
// read outside any scope refuses rather than reads wide (§107 t-708).
runAsOrg(INSTALL_ORG_ID, main, { source: 'job' })
  .catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    if (/ECONNREFUSED|Can't reach database server|P1001/.test(message)) {
      console.log('⏭  No database reachable — skipping.');
      return;
    }
    console.error('❌ Smoke script failed:', message);
    process.exitCode = 1;
  })
  .finally(() => {
    void prisma.$disconnect();
  });
