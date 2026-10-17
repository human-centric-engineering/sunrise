/**
 * Owner classification — which models are private to one person inside an org
 * (§115 t-800).
 *
 * The org wall (§107) is enforced by Postgres. The wall *inside* an org — an
 * org ADMIN must not read a MEMBER's conversation — is enforced today route by
 * route (`lib/orchestration/access/*`, the guards' ownership declarations), and
 * §115's data-layer assertion (t-801) needs to know which models it guards
 * and how each one's owner is reached. This is that list, and nothing else
 * decides it.
 *
 * Every model with a foreign key to `User`, and every model with a foreign key
 * to a personal model, is exactly one of:
 *
 *   • **personal** — a row is its owner's. Reached either by a column on the
 *     row (`userId` → User) or `through` a relation to a personal parent (an
 *     `AiMessage` is its conversation's). A model is personal here **because
 *     the platform already scopes its reads to the owner**: the route layer's
 *     access helpers and ownership declarations are the evidence, and the parity
 *     test (t-801) holds the two together. Classifying something personal that
 *     the routes treat as shared would make the data layer refuse reads the
 *     product means to allow.
 *   • **not-personal** — the user link records who *did* something (authored
 *     config, incurred a cost, holds a membership), not who the row is
 *     private to. Carries the reason, because "why is this not narrowed?" is the
 *     question a reviewer asks.
 *
 * `tests/unit/lib/db/owner-classification.test.ts` parses `prisma/schema` and
 * fails naming any model that has such a foreign key and is not listed here,
 * or that is listed with a path the schema does not have. **Never delete a row
 * to make it pass** — an unlisted personal model is one the data layer will
 * not guard. A fork classifies its own models through the
 * `lib/app/owner-classification.ts` seam (t-807), never by editing this list;
 * the readers below merge what it registers, and the test holds the fork's
 * schema files to the same rules.
 *
 * **Platform rows (§116) are outside this list by construction.** The rows
 * every org may read — `isSystem` / `isTemplate` / `scope = 'system'` — all sit
 * on config models, none of which is personal; the test asserts no personal
 * model carries those columns, so the owner check never has to admit them.
 *
 * **Enforcement switches on per model** (§115 ruling 3): `enforced: true` is
 * what makes `lib/db/owner-extension.ts` refuse a narrowed caller's read of
 * another member's rows. A model is marked once every call site reading it
 * complies — `AiUserMemory` in t-801, conversations and messages in t-802,
 * executions, evaluations and datasets in t-803 — so `main` is never broken
 * between sweeps. A personal model not yet enforced is classified, guarded by
 * the routes as before, and not checked by the data layer.
 *
 * @see lib/auth/subject-context.ts — whose rows the current caller may read
 * @see .context/auth/authorization.md — "Owner classification"
 */
import type { UnattributedReadKind } from '@/lib/auth/orphan-reads';
import { initAppOwnerClassification } from '@/lib/app/owner-classification';
import { createAppInitGate, restoreMap } from '@/lib/fork-init';
import { logger } from '@/lib/logging';

/** How a personal row's owner is reached. */
export type OwnerPath =
  /** A column on the row itself, holding the owning user's id. */
  | { column: string }
  /**
   * A required-or-optional relation to a personal parent; the row is the
   * parent's owner's. `field` is the relation field on this model.
   *
   * **The child inherits the parent's visibility.** A row is readable through
   * its parent exactly when the parent is: the parent's own `ownerless` and
   * `alsoVisible` arms admit its children too, so the messages of a shared or
   * an inbound conversation are readable by whoever may read that
   * conversation. The child's own `ownerless` covers only a null relation —
   * a child with no parent at all. `lib/db/owner-extension.ts` analyses a
   * `through` predicate as the parent's predicate under the relation field.
   */
  | { through: { field: string; parent: string } };

