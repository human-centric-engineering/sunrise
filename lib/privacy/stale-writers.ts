/**
 * Stale-writer manifest (GDPR Art. 17, §122).
 *
 * Erasure scrubs a person out of rows it keeps: other people's runs, delivery
 * payloads, workflow definitions, the escalation list, subscriptions and
 * schedules ({@link SCRUBBED_COLUMNS}). Any code that writes one of those
 * columns from a copy it took earlier can put the person back. A settings tab
 * opened before the erasure and saved after it does exactly that.
 *
 * So every file that writes a scrubbed column says here how it knows its copy
 * is stale. The test `tests/unit/lib/privacy/stale-writers.test.ts` parses the
 * tree (`scripts/ci/scrubbed-column-writes.ts`), and fails on a writer that is
 * not listed and on an entry whose file no longer writes.
 *
 * That guard is the point. Writers have been found one at a time, whenever a
 * review happened to read one: the engine's in t-843, the retry-step route in
 * the write-back review. The test finds the next one at build time, including
 * a fork's.
 *
 * Each entry is one file and one model, with an anchor:
 *
 *   • `version`  — optimistic concurrency. The save carries the version it was
 *                  loaded at and is refused once the row has moved; erasure
 *                  moves it.
 *   • `row-lock` — reads and writes the row in one transaction under its row
 *                  lock, which erasure also takes, so the two are ordered.
 *   • `taken-at` — a copy held in memory leaves out the people erased since
 *                  the copy was taken: an event's time, a read's time, a
 *                  bundle's `exportedAt`, a run's start.
 *   • `intent`   — writes only what arrives in the request in hand — typed by
 *                  an admin, or sent from outside — never a copy of stored
 *                  data. Not checked, so an erased address can be re-added on
 *                  purpose.
 *   • `erasure`  — erasure itself.
 *   • `seed`     — a seed unit, run at deploy.
 *
 * Until §122 finished (t-900) there was a seventh, `pending`, for a writer not
 * converted yet. A new writer takes one of these six.
 *
 * **What the test cannot catch.** An entry is a file and a model, not a write,
 * so a new write added to a file already listed passes whatever it does: a
 * second writer in `orchestration-engine.ts` that skips the run-start check
 * would not fail it. Where a file holds writes of different kinds, its `how`
 * names them. Review a change to a listed file against its entry. The
 * scanner's own blind spots are in its header.
 *
 * **Never delete an entry to make the test pass.** Unlisting a writer hides the
 * one thing this file exists to show. Remove an entry only when its file no
 * longer writes the model, which is the case the test reports as stale.
 *
 * A fork declares its own writers with `registerStaleWriter()` from
 * `initAppErasureHooks()` in `lib/app/erasure.ts`, or from its framework tier's
 * init (`lib/privacy/erasure-hooks.ts`).
 *
 * @see .context/privacy/data-erasure.md — "Writers of scrubbed data"
 */

/** One model erasure scrubs in place, and the columns it rewrites. */
export interface ScrubbedModel {
  /** Prisma model name, exactly as written in `prisma/schema/*.prisma`. */
  model: string;
  /** Its mapped table, as raw SQL names it. */
  table: string;
  /** The columns erasure rewrites. A write to any other column cannot put a person back. */
  columns: readonly string[];
}

/**
 * Every column erasure rewrites in place, by model. Taken from the writes in
 * `run-recipients.ts`, `config-recipients.ts`, `delivery-payloads.ts` and
 * `erase-user.ts`. A column added to erasure is added here in the same change,
 * with its writers.
 */
