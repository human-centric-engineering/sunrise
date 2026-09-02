/**
 * Guard: every `logCost` call site attributes to a real row, or says why not.
 *
 * `AiCostLog.agentId`, `AiCostLog.conversationId`, `workflowExecutionId` and
 * `userId` are all **foreign keys**. `logCost` catches the P2003 a bad value
 * raises and returns `null`, and every caller `void`s the promise — so a wrong
 * value is not an error anyone sees. It is a cost row that quietly never
 * existed, on spend that quietly did.
 *
 * That has now happened three times, and was caught a fourth time before it
 * shipped:
 *
 *   - #599 — the capability dispatcher wrote the synthetic `workflow:<id>`
 *     label into `agentId`. Every capability a workflow ran recorded nothing.
 *   - #600 — `send_message_to_channel` writes its **own** cost row and had the
 *     same bug, which the dispatcher's fix could not reach. Found by
 *     enumerating the call sites, not by anyone reporting it.
 *   - #654 — the conversation summariser passed the literals `'system'` and
 *     `'summary'`. Both FKs violated, on a call made on every turn of every
 *     long conversation.
 *   - t-655 — adding `userId` wired `request.userId` into the new FK at every
 *     chat call site. That handler serves the embed route too, which passes a
 *     synthetic `embed_<hash>` visitor id: not a `User`, so the row would be
 *     discarded on write. Caught by extending this roster to the new column
 *     rather than by anyone reading the diff — the argument for adding a field
 *     here the moment the column exists, not after the first incident on it.
 *
 *     Be precise about the blast radius, because it is smaller than it looks
 *     and overstating it is how a guard gets trusted for the wrong reason: no
 *     embed turn reaches `logCost` today at all. `AiConversation.userId` is
 *     also a FK to `user`, nothing mints a `User` for a visitor, so a
 *     visitor's first message already dies at conversation-create (see #705).
 *     This guard is therefore correct and forward-looking rather than
 *     currently load-bearing — it stops the cost-row loss from appearing the
 *     moment #705 is fixed, which is exactly when nobody would be looking.
 *
 * ## Why this is a roster and not a pattern match
 *
 * The obvious guard is "no string literal in `agentId`". It would have caught
 * #654 and **neither of the other two** — those passed `context.agentId`, a
 * perfectly ordinary expression that happens to hold a workflow label on some
 * paths. Whether an expression is a row id is not decidable from its syntax.
 *
 * So the mechanical rule below is kept (it is real, and free), and the actual
 * guard is a **derived roster compared by set equality**: every `logCost` call
 * in the tree, with what it passes for each FK, against a written allowlist.
 * A new call site fails until someone adds it and states why its value is a row
 * id. Changing what an existing site passes — dropping the `isWorkflowAgentId`
 * guard, say — changes its key and fails too. The check cannot be satisfied by
 * being quiet, which is the property the three bugs above all exploited.
 *
 * Same shape as `tests/unit/sunrise-version-disclosure.test.ts`, and in
 * `ALWAYS_RUN_TESTS` for the same reason: the change it exists to catch is a
 * NEW call site in a file no import chain connects to this test.
 *
 * ## What this does NOT cover
 *
 * It reads **`logCost` call sites**. A value can also reach a foreign key one
 * hop away, through a function that accepts an attribution and forwards it —
 * `embedText`/`embedBatch` take an `EmbeddingAttribution`, and their callers
 * decide what goes in it. This guard cannot see those callers, and it was
 * measured: deleting the `isWorkflowAgentId` check in
 * `search-knowledge.ts` — reintroducing #600 exactly — leaves every assertion
 * here green.
 *
 * Each forwarding hop therefore needs its own behavioural test, and has one:
 *   - `tests/unit/lib/orchestration/capabilities/built-in/search-knowledge.test.ts`
 *   - `tests/unit/lib/orchestration/engine/executors/rag-retrieve.test.ts`
 *   - `tests/unit/lib/orchestration/knowledge/embedder-cost-attribution.test.ts`
 *
 * Write that down rather than letting the roster read as broader than it is: a
 * guard believed to cover a class it does not is worse than no guard, because
 * it stops anyone looking.
 *
 * @see lib/orchestration/llm/cost-tracker.ts — `logCost`
 * @see .context/orchestration/capabilities.md — the operator-facing roster
 */

