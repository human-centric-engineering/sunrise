/**
 * Agreement: the ownerless-read roster and the owner layer say the same thing
 * (§115 t-803).
 *
 * Two answers to "which rows of a personal model may this admin read?" exist
 * side by side. The access helpers beside `ownerless-surfaces.ts` build the
 * `where` the routes send — their own, plus rows nobody owns when the policy
 * admits it. The owner layer (`lib/db/owner-extension.ts`) refuses a narrowed
 * caller's read that is not confined to exactly those rows. If the two drift,
 * a route the helper wrote correctly is refused, or the layer admits a row the
 * helper would not.
 *
 * So this pins both halves:
 *
 *   1. **The helpers' arms are the layer's admitted arms.** For each answer the
 *      policy can give, the helper's `where` confines the read, its row-level
 *      answer matches the layer's, and — where the layer builds the predicate
 *      itself — the two predicates are the same object.
 *   2. **Every core roster row says how the owner layer treats it.** The
 *      roster's rows are the files that read executions or conversations
 *      outside the helpers. Each is listed below with the owner layer's
 *      disposition for its reads, exact in both directions like
 *      `owner-raw-sql-manifest.test.ts`: a roster row with no disposition here
 *      fails, and so does a disposition for a row the roster no longer has.
 *      `admitted` and `no-subject` are checked against the source; `confined`,
 *      `checked` and `write` are claims with a reason — and a wrong one is a
 *      refusal in every environment, not a leak, because the layer checks the
 *      read itself.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { PrismaClient } from '@prisma/client';
import type { AuthenticatedSession } from '@/lib/auth/guards';
import type { UnattributedReads } from '@/lib/auth/orphan-reads';
import {
  readablePredicate,
  readOwnerSchema,
  rowReadable,
  whereConfines,
  type OwnerReader,
} from '@/lib/db/owner-extension';
import { enforcedModels } from '@/lib/db/owner-classification';
import {
  adminCanViewExecution,
  executionVisibilityWhere,
} from '@/lib/orchestration/access/execution-access';
import {
  adminCanViewDataset,
  datasetVisibilityWhere,
} from '@/lib/orchestration/access/dataset-access';
import { conversationVisibilityWhere } from '@/lib/orchestration/access/conversation-access';
import {
  OWNERLESS_MODELS,
  OWNERLESS_SURFACE_EXCEPTIONS,
} from '@/lib/orchestration/access/ownerless-surfaces';

// The fork tail ships empty; mocked so the roster below is core's alone.
vi.mock('@/lib/app/ci', () => ({ appOwnerlessSurfaceExceptions: [] }));

vi.mock('@/lib/logging', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// The schema is all the analysis reads; the adapter is never connected.
const base = new PrismaClient({
  adapter: {
    provider: 'postgres',
    adapterName: 'unused',
    connect: () => Promise.reject(new Error('not connected')),
  },
});
const schema = readOwnerSchema(base, enforcedModels());

const ME = 'cmuser0000000000000000me01';
const OTHER = 'cmuser0000000000000000ot01';

function reads(mayReadUnowned: boolean): UnattributedReads {
  return {
    conversation: mayReadUnowned,
    dataset: mayReadUnowned,
    execution: mayReadUnowned,
    experiment: mayReadUnowned,
    webhookDelivery: mayReadUnowned,
    webhookSubscription: mayReadUnowned,
  };
}

function sessionFor(mayReadUnowned: boolean): AuthenticatedSession {
  return {
    user: { id: ME },
    unattributedReads: reads(mayReadUnowned),
  } as unknown as AuthenticatedSession;
}

function readerFor(mayReadUnowned: boolean, readsShared = true): OwnerReader {
  return { userId: ME, unattributedReads: reads(mayReadUnowned), readsShared };
}

// ---------------------------------------------------------------------------
// 1. The helpers' arms are the layer's admitted arms
// ---------------------------------------------------------------------------

describe.each([true, false])('the helpers and the layer, ownerless reads admitted: %s', (may) => {
  const session = sessionFor(may);
  const reader = readerFor(may);

  it('every helper fragment confines its read on the layer', () => {
    expect(
      whereConfines(schema, 'AiWorkflowExecution', executionVisibilityWhere(session), reader)
    ).toBe(true);
    expect(whereConfines(schema, 'AiDataset', datasetVisibilityWhere(session), reader)).toBe(true);
    expect(
      whereConfines(schema, 'AiConversation', conversationVisibilityWhere(session), reader)
    ).toBe(true);
  });

  it('the layer builds the same predicate the helper does, for executions and datasets', () => {
    expect(readablePredicate(schema, 'AiWorkflowExecution', reader)).toEqual(
      executionVisibilityWhere(session)
    );
    expect(readablePredicate(schema, 'AiDataset', reader)).toEqual(datasetVisibilityWhere(session));
  });

  it("decides a fetched row as the helper does, whoever's it is", () => {
    for (const owner of [ME, OTHER, null]) {
      expect(rowReadable(schema, 'AiWorkflowExecution', owner, reader)).toBe(
        adminCanViewExecution({ userId: owner }, session)
      );
    }
    // `adminCanViewDataset` classifies a row its `where` already admitted, so
    // it answers for an ownerless row only where the policy let it through.
    for (const owner of may ? [ME, OTHER, null] : [ME, OTHER]) {
      expect(rowReadable(schema, 'AiDataset', owner, reader)).toBe(
        adminCanViewDataset({ userId: owner }, ME)
      );
    }
  });
});

it('every model the roster covers is enforced by the layer', () => {
  const pascal = (m: string) => m.charAt(0).toUpperCase() + m.slice(1);
  for (const model of Object.keys(OWNERLESS_MODELS)) {
    expect(enforcedModels()).toContain(pascal(model));
  }
});

// ---------------------------------------------------------------------------
// 2. Every core roster row says how the owner layer treats its reads
// ---------------------------------------------------------------------------

/**
 * How the owner layer treats a roster file's reads of executions,
 * conversations and messages.
 *
 *   • `confined`   — every read names the caller as owner, so the layer passes it.
 *   • `checked`    — reads one row by id, which the layer checks on the row
 *                    (or narrows) for a narrowed caller.
 *   • `admitted`   — reads inside a declared crossing (`runAcrossOwners`), in
 *                    this file or in `via`, the caller that wraps it.
 *   • `no-subject` — runs where no guard entered a subject: a machine
 *                    credential, a signed token, or a maintenance job.
 *   • `write`      — only writes that return no row the caller did not send.
 */