export type OwnerClassification =
  | {
      kind: 'personal';
      owner: OwnerPath;
      /**
       * When the owner can be missing (a null column, or a null relation), the
       * ownerless-read kind that decides whether a narrowed caller may read
       * such a row — `session.unattributedReads[kind]`. Absent means an ownerless
       * row is nobody's to read but an unnarrowed caller.
       */
      ownerless?: UnattributedReadKind;
      /**
       * Other people's rows a narrowed caller may still read, by the product's
       * own rule. `'active-share'`: a conversation its owner shared, while the
       * share is live (`conversationVisibilityWhere`'s third arm) — and only
       * on the admin surface the share consents to (`OwnerReader.readsShared`).
       */
      alsoVisible?: readonly 'active-share'[];
      /**
       * The data layer refuses a narrowed caller's read of another member's
       * rows of this model (`lib/db/owner-extension.ts`). Absent: classified,
       * not yet checked there.
       */
      enforced?: true;
    }
  | { kind: 'not-personal'; because: string };

/**
 * The classification. Keyed by Prisma model name; grouped by schema file.
 */
export const OWNER_CLASSIFICATION = {
  // ── auth / tenancy ────────────────────────────────────────────────────────
  Session: {
    kind: 'not-personal',
    because:
      'Read by the auth layer to establish who the caller is — before any subject exists to narrow by.',
  },
  Account: {
    kind: 'not-personal',
    because: 'Credential row read by the auth layer before any subject exists.',
  },
  OrgMembership: {
    kind: 'not-personal',
    because:
      'Decides which org a request acts for; an org roster is read by its admins (canAdminister on the org), not owner-scoped.',
  },
  OrgSupportGrant: {
    kind: 'not-personal',
    because:
      "The org's consent record for vendor support; grantedBy / revokedBy record who acted. Read by the org's OWNER/ADMINs and platform admins, not owner-scoped.",
  },
  AiApiKey: {
    kind: 'personal',
    owner: { column: 'userId' },
  },

  // ── platform ──────────────────────────────────────────────────────────────
  FeatureFlag: {
    kind: 'not-personal',
    because: 'Global config shared by every org; createdBy is authorship.',
  },
  DataErasureReceipt: {
    kind: 'not-personal',
    because:
      'Compliance record of an erasure, read by those who audit; the subject no longer exists to own it.',
  },

  // ── conversations ─────────────────────────────────────────────────────────
  AiConversation: {
    kind: 'personal',
    owner: { column: 'userId' },
    ownerless: 'conversation',
    alsoVisible: ['active-share'],
    enforced: true,
  },
  AiMessage: {
    kind: 'personal',
    owner: { through: { field: 'conversation', parent: 'AiConversation' } },
    enforced: true,
  },
  AiMessageEmbedding: {
    kind: 'personal',
    owner: { through: { field: 'message', parent: 'AiMessage' } },
  },
  AiConversationShare: {
    kind: 'not-personal',
    because:
      'An access grant read by its token to admit a recipient; the conversation it names is what is personal, and it is checked there.',
  },
  AiOutboundMessage: {
    kind: 'not-personal',
    because:
      'Channel delivery outbox, read by the dispatcher acting for the org — never listed to a person.',
  },
  AiUserMemory: {
    kind: 'personal',
    owner: { column: 'userId' },
    enforced: true,
  },
  AiEventHook: {
    kind: 'not-personal',
    because:
      'Org config, admin-global: every admin reads every hook (webhook-delivery-access.ts). createdBy is authorship.',
  },

  // ── agents ────────────────────────────────────────────────────────────────
  AiAgent: {
    kind: 'not-personal',
    because: 'Org config shared by the org; createdBy is authorship.',
  },
  AiAgentProfile: {
    kind: 'not-personal',
    because: 'Global config shared by every org; createdBy is authorship.',
  },
  AiAgentInviteToken: {
    kind: 'not-personal',
    because: "Agent access grant managed by the agent's admins; createdBy is authorship.",
  },
  AiAgentVersion: {
    kind: 'not-personal',
    because: "Snapshot of org config (an agent's history); createdBy is authorship.",
  },
  AiAgentEmbedToken: {
    kind: 'not-personal',
    because: "Embed credential managed by the agent's admins; createdBy is authorship.",
  },

  // ── evaluation ────────────────────────────────────────────────────────────
  AiEvaluationSession: {
    kind: 'personal',
    owner: { column: 'userId' },
    enforced: true,
  },
  AiEvaluationLog: {
    kind: 'personal',
    owner: { through: { field: 'session', parent: 'AiEvaluationSession' } },
    enforced: true,
  },
  AiDataset: {
    kind: 'personal',
    owner: { column: 'userId' },
    ownerless: 'dataset',
    enforced: true,
  },
  AiDatasetCase: {
    kind: 'personal',
    owner: { through: { field: 'dataset', parent: 'AiDataset' } },
    enforced: true,
  },
  AiEvaluationRun: {
    kind: 'personal',
    owner: { column: 'userId' },
    enforced: true,
  },
  AiEvaluationCaseResult: {
    kind: 'personal',
    owner: { through: { field: 'run', parent: 'AiEvaluationRun' } },
    enforced: true,
  },

  // ── knowledge ─────────────────────────────────────────────────────────────
  AiKnowledgeDocument: {
    kind: 'not-personal',
    because: 'Org knowledge shared through grants; uploadedBy is authorship.',
  },
  AiKnowledgeDocumentRevision: {
    kind: 'not-personal',
    because: 'History of org knowledge; actorId records who made the change.',
  },
  AiKnowledgeDocumentPendingChange: {
    kind: 'not-personal',
    because: 'A proposed change to org knowledge, reviewed by its admins; actorId is authorship.',
  },

  // ── ops ───────────────────────────────────────────────────────────────────
  AiWebhookSubscription: {
    kind: 'personal',
    owner: { column: 'createdBy' },
    // `SetNull` since t-782: an erased creator's integration keeps running.
    ownerless: 'webhookSubscription',
  },
  AiWebhookDelivery: {
    kind: 'personal',
    owner: { through: { field: 'subscription', parent: 'AiWebhookSubscription' } },
    ownerless: 'webhookDelivery',
  },
  AiAdminAuditLog: {
    kind: 'not-personal',
    because: 'Immutable audit record; userId is the actor, read by those who audit.',
  },
  AiExperiment: {
    kind: 'personal',
    owner: { column: 'createdBy' },
    ownerless: 'experiment',
  },
  AiExperimentVariant: {
    kind: 'personal',
    owner: { through: { field: 'experiment', parent: 'AiExperiment' } },
  },

  // ── providers / cost ──────────────────────────────────────────────────────
  AiCostLog: {
    kind: 'not-personal',
    because:
      'Spend record attributing usage; read as org and install aggregates by budget enforcement and the costs pages, never listed per person.',
  },
  AiProviderConfig: {
    kind: 'not-personal',
    because: 'Global config shared by every org; createdBy is authorship.',
  },
  AiProviderModel: {
    kind: 'not-personal',
    because: 'Global config shared by every org; createdBy is authorship.',
  },

  // ── workflows ─────────────────────────────────────────────────────────────
  AiWorkflow: {
    kind: 'not-personal',
    because: 'Org config shared by the org; createdBy is authorship.',
  },
  AiWorkflowVersion: {
    kind: 'not-personal',
    because: "Snapshot of org config (a workflow's history); createdBy is authorship.",
  },
  AiWorkflowSchedule: {
    kind: 'not-personal',
    because: 'Org config; createdBy is authorship.',
  },
  AiWorkflowTrigger: {
    kind: 'not-personal',
    because: 'Org config; createdBy is authorship.',
  },
  AiWorkflowExecution: {
    kind: 'personal',
    owner: { column: 'userId' },
    ownerless: 'execution',
    enforced: true,
  },
  AiWorkflowStepDispatch: {
    kind: 'not-personal',
    because:
      'Engine bookkeeping for an execution, read by the engine acting for the org; the execution itself is what is personal.',
  },
  AiWorkflowRunningStep: {
    kind: 'not-personal',
    because:
      'Engine lease bookkeeping, read by the engine and the platform live-engine view; the execution itself is what is personal.',
  },
  AiWorkflowExecutionLeaseEvent: {
    kind: 'not-personal',
    because:
      'Engine lease history, read by the engine and the platform live-engine view; the execution itself is what is personal.',
  },

  // ── mcp ───────────────────────────────────────────────────────────────────
  McpExposedPrompt: {
    kind: 'not-personal',
    because: 'Global MCP config; createdBy is authorship.',
  },
  McpApiKey: {
    kind: 'not-personal',
    because:
      'Admin-provisioned integration credential, managed by the org; createdBy is authorship.',
  },
} as const satisfies Record<string, OwnerClassification>;