import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import ts from 'typescript';

const REPO_ROOT = process.cwd();

/** Not source. `tests` is excluded — a test may pass whatever it likes. */
const NOT_SOURCE = new Set(['node_modules', '.next', '.git', 'coverage', 'tests', '.claude']);

/** The columns that are foreign keys. `agentId` and `conversationId` are where
 *  the three bugs happened. `workflowExecutionId` has never held a non-id — the
 *  execution row always exists before any step runs — and `userId` is new, but
 *  both are checked anyway: adding a field here costs nothing, and the argument
 *  for excluding one is exactly the argument that was wrong twice.
 *
 *  `userId` earns its place on the same mechanism, not on a track record.
 *  `logCost` normalises a falsy value away, so `null`/`''` is a safe NULL — but
 *  a non-empty value that is not a `User.id` (an agent id, a `workflow:<id>`
 *  label, a visitor id from an embed session) raises P2003 and discards the
 *  whole row, silently, exactly as #599/#600/#654 did. */
const FK_FIELDS = ['agentId', 'conversationId', 'workflowExecutionId', 'userId'] as const;
type FkField = (typeof FK_FIELDS)[number];

interface FkValue {
  /** Source text of what is assigned, whitespace-normalised. */
  expr: string;
  /** True when it arrives via a spread — the guarded-conditional shape. */
  viaSpread: boolean;
  /** True when it is a bare string, which can never be a row id. */
  literal: boolean;
}

interface CallSite {
  file: string;
  line: number;
  values: Record<FkField, FkValue[]>;
}

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (NOT_SOURCE.has(entry) || entry.startsWith('.')) continue;
    const full = join(dir, entry);
    let stat;
    try {
      stat = statSync(full);
    } catch {
      continue;
    }
    if (stat.isDirectory()) out.push(...walk(full));
    else if (full.endsWith('.ts') || full.endsWith('.tsx')) out.push(full);
  }
  return out;
}

const norm = (s: string): string => s.replace(/\s+/g, ' ').trim();

const isFk = (name: string): name is FkField => (FK_FIELDS as readonly string[]).includes(name);

/** An empty bucket per FK column. Written out rather than derived from
 *  `FK_FIELDS` so the type is the real `Record`, not a widened index signature. */
const emptyValues = (): Record<FkField, FkValue[]> => ({
  agentId: [],
  conversationId: [],
  workflowExecutionId: [],
  userId: [],
});

/** A bare string, or a template with nothing interpolated into it. */
const isLiteralNode = (node: ts.Node): boolean =>
  ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node);

/**
 * Pull the FK assignments out of one object literal.
 *
 * Recurses through spreads, because the guarded shape this repo settled on —
 * `...(isRealAgent ? { agentId } : {})` — hides the assignment one level down.
 * A spread carrying **no** object literal at all (`...params`) cannot be read
 * statically; it is recorded as opaque rather than skipped, so the site still
 * has to be justified in the allowlist by a human who looked.
 */
function collectFks(
  obj: ts.ObjectLiteralExpression,
  src: ts.SourceFile,
  into: Record<FkField, FkValue[]>,
  spreadText: string | null
): void {
  for (const prop of obj.properties) {
    if (ts.isPropertyAssignment(prop) && ts.isIdentifier(prop.name) && isFk(prop.name.text)) {
      into[prop.name.text].push({
        expr: spreadText ?? norm(prop.initializer.getText(src)),
        viaSpread: spreadText !== null,
        literal: isLiteralNode(prop.initializer),
      });
    } else if (ts.isShorthandPropertyAssignment(prop) && isFk(prop.name.text)) {
      into[prop.name.text].push({
        expr: spreadText ?? prop.name.text,
        viaSpread: spreadText !== null,
        literal: false,
      });
    } else if (ts.isSpreadAssignment(prop)) {
      const text = norm(prop.expression.getText(src));
      let sawObjectLiteral = false;
      const visit = (node: ts.Node): void => {
        if (ts.isObjectLiteralExpression(node)) {
          sawObjectLiteral = true;
          collectFks(node, src, into, `spread(${text})`);
          return;
        }
        ts.forEachChild(node, visit);
      };
      visit(prop.expression);
      if (!sawObjectLiteral) {
        for (const field of FK_FIELDS) {
          into[field].push({ expr: `opaque-spread(${text})`, viaSpread: true, literal: false });
        }
      }
    }
  }
}