export const SCRUBBED_COLUMNS: readonly ScrubbedModel[] = [
  {
    model: 'AiWorkflowExecution',
    table: 'ai_workflow_execution',
    columns: ['inputData', 'executionTrace', 'outputData', 'errorMessage', 'supervisorReport'],
  },
  // A run's rows in other tables (t-882).
  { model: 'AiWorkflowRunningStep', table: 'ai_workflow_running_step', columns: ['turns'] },
  { model: 'AiWorkflowStepDispatch', table: 'ai_workflow_step_dispatch', columns: ['result'] },
  {
    model: 'AiWorkflowExecutionLeaseEvent',
    table: 'ai_workflow_execution_lease_event',
    columns: ['metadata'],
  },
  {
    model: 'AiWebhookDelivery',
    table: 'ai_webhook_delivery',
    columns: ['payload', 'destination', 'destinationFingerprint', 'previousDestinations'],
  },
  { model: 'AiEventHookDelivery', table: 'ai_event_hook_delivery', columns: ['payload'] },
  { model: 'AiWorkflow', table: 'ai_workflow', columns: ['draftDefinition'] },
  { model: 'AiWorkflowVersion', table: 'ai_workflow_version', columns: ['snapshot'] },
  {
    model: 'AiOrchestrationSettings',
    table: 'ai_orchestration_settings',
    columns: ['escalationConfig'],
  },
  { model: 'AiWebhookSubscription', table: 'ai_webhook_subscription', columns: ['emailAddress'] },
  { model: 'AiWorkflowSchedule', table: 'ai_workflow_schedule', columns: ['inputTemplate'] },
];

/** How a writer knows its copy is stale. See the header. */
export type StaleWriteAnchor = 'version' | 'row-lock' | 'taken-at' | 'intent' | 'erasure' | 'seed';

interface StaleWriterBase {
  /** Repo-relative path of the file that writes. */
  file: string;
  /** Prisma model name, one of {@link SCRUBBED_COLUMNS}. */
  model: string;
  /** One or two sentences: what it writes, and how it knows. */
  how: string;
}

/** A writer and its anchor. */
export interface AnchoredStaleWriter extends StaleWriterBase {
  anchor: StaleWriteAnchor;
}

export type StaleWriter = AnchoredStaleWriter;

/** The backup importer's two contact writers share one rule (t-902). */
const IMPORTED_CONTACTS =
  "Imports email subscriptions or the escalation list. Strips anyone erased since the bundle's " +
  '`exportedAt` when this install sealed it, for this org and these addresses ' +
  "(`export-seal.ts`), else anyone ever erased; under erasure's locks (t-902).";

const RUN_ROUTES = 'app/api/v1/admin/orchestration/executions/[id]';