export type ClassifiedModel = keyof typeof OWNER_CLASSIFICATION;

// ── fork tiers (t-807) ───────────────────────────────────────────────────────

/** One tier's classifications of its own models. */
export interface AppOwnerClassificationContribution {
  /** `'app'` for a leaf fork, `'framework'` for a framework tier. Diagnostics only. */
  tier: string;
  /** Keyed by Prisma model name, exactly as written in your tier's `.prisma` file. */
  models: Readonly<Record<string, OwnerClassification>>;
}

/** Fork-registered classifications, keyed by model. */
const appClassifications = new Map<string, OwnerClassification>();
/** Which tier registered each model, for the duplicate-across-tiers message. */
const appOwners = new Map<string, string>();

function reject(tier: string, model: string, why: string): void {
  // A malformed row leaves the model unclassified, so the coverage guard names
  // it. A collision — with core, or with another tier — keeps the first
  // classification, so the guard stays green: this log is the only signal.
  logger.error('owner-classification: app classification rejected', {
    tier,
    model,
    reason: why,
  });
}

function shapeProblem(c: OwnerClassification): string | null {
  if (c.kind === 'not-personal') {
    return typeof c.because === 'string' && c.because.trim() !== ''
      ? null
      : 'a not-personal model needs a reason in `because`';
  }
  if (c.kind !== 'personal') return "kind must be 'personal' or 'not-personal'";
  // `active-share` is the conversation-share arm: its predicate names
  // `AiConversationShare`'s own columns, so on any other model it would admit
  // rows by a rule that was never written for them.
  if ((c.alsoVisible ?? []).length > 0) return '`alsoVisible` is for core models only';
  // Likewise the ownerless kinds: each is the policy's answer for one core
  // model's orphans, so borrowing one would admit a fork's orphans by a
  // decision made about something else. Absent, nobody narrowed reads them.
  if (c.ownerless !== undefined) return '`ownerless` is for core models only';
  const owner: unknown = c.owner;
  if (typeof owner !== 'object' || owner === null) return 'a personal model needs an `owner`';
  if ('column' in owner) {
    return typeof owner.column === 'string' && owner.column !== ''
      ? null
      : '`owner.column` is empty';
  }
  if ('through' in owner) {
    const through: unknown = owner.through;
    return typeof through === 'object' &&
      through !== null &&
      'field' in through &&
      'parent' in through &&
      typeof through.field === 'string' &&
      typeof through.parent === 'string' &&
      through.field !== '' &&
      through.parent !== ''
      ? null
      : '`owner.through` needs a `field` and a `parent`';
  }
  return '`owner` must be `{ column }` or `{ through: { field, parent } }`';
}