/** Every `logCost(...)` in the source tree, with what it writes into each FK. */
function findCallSites(): CallSite[] {
  const sites: CallSite[] = [];
  for (const file of walk(REPO_ROOT)) {
    const text = readFileSync(file, 'utf8');
    // Cheap pre-filter: parsing every .ts in the repo would dominate the runtime.
    if (!text.includes('logCost')) continue;
    const src = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const rel = relative(REPO_ROOT, file).split(sep).join('/');
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node)) {
        const callee = node.expression;
        const name = ts.isIdentifier(callee)
          ? callee.text
          : ts.isPropertyAccessExpression(callee)
            ? callee.name.text
            : '';
        if (name === 'logCost') {
          const values = emptyValues();
          const arg = node.arguments[0];
          if (arg && ts.isObjectLiteralExpression(arg)) {
            collectFks(arg, src, values, null);
          } else {
            // Not an object literal — a pre-built params object, or no argument
            // at all. Unreadable here, so it is recorded as such and has to be
            // justified rather than passing by default.
            const opaque = `opaque-argument(${arg ? norm(arg.getText(src)) : 'none'})`;
            for (const field of FK_FIELDS) {
              values[field].push({ expr: opaque, viaSpread: false, literal: false });
            }
          }
          sites.push({
            file: rel,
            line: src.getLineAndCharacterOfPosition(node.getStart(src)).line + 1,
            values,
          });
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(src);
  }
  return sites;
}

/** The roster key: the file, and what it writes into each FK. Line-independent. */
function key(site: CallSite): string {
  const render = (field: FkField): string => {
    const vals = site.values[field];
    return vals.length === 0 ? '—' : vals.map((v) => v.expr).join(' + ');
  };
  return (
    `${site.file} | agentId=${render('agentId')} | conversationId=${render('conversationId')}` +
    ` | workflowExecutionId=${render('workflowExecutionId')} | userId=${render('userId')}`
  );
}

/**
 * Every `logCost` call site in the tree, and what it attributes to.
 *
 * ADDING AN ENTRY IS THE POINT. If this test fails with an unexpected key, do
 * not paste the key in to make it green — read the call site and answer the
 * question the three bugs above all got wrong: *can the value in `agentId` ever
 * be something that is not a row in `AiAgent`?* A synthetic `workflow:<id>`
 * label can. A literal can. `context.agentId` from a capability can, which is
 * why the two capability entries carry a guard in their key.
 *
 * `—` means the column is not written at all, which is always safe: it is
 * nullable, and the row is attributed by `workflowExecutionId` or by nothing.
 */