type OwnerDisposition =
  | { kind: 'confined' | 'checked' | 'no-subject' | 'write'; because: string }
  | { kind: 'admitted'; because: string; via?: string };

const OWNER_DISPOSITIONS: Record<string, OwnerDisposition> = {
  'lib/orchestration/chat/conversation-semantic-search.ts': {
    kind: 'confined',
    because: "raw SQL predicated on the helper's arms; in the raw-SQL manifest.",
  },
  'app/api/v1/admin/orchestration/conversations/clear/route.ts': {
    kind: 'write',
    because: 'a bulk `deleteMany`; whether a member may delete is the route’s decision.',
  },
  'app/api/v1/admin/orchestration/conversations/export/route.ts': {
    kind: 'confined',
    because: 'keyed on `userId: session.user.id`.',
  },
  'lib/orchestration/agents/agent-comparison.ts': {
    kind: 'admitted',
    because: 'per-agent counts, org-wide by row isolation, cross-owner by decision (t-682).',
  },
  'app/api/v1/chat/conversations/route.ts': {
    kind: 'confined',
    because: 'consumer list keyed on the caller.',
  },
  'app/api/v1/chat/conversations/search/route.ts': {
    kind: 'confined',
    because: 'consumer search keyed on the caller.',
  },
  'app/api/v1/chat/conversations/[id]/route.ts': {
    kind: 'confined',
    because: 'fetched and deleted by `{ id, userId }`.',
  },
  'app/api/v1/chat/conversations/[id]/share/route.ts': {
    kind: 'confined',
    because: 'the share is written on a conversation fetched by `{ id, userId }`.',
  },
  'app/api/v1/chat/conversations/[id]/messages/route.ts': {
    kind: 'confined',
    because: 'messages read through a conversation keyed on the caller.',
  },
  'app/api/v1/chat/conversations/[id]/messages/[messageId]/rate/route.ts': {
    kind: 'confined',
    because: 'the rated message is read through a conversation keyed on the caller.',
  },
  'app/api/v1/inbound/[channel]/[slug]/route.ts': {
    kind: 'no-subject',
    because: 'authenticated by the channel’s signature, not a guard.',
  },
  'app/api/v1/webhooks/trigger/[slug]/route.ts': {
    kind: 'no-subject',
    because: 'authenticated by the trigger’s secret, not a guard.',
  },
  'app/api/v1/orchestration/approvals/[id]/status/route.ts': {
    kind: 'no-subject',
    because: 'the signed approval token is the whole authorization.',
  },
  'lib/orchestration/approval-route-helpers.ts': {
    kind: 'no-subject',
    because: 'serves the approval-token routes, which enter no subject.',
  },
  'lib/orchestration/engine/orchestration-engine.ts': {
    kind: 'checked',
    because:
      'reads the run it drives by id, checked on the row; writes are `updateMany`. A resumed ' +
      'approval crosses owners in `resumeApprovedExecution`.',
  },
  'lib/orchestration/engine/lease.ts': {
    kind: 'write',
    because: 'lease claim, refresh and clear are `updateMany` keyed on the lease token.',
  },
  'lib/orchestration/engine/execution-reaper.ts': {
    kind: 'no-subject',
    because: 'a maintenance job; `runScopedJob` runs every job across owners.',
  },
  'lib/orchestration/scheduling/scheduler.ts': {
    kind: 'admitted',
    because:
      'its sweeps run as maintenance jobs (across owners in `runScopedJob`); a resumed ' +
      'approval crosses owners itself.',
  },
  'lib/orchestration/approval-actions.ts': {
    kind: 'checked',
    because:
      'reads the run by id, checked on the row; a named approver reaches it through ' +
      '`acrossOwnersForApproval` in the approve, reject and cancel routes.',
  },
  'lib/orchestration/retention.ts': {
    kind: 'no-subject',
    because: 'the retention purge runs as a maintenance job.',
  },
  'lib/privacy/export-sources.ts': {
    kind: 'admitted',
    because: "keyed on the data subject; an admin's export of them crosses owners.",
    via: 'lib/privacy/export-user.ts',
  },
  'lib/privacy/delivery-payloads.ts': {
    kind: 'admitted',
    because: 'raw SQL keyed on the data subject, inside the export’s crossing.',
    via: 'lib/privacy/export-user.ts',
  },
  'lib/privacy/run-recipients.ts': {
    kind: 'no-subject',
    because:
      'erasure runs in the audited system scope and redacts the subject from every run, whoever owns it (t-804).',
  },
  'lib/privacy/org-sources.ts': {
    kind: 'admitted',
    because: 'the org export reads every member’s rows inside its declared crossing.',
    via: 'lib/privacy/export-org.ts',
  },
  'lib/orchestration/evaluations/run-cases/workflow-case.ts': {
    kind: 'no-subject',
    because: 'the evaluation worker runs as a maintenance job.',
  },
  'lib/orchestration/evaluations/datasets/capture.ts': {
    kind: 'checked',
    because: 'reads by id a message and a run the capture route already admitted.',
  },
  'lib/orchestration/cost-estimation/workflow-cost.ts': {
    kind: 'admitted',
    because: 'an estimate over a workflow’s past runs; only figures leave the module.',
  },
  'lib/orchestration/chat/streaming-handler.ts': {
    kind: 'confined',
    because: 'conversation and message reads name `request.userId` as the owner.',
  },
  'lib/orchestration/chat/resume-conversation.ts': {
    kind: 'confined',
    because: 'keyed on `{ userId, agentId, contextType, contextId }`.',
  },
  'lib/orchestration/chat/message-embedder.ts': {
    kind: 'no-subject',
    because: 'the embedding backfill runs from the maintenance tick.',
  },
  'lib/orchestration/inbound/conversation-resolver.ts': {
    kind: 'no-subject',
    because: 'serves the inbound receivers, which enter no subject.',
  },
  'lib/orchestration/engine/executors/chat-turn.ts': {
    kind: 'checked',
    because: 'reads its run’s conversation and history by id in one read, checked by the layer.',
  },
  'lib/orchestration/capabilities/built-in/send-message-to-channel.ts': {
    kind: 'checked',
    because: 'reads the run and its conversation by id, checked on the row.',
  },
  'lib/orchestration/knowledge/document-manager.ts': {
    kind: 'write',
    because: 'creates the cleanup thread with the uploader as owner.',
  },
  'lib/orchestration/capabilities/built-in/document-cleanup/context.ts': {
    kind: 'checked',
    because: 'dereferences the conversation the engine handed it, by id.',
  },
  'lib/orchestration/knowledge/cleanup-agent.ts': {
    kind: 'checked',
    because: 'a `findFirst` the layer narrows to the caller’s own threads.',
  },
  'app/api/v1/admin/orchestration/knowledge/documents/[id]/cleanup/section/refine/route.ts': {
    kind: 'checked',
    because: 'a `findFirst` the layer narrows to the caller’s own threads.',
  },
  'app/api/v1/admin/orchestration/knowledge/documents/[id]/cleanup/finalise/route.ts': {
    kind: 'write',
    because: 'a cascading `deleteMany` of the document’s thread.',
  },
};

/** The crossing calls a source may make: the primitive, and the declared wrappers. */
const CROSSING =
  /\b(runAcrossOwners|acrossOwnersForApproval|resumeApprovedExecution|runScopedJob)\(/;

describe('the ownerless roster and the owner layer', () => {
  it('gives every core roster row an owner-layer disposition, and no other file one', () => {
    const roster = OWNERLESS_SURFACE_EXCEPTIONS.map((e) => e.path).sort();
    expect(Object.keys(OWNER_DISPOSITIONS).sort()).toEqual(roster);
  });

  it.each(Object.entries(OWNER_DISPOSITIONS))('%s', (file, disposition) => {
    expect(disposition.because.trim().length).toBeGreaterThan(20);
    if (disposition.kind === 'admitted') {
      const source = readFileSync(disposition.via ?? file, 'utf8');
      expect(source, `${disposition.via ?? file} declares no crossing`).toMatch(CROSSING);
    }
    if (disposition.kind === 'no-subject') {
      // A guarded handler enters a subject; a file that imports the guards is
      // not one where nobody is narrowed.
      expect(readFileSync(file, 'utf8')).not.toMatch(/from '@\/lib\/auth\/guards'/);
    }
  });
});