/** Every Sunrise file that writes a scrubbed column. Ordered by anchor, then path. */
export const STALE_WRITERS: readonly StaleWriter[] = [
  // ---------------------------------------------------------------------
  // Settled.
  // ---------------------------------------------------------------------
  {
    file: 'app/api/v1/admin/orchestration/settings/route.ts',
    model: 'AiOrchestrationSettings',
    anchor: 'version',
    how:
      'A save of the escalation list sends the version it loaded (If-Match) and is refused with ' +
      '412 once the list has moved on, checked under the row lock erasure takes ' +
      '(`config-versions.ts`, t-899). Saves of other fields never write the list.',
  },
  {
    file: 'app/api/v1/admin/orchestration/webhooks/[id]/route.ts',
    model: 'AiWebhookSubscription',
    anchor: 'version',
    how:
      'An edit sends the version it loaded (If-Match) and is refused with 412 once the ' +
      'subscription has moved on, checked under the row lock erasure takes (t-899).',
  },
  {
    file: 'app/api/v1/admin/orchestration/workflows/[id]/schedules/[scheduleId]/route.ts',
    model: 'AiWorkflowSchedule',
    anchor: 'version',
    how:
      'An edit sends the version it loaded (If-Match) and is refused with 412 once the schedule ' +
      'has moved on, checked under the row lock erasure takes (t-899).',
  },
  {
    file: 'lib/orchestration/workflows/version-service.ts',
    model: 'AiWorkflow',
    anchor: 'version',
    how:
      'Saves, publishes and discards drafts. Each carries the definition version the builder ' +
      'loaded and is refused with 412 once the draft or published version has moved on, under ' +
      "the row lock and erasure's locks for everyone it names (t-900).",
  },
  {
    file: 'lib/orchestration/workflows/version-service.ts',
    model: 'AiWorkflowVersion',
    anchor: 'version',
    how:
      'Publishes a versioned draft (above). A rollback copies a stored snapshot, not the ' +
      "browser's: it reads it again under erasure's locks and is refused if erasure changed it. " +
      "`createInitialVersion` writes a create's own definition (intent), unless it was copied " +
      'from a stored workflow (template, Duplicate, save-as-template): then it names its source ' +
      'and is refused once that moved on. Erased approver ids are stripped from all (t-900).',
  },
  {
    file: 'lib/orchestration/backup/importer.ts',
    model: 'AiWorkflowVersion',
    anchor: 'taken-at',
    how:
      "Imports workflow snapshots. Strips addresses erased since the bundle's `exportedAt` when " +
      "this install sealed it over these definitions' addresses (`export-seal.ts`), else every " +
      "erased address; and every erased approver id. Under erasure's locks (t-902, t-900).",
  },
  {
    file: 'lib/orchestration/backup/importer.ts',
    model: 'AiWebhookSubscription',
    anchor: 'taken-at',
    how: IMPORTED_CONTACTS,
  },
  {
    file: 'lib/orchestration/backup/importer.ts',
    model: 'AiOrchestrationSettings',
    anchor: 'taken-at',
    how: IMPORTED_CONTACTS,
  },
  {
    file: 'lib/orchestration/engine/orchestration-engine.ts',
    model: 'AiWorkflowExecution',
    anchor: 'taken-at',
    how:
      "A run's trace, output, error and supervisor report are written from memory with the people " +
      'erased since the run started taken out (`findErasedSinceRunStarted`, t-843, t-882). A new ' +
      "run is created from the caller's input, which it holds now.",
  },
  {
    file: 'lib/orchestration/engine/orchestration-engine.ts',
    model: 'AiWorkflowRunningStep',
    anchor: 'taken-at',
    how:
      "A multi-turn step's turns are written from the executor's memory under the run's row lock, " +
      'with the people erased since the run started taken out (t-882). Other writes of the row ' +
      '(its current step, completion) carry no turns.',
  },
  {
    file: 'lib/orchestration/engine/dispatch-cache.ts',
    model: 'AiWorkflowStepDispatch',
    anchor: 'taken-at',
    how:
      "A step's result is cached under the run's row lock with the people erased since the run " +
      'started taken out (t-882).',
  },
  {
    file: `${RUN_ROUTES}/review/route.ts`,
    model: 'AiWorkflowExecution',
    anchor: 'taken-at',
    how:
      'Writes `supervisorReport` under the run’s row lock, built from a read taken before the ' +
      'model call: anyone erased since that read is taken out (`findErasedSinceCopy`, t-901), and ' +
      'the verdict it archives is read under the lock (t-925).',
  },
  {
    file: 'lib/privacy/stale-sends.ts',
    model: 'AiEventHookDelivery',
    anchor: 'taken-at',
    how:
      'Settles a hook delivery attempt stopped for naming someone erased since its copy was ' +
      "taken: decided and written under erasure's locks, redacted payload included " +
      '(`settleStoppedDelivery`, t-926; the decision is t-886).',
  },
  {
    file: 'lib/privacy/stale-sends.ts',
    model: 'AiWebhookDelivery',
    anchor: 'taken-at',
    how:
      'Settles a webhook delivery attempt stopped for naming someone erased since its copy ' +
      "was taken, address and payload redacted, under erasure's locks " +
      '(`settleStoppedDelivery`, t-926; the decision is t-886).',
  },
  {
    file: 'lib/orchestration/hooks/registry.ts',
    model: 'AiEventHookDelivery',
    anchor: 'taken-at',
    how:
      'Each attempt, first or retry, holds erasure’s locks for the people its payload names ' +
      'and leaves out anyone erased since the event (or the retry’s read) before it posts: ' +
      'stopped and redacted, or posted without an admin who acted (`stale-sends.ts`, t-886).',
  },
  {
    file: 'lib/orchestration/webhooks/dispatcher.ts',
    model: 'AiWebhookDelivery',
    anchor: 'taken-at',
    how:
      'Each attempt, first or retry, holds erasure’s locks for its email address and the ' +
      'people its payload names, and leaves out anyone erased since the subscriptions were ' +
      'read before it sends: stopped with the address and payload redacted (`stale-sends.ts`, ' +
      't-886).',
  },
  {
    file: 'lib/orchestration/approval-actions.ts',
    model: 'AiWorkflowExecution',
    anchor: 'row-lock',
    how:
      "Approve and reject read the run and write its trace back in one transaction under the run's " +
      'row lock (`withRunRowLocked`, t-901).',
  },
  {
    file: 'lib/orchestration/retry-step.ts',
    model: 'AiWorkflowExecution',
    anchor: 'row-lock',
    how:
      "Reads the run and writes its trace, cut back to the retried step, in one transaction under the run's " +
      'row lock (`withRunRowLocked`, t-901).',
  },
  {
    file: `${RUN_ROUTES}/cancel/route.ts`,
    model: 'AiWorkflowExecution',
    anchor: 'row-lock',
    how:
      "One UPDATE, which holds the row while it writes, of a fixed message ('Cancelled by user'): " +
      'nothing it read is written back (t-901).',
  },
  {
    file: `${RUN_ROUTES}/force-fail/route.ts`,
    model: 'AiWorkflowExecution',
    anchor: 'intent',
    how:
      'One UPDATE of a fixed message and the reason the admin typed in this request; nothing it read ' +
      'is written back (t-901).',
  },
  {
    file: 'lib/orchestration/engine/lease.ts',
    model: 'AiWorkflowExecutionLeaseEvent',
    anchor: 'intent',
    how:
      'Inserts lease events. The only person one names is the admin force-failing the run in the ' +
      'request in hand (`actorUserId`); nothing stored is copied in (t-882). Written after the ' +
      'response without the run lock, so one landing as that admin is erased can outlast the ' +
      "erasure's passes (documented as not reached).",
  },
  {
    file: 'lib/orchestration/engine/execution-reaper.ts',
    model: 'AiWorkflowExecution',
    anchor: 'row-lock',
    how:
      'One UPDATE per batch, which holds the rows while it writes, of a fixed sentinel message: ' +
      'nothing it read is written back (t-901).',
  },
  {
    file: 'lib/orchestration/scheduling/scheduler.ts',
    model: 'AiWorkflowExecution',
    anchor: 'taken-at',
    how:
      "Creates runs from a schedule's template with anyone erased since the tick read it blanked, " +
      "under erasure's locks. Repair writes are fixed messages, or the engine's error under the row " +
      'lock with anyone erased since the run started taken out (t-901).',
  },
  {
    file: 'app/api/v1/inbound/[channel]/[slug]/route.ts',
    model: 'AiWorkflowExecution',
    anchor: 'intent',
    how: 'Creates a run from the inbound message in the request. Nothing stored is copied.',
  },
  {
    file: 'app/api/v1/webhooks/trigger/[slug]/route.ts',
    model: 'AiWorkflowExecution',
    anchor: 'intent',
    how: 'Creates a run from the request body. Nothing stored is copied.',
  },
  {
    file: 'app/api/v1/admin/orchestration/webhooks/route.ts',
    model: 'AiWebhookSubscription',
    anchor: 'intent',
    how: 'Creates a subscription from the request. Nothing stored is copied (t-899).',
  },
  {
    file: 'app/api/v1/admin/orchestration/workflows/[id]/schedules/route.ts',
    model: 'AiWorkflowSchedule',
    anchor: 'intent',
    how: 'Creates a schedule from the request. Nothing stored is copied (t-899).',
  },
  {
    file: 'app/api/v1/admin/orchestration/workflows/[id]/route.ts',
    model: 'AiWorkflow',
    anchor: 'intent',
    how:
      "Writes only the request's name, slug, toggles and cost cap (`data: fields`, which the " +
      'scanner cannot read), none of which erasure scrubs. Draft saves and clears go through ' +
      '`saveDraft` and `discardDraft` in `version-service`, checked by version (t-900).',
  },
  {
    file: 'lib/privacy/config-recipients.ts',
    model: 'AiOrchestrationSettings',
    anchor: 'erasure',
    how: 'Removes the person from the escalation list, under the row lock it reads with.',
  },
  {
    file: 'lib/privacy/config-recipients.ts',
    model: 'AiWorkflow',
    anchor: 'erasure',
    how: 'Removes the person from workflow drafts, under the row lock it reads with.',
  },
  {
    file: 'lib/privacy/config-recipients.ts',
    model: 'AiWorkflowVersion',
    anchor: 'erasure',
    how: 'Removes the person from published snapshots, under the row lock it reads with.',
  },
  {
    file: 'lib/privacy/delivery-payloads.ts',
    model: 'AiWebhookDelivery',
    anchor: 'erasure',
    how: 'Redacts the person from delivery payloads, one locked statement per pass.',
  },
  {
    file: 'lib/privacy/delivery-payloads.ts',
    model: 'AiEventHookDelivery',
    anchor: 'erasure',
    how: 'Redacts the person from delivery payloads, one locked statement per pass.',
  },
  {
    file: 'lib/privacy/erase-user.ts',
    model: 'AiWebhookSubscription',
    anchor: 'erasure',
    how: "Clears the person's address from email subscriptions, in the erasure transaction.",
  },
  {
    file: 'lib/privacy/erase-user.ts',
    model: 'AiWebhookDelivery',
    anchor: 'erasure',
    how: "Replaces the person's address on deliveries sent to it, in the erasure transaction.",
  },
  {
    file: 'lib/privacy/run-recipients.ts',
    model: 'AiWorkflowExecution',
    anchor: 'erasure',
    how: "Redacts the person from other people's runs, each under its row lock.",
  },
  {
    file: 'lib/privacy/run-recipients.ts',
    model: 'AiWorkflowRunningStep',
    anchor: 'erasure',
    how: "Redacts the person from a run's step turns, under the run's row lock (t-882).",
  },
  {
    file: 'lib/privacy/run-recipients.ts',
    model: 'AiWorkflowStepDispatch',
    anchor: 'erasure',
    how: "Redacts the person from a run's cached step results, under the run's row lock (t-882).",
  },
  {
    file: 'lib/privacy/run-recipients.ts',
    model: 'AiWorkflowExecutionLeaseEvent',
    anchor: 'erasure',
    how: "Redacts the person from a run's lease events, under the run's row lock (t-882).",
  },
  {
    file: 'lib/privacy/run-recipients.ts',
    model: 'AiWorkflowSchedule',
    anchor: 'erasure',
    how: "Blanks the person's address in schedule input templates, under the row lock it reads with.",
  },
  {
    file: 'prisma/seeds/010-model-auditor.ts',
    model: 'AiWorkflowVersion',
    anchor: 'seed',
    how: "Publishes the built-in model-audit workflow's snapshot from code. It names no person.",
  },
  {
    file: 'prisma/seeds/022-delivery-destinations.ts',
    model: 'AiWebhookDelivery',
    anchor: 'seed',
    how:
      "One-off backfill of NULL destinations from each delivery's current subscription. It does " +
      'not order itself against an erasure running in the same seconds; it runs once, at deploy.',
  },
  {
    file: 'prisma/seeds/022-delivery-destinations.ts',
    model: 'AiEventHookDelivery',
    anchor: 'seed',
    how:
      "One-off backfill of NULL destinations from each delivery's current hook. Hook " +
      'destinations are URLs, which erasure does not scrub; the payload is not written.',
  },
];