/**
 * Classify your tier's own models for the owner layer.
 *
 * Call from `lib/app/owner-classification.ts`'s `initAppOwnerClassification()`,
 * or from a framework tier's function that it calls. Idempotent by model.
 *
 * A row is dropped with a log, never thrown, when it names a model core already
 * classifies (a fork cannot reclassify — or un-enforce — a core model), a model
 * another tier has classified (the first classification stands), or a
 * malformed shape — including `alsoVisible` or `ownerless`, whose values are
 * core's per-model rules. A malformed row leaves the model unclassified — and
 * clears the tier's earlier row rather than leaving it live — which fails the
 * coverage guard by name.
 *
 * Shape is all this checks. A row the owner layer cannot enforce — a column the
 * model lacks, an enforced child of an unenforced parent — fails the Prisma
 * client's construction, exactly as a core row would; the coverage guard
 * catches both first.
 */
export function registerAppOwnerClassification(
  contribution: AppOwnerClassificationContribution
): void {
  const { tier } = contribution;
  for (const [rawModel, c] of Object.entries(contribution.models)) {
    const model = rawModel.trim();
    if (model === '') {
      reject(tier, rawModel, 'model is empty');
      continue;
    }
    if (Object.hasOwn(OWNER_CLASSIFICATION, model)) {
      reject(tier, model, 'core already classifies this model');
      continue;
    }
    const owner = appOwners.get(model);
    if (owner !== undefined && owner !== tier) {
      reject(tier, model, `already classified by tier '${owner}'`);
      continue;
    }
    const problem = shapeProblem(c);
    if (problem !== null) {
      reject(tier, model, problem);
      appClassifications.delete(model);
      appOwners.delete(model);
      continue;
    }
    appClassifications.set(model, c);
    appOwners.set(model, tier);
  }
}