const ALLOWED_CALL_SITES: readonly string[] = [
  // Admin transcription: `agent` is the row the route just loaded, and
  // `withAdminAuth` guarantees `session.user` is a real User row.
  'app/api/v1/admin/orchestration/chat/transcribe/route.ts | agentId=agent.id | conversationId=— | workflowExecutionId=— | userId=session.user.id',
  // Retroactive supervisor review: attributed to the execution, not an agent.
  // Same `withAdminAuth` guarantee for the user.
  'app/api/v1/admin/orchestration/executions/[id]/review/route.ts | agentId=— | conversationId=— | workflowExecutionId=id | userId=session.user.id',
  // Embed speech-to-text: `agent` is the row resolved from the embed token.
  // `userId` is deliberately unwritten — an embed caller has no User row at
  // all, only the synthetic `embed_<hash>` visitor id.
  'app/api/v1/embed/speech-to-text/route.ts | agentId=agent.id | conversationId=— | workflowExecutionId=— | userId=—',
  // #600. The agentId guard is load-bearing: dispatched from a workflow
  // `tool_call` step, `context.agentId` is the synthetic `workflow:<id>` label.
  // The userId guard is load-bearing for the mirror-image reason: dispatched
  // from an EMBED chat turn, `context.userId` is the synthetic `embed_<hash>`
  // visitor id, because the chat handler passes `request.userId` straight into
  // the dispatch context.
  'lib/orchestration/capabilities/built-in/send-message-to-channel.ts | agentId=spread((context.agentId && !isWorkflowAgentId(context.agentId) ? { agentId: context.agentId } : {})) | conversationId=conv.id | workflowExecutionId=spread((context.workflowExecutionId ? { workflowExecutionId: context.workflowExecutionId } : {})) | userId=spread((context.userId && !isEmbedUserId(context.userId) ? { userId: context.userId } : {}))',
  // #599. Same two guards, same two reasons — this is where the agentId one
  // was first needed.
  'lib/orchestration/capabilities/dispatcher.ts | agentId=spread((context.agentId && !isWorkflowAgentId(context.agentId) ? { agentId: context.agentId } : {})) | conversationId=spread((context.conversationId ? { conversationId: context.conversationId } : {})) | workflowExecutionId=spread((context.workflowExecutionId ? { workflowExecutionId: context.workflowExecutionId } : {})) | userId=spread((context.userId && !isEmbedUserId(context.userId) ? { userId: context.userId } : {}))',
  // The chat handler's four rows — turn cost, vision, transcription, tool
  // side-effects. `agent` and `conversation` are both rows it loaded itself.
  // `attributableUserId` is load-bearing: this one handler serves the admin,
  // consumer AND embed routes, and only the first two pass a real `User.id`.
  'lib/orchestration/chat/streaming-handler.ts | agentId=agent.id | conversationId=conversation.id | workflowExecutionId=— | userId=attributableUserId(request.userId)',
  // #654. All three supplied by the chat handler, which is the only caller
  // that holds real ids; omitted entirely rather than faked when it does not.
  // The handler has already reduced an embed visitor to null before this.
  'lib/orchestration/chat/summarizer.ts | agentId=spread((options.agentId ? { agentId: options.agentId } : {})) | conversationId=spread((options.conversationId ? { conversationId: options.conversationId } : {})) | workflowExecutionId=— | userId=spread((options.userId ? { userId: options.userId } : {}))',
  // `agent` is a real row: the executor resolves it before dispatching, and
  // non-null-asserts because that resolution already threw if it failed.
  // `ctx.userId` needs no guard here or in the two entries below: the engine
  // writes that same value to `AiWorkflowExecution.userId`, itself a FK to
  // `user`, so a synthetic id would already be failing execution creation.
  'lib/orchestration/engine/executors/agent-call.ts | agentId=agent!.id | conversationId=— | workflowExecutionId=ctx.executionId | userId=ctx.userId',
  // `chat_turn` runs a real agent against a real conversation it created.
  'lib/orchestration/engine/executors/chat-turn.ts | agentId=agent.id | conversationId=conversationId | workflowExecutionId=ctx.executionId | userId=ctx.userId',
  // The workflow LLM runner attributes to the execution; no agent is involved.
  'lib/orchestration/engine/llm-runner.ts | agentId=— | conversationId=— | workflowExecutionId=ctx.executionId | userId=ctx.userId',
  // Opaque by construction: builds `costParams` first and sets `agentId` only
  // when `session.agentId` is non-null — which is an `AiAgent.id` on
  // `AiEvaluationSession`. `userId` is `params.userId`, the session owner the
  // route already used to prove ownership. Read at the source, not inferred
  // from this key.
  'lib/orchestration/evaluations/complete-session.ts | agentId=opaque-argument(costParams) | conversationId=opaque-argument(costParams) | workflowExecutionId=opaque-argument(costParams) | userId=opaque-argument(costParams)',
  // `AiEvaluationRun.agentId` is an `AiAgent` FK, nullable because a run's
  // subject can be a workflow instead — hence the guard. `run.userId` needs
  // none: it is NOT NULL on `AiEvaluationRun` and a FK to `user` already.
  'lib/orchestration/evaluations/run-worker.ts | agentId=spread((run.agentId ? { agentId: run.agentId } : {})) | conversationId=— | workflowExecutionId=— | userId=run.userId',
  // #654 part 3. Both embedder rows now take whatever the caller could supply.
  // The guards are load-bearing for the same reason as the capability entries:
  // `search_knowledge_base` dispatched from a workflow step holds a
  // `workflow:<id>` label in `context.agentId`, and passes it only when it is
  // not one. Ingestion callers supply metadata alone — there is no agent or
  // conversation behind a document upload — which is recorded in
  // `.context/orchestration/capabilities.md`. No user either: ingestion is not
  // a person's request, so `userId` is unwritten.
  'lib/orchestration/knowledge/embedder.ts | agentId=spread((attribution?.agentId ? { agentId: attribution.agentId } : {})) | conversationId=spread((attribution?.conversationId ? { conversationId: attribution.conversationId } : {})) | workflowExecutionId=spread((attribution?.workflowExecutionId ? { workflowExecutionId: attribution.workflowExecutionId } : {})) | userId=—',
  // Keyword enrichment runs post-upload against a document, with no agent,
  // conversation or user in scope. Deliberate — see the doc note above.
  'lib/orchestration/knowledge/keyword-enricher.ts | agentId=— | conversationId=— | workflowExecutionId=— | userId=—',
];