/**
 * Run the fork's classification init once, lazily, rolling a partial init
 * back — see `lib/fork-init.ts`.
 *
 * **A throwing init degrades rather than refusing.** A throw leaves every fork model
 * unclassified: unchecked by the data layer, guarded by the fork's routes as
 * before — the same state a personal model is in before it is marked
 * `enforced`. Refusing would mean failing the Prisma client, which is built
 * from `enforcedModels()`, and taking every read in the app down with it. The
 * coverage guard names the unclassified models, so a throw that happens in the
 * test environment fails the build.
 */
const appInit = createAppInitGate({
  label: 'owner-classification: initAppOwnerClassification',
  subject: 'app owner classifications',
  init: initAppOwnerClassification,
  snapshot: () => ({
    classifications: new Map(appClassifications),
    owners: new Map(appOwners),
  }),
  restore: (before) => {
    restoreMap(appClassifications, before.classifications);
    restoreMap(appOwners, before.owners);
  },
});

/** Core's classifications and every fork tier's, by model. */
export function allOwnerClassifications(): Record<string, OwnerClassification> {
  appInit.ensure();
  return {
    ...(OWNER_CLASSIFICATION as Record<string, OwnerClassification>),
    ...Object.fromEntries(appClassifications),
  };
}

/** Only the fork tiers' classifications, by model. */
export function appOwnerClassifications(): Record<string, OwnerClassification> {
  appInit.ensure();
  return Object.fromEntries(appClassifications);
}

/** Test-only: clear the fork registry and re-arm the one-shot init. */
export function __resetAppOwnerClassificationForTests(): void {
  appClassifications.clear();
  appOwners.clear();
  appInit.reset();
}

/** The classification for `model`, or `null` for a model with no owner link. */
export function ownerClassificationOf(model: string): OwnerClassification | null {
  if (Object.hasOwn(OWNER_CLASSIFICATION, model)) {
    return (OWNER_CLASSIFICATION as Record<string, OwnerClassification>)[model];
  }
  appInit.ensure();
  return appClassifications.get(model) ?? null;
}

/** Every personal model, by name — core's, then the fork tiers'. */
export function personalModels(): string[] {
  return Object.entries(allOwnerClassifications())
    .filter(([, c]) => c.kind === 'personal')
    .map(([model]) => model);
}

/** Every personal model the data layer enforces, by name — core's, then the fork tiers'. */
export function enforcedModels(): string[] {
  return Object.entries(allOwnerClassifications())
    .filter(([, c]) => c.kind === 'personal' && c.enforced === true)
    .map(([model]) => model);
}