describe('AiCostLog foreign-key attribution', () => {
  const sites = findCallSites();

  // ── The scan can report ────────────────────────────────────────────────

  it('extracts FK assignments from every shape this repo uses', () => {
    // A guard whose only evidence is "it printed nothing" is worth nothing.
    // This runs the extractor over source that is known-bad in each of the four
    // shapes the real call sites use, and checks it sees all four — so a green
    // run below means "looked and found nothing", not "could not look".
    const probe = `
      logCost({ agentId: 'system', conversationId: 'summary' });
      logCost({ agentId: real.id });
      logCost({ ...(cond ? { agentId: ctx.agentId } : {}) });
      logCost(prebuilt);
    `;
    const src = ts.createSourceFile('probe.ts', probe, ts.ScriptTarget.Latest, true);
    const found: CallSite[] = [];
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && node.expression.getText(src) === 'logCost') {
        const values = emptyValues();
        const arg = node.arguments[0];
        if (arg && ts.isObjectLiteralExpression(arg)) collectFks(arg, src, values, null);
        else values.agentId.push({ expr: 'opaque-argument', viaSpread: false, literal: false });
        found.push({ file: 'probe.ts', line: 0, values });
      }
      ts.forEachChild(node, visit);
    };
    visit(src);

    expect(found).toHaveLength(4);
    expect(found[0].values.agentId[0]).toMatchObject({ expr: "'system'", literal: true });
    expect(found[0].values.conversationId[0]).toMatchObject({ expr: "'summary'", literal: true });
    expect(found[1].values.agentId[0]).toMatchObject({ expr: 'real.id', literal: false });
    expect(found[2].values.agentId[0]).toMatchObject({ viaSpread: true, literal: false });
    expect(found[3].values.agentId[0].expr).toBe('opaque-argument');
  });

  it('finds the call sites it is supposed to be looking at', () => {
    // If the walk resolved to the wrong root, or the pre-filter stopped
    // matching, every assertion below would pass on an empty set.
    expect(sites.length).toBeGreaterThanOrEqual(15);
    expect(sites.map((s) => s.file)).toContain('lib/orchestration/chat/summarizer.ts');
    expect(sites.map((s) => s.file)).toContain('lib/orchestration/capabilities/dispatcher.ts');
  });

  // ── The mechanical rule ────────────────────────────────────────────────

  it('never writes a bare string into a foreign-key column', () => {
    // The #654 shape. Free to check and unambiguous: a literal is never a cuid.
    const literals = sites.flatMap((site) =>
      FK_FIELDS.flatMap((field) =>
        site.values[field]
          .filter((v) => v.literal)
          .map((v) => `${site.file}:${site.line} — ${field}: ${v.expr}`)
      )
    );

    expect(literals).toEqual([]);
  });

  // ── The roster ─────────────────────────────────────────────────────────

  it('matches the written allowlist exactly', () => {
    // Set equality in both directions. New site → appears here unexplained.
    // Site changed → its key moves. Site deleted → a stale entry is left over,
    // which is worth knowing too: the allowlist is documentation, and a claim
    // about code that no longer exists is the kind that survives longest.
    const derived = [...new Set(sites.map(key))].sort();
    expect(derived).toEqual([...ALLOWED_CALL_SITES].sort());
  });
});
