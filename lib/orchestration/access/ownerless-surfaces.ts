/**
 * Which files may read a row nobody owns without asking — derived, not typed.
 *
 * Reads of `AiWorkflowExecution`, `AiConversation` and `AiMessage` are supposed
 * to go through the helpers beside this file, because that is where "this row
 * is owned by nobody; may this caller read it?" is answered and where the
 * authorization policy gets its vote. **Nothing checked that they did.** A
 * handler querying the table directly with `where: { userId: session.user.id }`
 * reads as obviously correct, passes review, and silently does two wrong things:
 * rows nobody owns match nobody and disappear, and the deployment's policy never
 * gets asked.
 *
 * Three instances were found by chance, each by a reviewer looking one directory
 * sideways, and three coverage claims — "every execution read surface is behind
 * the helper", "the SQL is pinned against the fragment", "a narrowing fork keeps
 * one tenant's admins out of another's messages" — were written from the set of
 * files the author happened to read, and each was wrong. A hand-derived
 * coverage list is exactly as reliable as the afternoon spent making it.
 *
 * So this derives it. {@link findUndeclaredOwnerlessReads} takes every source
 * file, finds the ones that touch one of the three models — a Prisma accessor
 * on any receiver, or the table in raw SQL — and asks one question of each:
 * does it import the access helper for that model? If not, is it in
 * {@link OWNERLESS_SURFACE_EXCEPTIONS} with a written reason? Neither → a
 * violation naming the file. `tests/unit/lib/orchestration/access/ownerless-surfaces.test.ts`
 * runs it over the real tree on every scoped run, and over synthetic files to
 * prove it can go red.
 *
 * The precedent is `tests/unit/lib/privacy/export-sources.test.ts`, whose header
 * argues it better than this one can: *an export that omits a table looks
 * exactly like a complete answer to the person reading it.* Substitute "a list
 * that omits the rows nobody owns" and it transfers unchanged.
 *
 * ## What the exception list is, and is not
 *
 * Two dispositions, and the difference is the point:
 *
 * - **`'by-design'`** — the file has no caller to scope to (the engine, the
 *   reaper, a webhook receiver), or it scopes by a road the helper does not
 *   offer (a consumer route keyed on `session.user.id`, a pgvector query in raw
 *   SQL pinned against the fragment). The intended end state.
 * - **`'known-gap'`** — it should go through the helper and does not yet.
 *   `tracking` names where the fix lives, and the entry leaves with the fix:
 *   an entry for a file that has started importing the helper is reported as
 *   stale, so a fixed gap cannot linger on the list.
 *
 * Every entry carries a reason the checker enforces as non-trivial — at least
 * 20 characters, the same floor `lib/app/ci.ts`'s other lists use — because a
 * list of bare paths is the failure mode this module exists to prevent,
 * arriving as its own deliverable. The list lives here, beside the helpers it
 * carves out of, so a reader of the rule meets the exceptions with it.
 *
 * ## The floor, not a proof
 *
 * A file that imports the helper and also runs an unscoped query beside it
 * passes. The second rule below narrows that a little — an import nothing in
 * the file uses is reported, and a type-only import counts for nothing, so the
 * check cannot be silenced with one line — but it cannot tell a helper applied
 * to one query from a helper applied to all of them. **Nor does it see a read
 * through a relation**: `prisma.aiWorkflow.findMany({ include: { executions:
 * true } })`, an agent's `conversations`, a conversation's `messages` — the row
 * arrives without its model being named. Today every such read outside a
 * `_count` is in a file already on the roster, and that is a fact about the
 * tree, not a property of the check. Treat a clean run as "every file that
 * names these tables either imports the helper or has said why not", never as
 * "every query is scoped".
 *
 * Row-level security (§107) answers the *between-tenant* axis: a query that
 * forgets its `where` returns zero rows wherever it was written. It does not
 * answer this one — an ownerless row inside a single tenant is invisible to
 * RLS — so the two are complements.
 *
 * ## Forks
 *
 * The roster is read from `app/`, `lib/` and `components/`, so a fork's own
 * files are in it. **A fork file failing this the first time it lands is the
 * check working.** Import the helper if the read is an admin surface; otherwise
 * declare it in `appOwnerlessSurfaceExceptions` (`lib/app/ci.ts`), which is
 * spread into the core list below and validated the same way. No platform file
 * needs editing.
 *
 * @see lib/app/ci.ts — the fork tail and its documented shape
 * @see .context/auth/authorization.md — the seam; "what is not behind it yet"
 * @see lib/auth/orphan-reads.ts — the question these helpers answer
 */

import type { AppOwnerlessSurfaceException } from '@/lib/app/ci';
import { appOwnerlessSurfaceExceptions } from '@/lib/app/ci';

/** One entry on the roster — the fork tail's type is the contract, so it is reused. */
export type OwnerlessSurfaceException = AppOwnerlessSurfaceException;

/** The three models, and the helper module whose import satisfies a read of each. */
export const OWNERLESS_MODELS = {
  aiWorkflowExecution: 'execution-access',
  aiConversation: 'conversation-access',
  aiMessage: 'conversation-access',
} as const;

export type OwnerlessModel = keyof typeof OWNERLESS_MODELS;

/** Reasons must be at least this long — the floor `scripts/ci/scoped-tests.ts` applies to always-run entries. */
export const MIN_REASON_LENGTH = 20;

/**
 * The core exceptions: every file in this tree that reads one of the three
 * models outside the helpers, classified.
 *
 * Grouped by why, not by model. The first pass over the tree (t-692,
 * 2026-09-15) measured 54 files touching the three models: 23 through the
 * helpers, **31 outside them — 29 by design and 2 known gaps.** That ratio is
 * what argues the list stays short and the check is worth having. The numbers
 * are history; the roster test is the current answer.
 */
export const OWNERLESS_SURFACE_EXCEPTIONS: readonly OwnerlessSurfaceException[] = [
  // ── Known gaps — the check exists because these were found by chance ──────
  {
    path: 'app/api/v1/admin/orchestration/approvals/history/route.ts',
    disposition: 'known-gap',
    tracking: '#773',
    reason:
      'hard-codes `userId: session.user.id`, so every approval decision on a scheduled ' +
      'or inbound run is missing from approval history on every install — including ' +
      "the caller's own decisions. Found one directory sideways during #774.",
  },
  {
    path: 'lib/orchestration/analytics/analytics-service.ts',
    disposition: 'known-gap',
    tracking: 't-694',
    reason:
      'reads `AiMessage.content` and `AiConversation` with no owner clause and no ' +
      'policy; `/analytics/unanswered` returns a member of the public’s question ' +
      'verbatim to an admin a narrowing policy refuses the thread itself.',
  },

  // ── Admin surfaces that scope by a road the helper does not offer ─────────
  {
    path: 'app/api/v1/admin/orchestration/conversations/search/route.ts',
    disposition: 'by-design',
    reason:
      'a pgvector cosine-distance query, not expressible through Prisma’s builder, so ' +
      'the three arms are hand-written in SQL and pinned against ' +
      '`conversationVisibilityWhere` in `conversations/policy-narrowing.test.ts`.',
  },
  {
    path: 'app/api/v1/admin/orchestration/conversations/clear/route.ts',
    disposition: 'by-design',
    reason:
      'a bulk `deleteMany` wider than any per-id rule by design; its one policy-decided ' +
      'arm reads `session.unattributedReads.conversation` directly rather than through ' +
      'the helper, which has no fragment for a write (t-691).',
  },
  {
    path: 'app/api/v1/admin/orchestration/conversations/export/route.ts',
    disposition: 'by-design',
    reason:
      'hard-scoped to `userId: session.user.id` on purpose — bulk-downloading other ' +
      'people’s message bodies under one audit row is a privacy footgun, so it sees ' +
      'neither shared nor ownerless threads and has nothing to ask the helper.',
  },
  {
    path: 'app/api/v1/admin/orchestration/agents/compare/route.ts',
    disposition: 'by-design',
    reason:
      'one `aiConversation.count({ agentId })` among five per-agent aggregates, no row ' +
      'content; its own header defers narrowing all four owner-bearing aggregates to ' +
      'the customer tier together (§106), and a count is not a read surface for a thread.',
  },

  // ── Consumer routes, self-scoped by construction ──────────────────────────
  //
  // Every one fetches by `{ …, userId: session.user.id }` and declares
  // `ownership: { decidedBy: 'self' }` to the guard. A consumer never reaches an
  // ownerless row — an inbound thread has no account to be the consumer of —
  // so there is no third case for the helper to decide.
  {
    path: 'app/api/v1/chat/conversations/route.ts',
    disposition: 'by-design',
    reason:
      'consumer list keyed on `userId: session.user.id` and declared `ownership: self`; ' +
      'a consumer has no ownerless rows to be admitted to.',
  },
  {
    path: 'app/api/v1/chat/conversations/search/route.ts',
    disposition: 'by-design',
    reason:
      'consumer search keyed on `userId: session.user.id` and declared `ownership: self`; ' +
      'a consumer has no ownerless rows to be admitted to.',
  },
  {
    path: 'app/api/v1/chat/conversations/[id]/route.ts',
    disposition: 'by-design',
    reason:
      'consumer detail/delete fetched by `{ id, userId: session.user.id }` and declared ' +
      '`ownership: self`; another user’s id is a 404 rather than a read.',
  },
  {
    path: 'app/api/v1/chat/conversations/[id]/share/route.ts',
    disposition: 'by-design',
    reason:
      'a share is created or revoked only on a conversation fetched by ' +
      '`{ id, userId: session.user.id }` — the owner’s consent about their own row.',
  },
  {
    path: 'app/api/v1/chat/conversations/[id]/messages/route.ts',
    disposition: 'by-design',
    reason:
      'messages are reached only through a conversation fetched by ' +
      '`{ id, userId: session.user.id }`; declared `ownership: self`.',
  },
  {
    path: 'app/api/v1/chat/conversations/[id]/messages/[messageId]/rate/route.ts',
    disposition: 'by-design',
    reason:
      'the rating is applied only to a message inside a conversation fetched by ' +
      '`{ id, userId: session.user.id }`; declared `ownership: self`.',
  },

  // ── Machine callers: no admin whose rows the read could be narrowed to ────
  {
    path: 'app/api/v1/inbound/[channel]/[slug]/route.ts',
    disposition: 'by-design',
    reason:
      'an inbound-channel receiver authenticated by Slack/Postmark/HMAC signature; it ' +
      'creates the ownerless run and thread (#502) and has no session to scope by.',
  },
  {
    path: 'app/api/v1/webhooks/trigger/[slug]/route.ts',
    disposition: 'by-design',
    reason:
      'a webhook receiver authenticated by the trigger’s own secret; it creates the ' +
      'ownerless run (#502) and has no session to scope by.',
  },
  {
    path: 'app/api/v1/orchestration/approvals/[id]/status/route.ts',
    disposition: 'by-design',
    reason:
      'the signed approval token is the whole authorization — no session, no admin ' +
      'check — and it reads exactly the one execution the token was minted for.',
  },

  // ── Engine, scheduler and maintenance: the work is the organisation’s ─────
  {
    path: 'lib/orchestration/engine/orchestration-engine.ts',
    disposition: 'by-design',
    reason:
      'the runtime that drives a run: it writes the row it was handed by whoever was ' +
      'already authorized to start or resume it, and reads no row on a caller’s behalf.',
  },
  {
    path: 'lib/orchestration/engine/lease.ts',
    disposition: 'by-design',
    reason:
      'lease claim/refresh/clear on the execution row a host is driving; a crash-recovery ' +
      'primitive with no caller, keyed on `leaseToken`.',
  },
  {
    path: 'lib/orchestration/engine/execution-reaper.ts',
    disposition: 'by-design',
    reason:
      'the zombie reaper: filters on `status` and a time cutoff only, deliberately ' +
      'without `userId` or policy, so a stuck run is recovered on a narrowing fork too.',
  },
  {
    path: 'lib/orchestration/scheduling/scheduler.ts',
    disposition: 'by-design',
    reason:
      'creates and advances schedule-triggered runs (`userId = null` by #502) and drains ' +
      'the pending queue; a platform job with no caller to scope to.',
  },
  {
    path: 'lib/orchestration/approval-actions.ts',
    disposition: 'by-design',
    reason:
      'the approve/reject write, called only after a route has admitted the caller by ' +
      'the helper or by the approver nomination; re-asking here would be a second answer.',
  },
  {
    path: 'lib/orchestration/retention.ts',
    disposition: 'by-design',
    reason:
      'the scheduled purge: deletes terminal rows past their retention window across the ' +
      'deployment, by age and status only, with no caller to scope to.',
  },
  {
    path: 'lib/privacy/export-sources.ts',
    disposition: 'by-design',
    reason:
      'the Art. 15 manifest, keyed on the data subject’s own `userId` by construction; ' +
      'an ownerless row has no subject to be exported to.',
  },
  {
    path: 'lib/orchestration/evaluations/run-cases/workflow-case.ts',
    disposition: 'by-design',
    reason:
      'the evaluation worker reads back the final row of the execution it just started; ' +
      'no caller, and the id was never user-supplied.',
  },
  {
    path: 'lib/orchestration/evaluations/datasets/capture.ts',
    disposition: 'by-design',
    reason:
      'takes message and execution ids the capture route already admitted through ' +
      '`adminCanViewConversation` / `adminCanViewExecution`; authorization is the caller’s.',
  },
  {
    path: 'lib/orchestration/cost-estimation/workflow-cost.ts',
    disposition: 'by-design',
    reason:
      'an empirical estimate over a workflow’s own completed runs — cost and token ' +
      'aggregates, no row content — on a model (`AiWorkflow`) that is admin-global.',
  },

  // ── Chat runtime and inbound plumbing: the conversation’s own machinery ───
  {
    path: 'lib/orchestration/chat/streaming-handler.ts',
    disposition: 'by-design',
    reason:
      'the consumer chat runtime: finds and creates conversations for `request.userId` ' +
      'and writes the turn into them; every read is keyed on that id.',
  },
  {
    path: 'lib/orchestration/chat/resume-conversation.ts',
    disposition: 'by-design',
    reason:
      'looks up the caller’s own resumable thread by `{ userId, agentId, contextType, ' +
      'contextId }`; the consumer’s id is in the key.',
  },
  {
    path: 'lib/orchestration/chat/message-embedder.ts',
    disposition: 'by-design',
    reason:
      'embeds message rows by id for the search index — a batch job over rows already ' +
      'written, with no caller and no visibility decision to make.',
  },
  {
    path: 'lib/orchestration/inbound/conversation-resolver.ts',
    disposition: 'by-design',
    reason:
      'finds or creates the ownerless inbound thread for a channel key (#502); this is ' +
      'the code that makes the rows the helper later decides about.',
  },
  {
    path: 'lib/orchestration/engine/executors/chat-turn.ts',
    disposition: 'by-design',
    reason:
      'the `chat_turn` step reads and appends to the conversation its own run was given; ' +
      'the engine has no caller to scope by.',
  },
  {
    path: 'lib/orchestration/capabilities/built-in/send-message-to-channel.ts',
    disposition: 'by-design',
    reason:
      'a capability sending a reply on the conversation the executing run was handed; ' +
      'it loads that one row by id to learn its channel.',
  },

  // The fork-owned tail. Sunrise ships it empty; everything above is core's.
  ...appOwnerlessSurfaceExceptions,
];

/**
 * The files the rule cannot apply to: the two helpers, which query Prisma
 * directly by definition, and this module, whose regex literals name the
 * models. Named files, not the directory — a future sibling in
 * `lib/orchestration/access/` that reads one of the three models gets no free
 * pass for living next door.
 */
const SKIPPED_FILES = new Set([
  'lib/orchestration/access/execution-access.ts',
  'lib/orchestration/access/conversation-access.ts',
  'lib/orchestration/access/ownerless-surfaces.ts',
]);

/** One thing wrong: a file that reads outside the helpers, or an entry that has rotted. */
export interface OwnerlessSurfaceViolation {
  /** The file, or `'(roster)'` for a setup fault. */
  path: string;
  /** What is wrong, in a sentence an assertion message can print verbatim. */
  message: string;
}

/**
 * A model reached through a Prisma client, by any of the shapes TypeScript
 * offers: `prisma.aiConversation`, `tx?.aiConversation`, `prisma['aiConversation']`,
 * `(tx ?? prisma).aiMessage`, `getDb().aiWorkflowExecution`. No receiver is
 * required — a receiver pattern only ever buys false negatives.
 */
const MODEL_ACCESSOR = /(?:\?\.|\.|\[\s*['"])(aiWorkflowExecution|aiConversation|aiMessage)\b/g;
/** A model pulled off a client by destructuring: `const { aiMessage } = prisma`. */
const MODEL_DESTRUCTURE =
  /\{[^{}]*\b(aiWorkflowExecution|aiConversation|aiMessage)\b[^{}]*\}\s*=\s*[\w$.?]+/g;
/**
 * A table named in raw SQL, after a keyword that reads or writes it. Tolerates a
 * schema qualifier and a newline between the keyword and the name, and the
 * `Prisma.raw('ai_message')` form, where the keyword is on the other side of a
 * template boundary.
 */
const RAW_TABLE =
  /(?:\b(?:FROM|JOIN|INTO|UPDATE)\s+(?:"?\w+"?\.)?"?|\braw\(\s*['"`])(ai_workflow_execution|ai_conversation|ai_message)\b/gi;
const TABLE_TO_MODEL: Record<string, OwnerlessModel> = {
  ai_workflow_execution: 'aiWorkflowExecution',
  ai_conversation: 'aiConversation',
  ai_message: 'aiMessage',
};
/**
 * A value import from one of the two helper modules. `import type { … }` is
 * deliberately not matched, and an inline `type X` spec is dropped below: a
 * type reaches nothing at runtime, so it cannot be the road a query took. The
 * helpers export `AccessBasis`, `AdminCanViewResult` and `ExecutionOwner`, so
 * the type-only shape is an easy accident as well as an easy dodge.
 */
const HELPER_IMPORT =
  /import\s+\{([^}]*)\}\s+from\s+['"]@\/lib\/orchestration\/access\/(execution-access|conversation-access)['"]/g;

function isOwnerlessModel(value: string): value is OwnerlessModel {
  return Object.hasOwn(OWNERLESS_MODELS, value);
}

type HelperModule = (typeof OWNERLESS_MODELS)[OwnerlessModel];

function isHelperModule(value: string): value is HelperModule {
  return value === 'execution-access' || value === 'conversation-access';
}

/**
 * The source with every comment removed — block comments by state, not by a
 * leading `*`, so a SQL line that happens to begin with `*` (`SELECT\n  * FROM
 * ai_conversation`) is still code. Line comments go from `//` to end of line;
 * a `//` inside a string literal is left alone by tracking the quote state,
 * which is enough for the shapes this tree contains (URLs in strings) without
 * a full tokenizer.
 *
 * **Not a tokenizer, and the failure direction is stated.** A regex literal
 * containing a lone quote (`/['"]/`) desyncs the quote tracking, after which
 * comment text may be kept — a false positive, which is loud. The one shape
 * that could drop code is a `//` inside a string on a line that also reads a
 * model, *after* such a desync; none exists in this tree, and the module's own
 * source (which is full of such regexes) is skipped by path.
 */
export function stripComments(source: string): string {
  let out = '';
  let i = 0;
  let quote: string | null = null;
  while (i < source.length) {
    const ch = source[i];
    const next = source[i + 1];
    if (quote) {
      out += ch;
      if (ch === '\\') {
        out += next ?? '';
        i += 2;
        continue;
      }
      if (ch === quote) quote = null;
      i += 1;
      continue;
    }
    if (ch === '/' && next === '*') {
      const end = source.indexOf('*/', i + 2);
      // Keep the newlines so line-oriented callers see the same line count.
      const skipped = end === -1 ? source.slice(i) : source.slice(i, end + 2);
      out += skipped.replace(/[^\n]/g, '');
      i += skipped.length;
      continue;
    }
    if (ch === '/' && next === '/') {
      const end = source.indexOf('\n', i);
      i = end === -1 ? source.length : end;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') quote = ch;
    out += ch;
    i += 1;
  }
  return out;
}

/** The models a file reads, found in its code — a comment naming one is not a read. */
export function modelsRead(source: string): Set<OwnerlessModel> {
  const code = stripComments(source);
  const found = new Set<OwnerlessModel>();
  // The regexes' alternations are the three names, so these guards cannot
  // fail; they are how the capture group becomes the union without a cast.
  for (const rx of [MODEL_ACCESSOR, MODEL_DESTRUCTURE]) {
    for (const m of code.matchAll(rx)) {
      if (isOwnerlessModel(m[1])) found.add(m[1]);
    }
  }
  for (const m of code.matchAll(RAW_TABLE)) {
    const model = TABLE_TO_MODEL[m[1].toLowerCase()];
    if (model) found.add(model);
  }
  return found;
}

interface HelperImports {
  /** Which helper modules the file imports from. */
  modules: Set<HelperModule>;
  /** Each imported value binding, so an unused one can be named. */
  names: string[];
}

function helperImports(source: string): HelperImports {
  const modules = new Set<HelperModule>();
  const names: string[] = [];
  // Over the stripped source, as `modelsRead` is: a commented-out import is
  // not an import.
  for (const m of stripComments(source).matchAll(HELPER_IMPORT)) {
    const bound: string[] = [];
    for (const raw of m[1].split(',')) {
      const spec = raw.trim();
      if (!spec || spec.startsWith('type ')) continue;
      // `a as b` binds `b`; a bare `a` binds `a`.
      bound.push(spec.includes(' as ') ? spec.split(' as ')[1].trim() : spec);
    }
    // The module counts only if something with a runtime existence came from it.
    if (bound.length > 0 && isHelperModule(m[2])) modules.add(m[2]);
    names.push(...bound);
  }
  return { modules, names };
}

/** Occurrences of a bound name in code outside `import` statements — a comment mentioning it is not a use. */
function usesOutsideImports(source: string, name: string): boolean {
  const withoutImports = stripComments(source).replace(
    /^import[\s\S]*?from\s+['"][^'"]+['"];?/gm,
    ''
  );
  return new RegExp(`\\b${name.replace(/\$/g, '\\$')}\\b`).test(withoutImports);
}

/** Sanity of the roster itself: reasons, dispositions, duplicates. Pure. */
export function validateExceptions(
  exceptions: readonly OwnerlessSurfaceException[]
): OwnerlessSurfaceViolation[] {
  const violations: OwnerlessSurfaceViolation[] = [];
  const seen = new Set<string>();
  for (const entry of exceptions) {
    if (seen.has(entry.path)) {
      violations.push({
        path: entry.path,
        message: `Listed twice in the ownerless-surface exceptions — one entry per file, so a reason cannot be quietly split across two.`,
      });
    }
    seen.add(entry.path);
    if (entry.reason.trim().length < MIN_REASON_LENGTH) {
      violations.push({
        path: entry.path,
        message: `Exception reason is under ${MIN_REASON_LENGTH} characters ("${entry.reason}"). Say why this file may read the model outside the helper, in the terms the next person needs.`,
      });
    }
    if (entry.disposition === 'known-gap' && !entry.tracking?.trim()) {
      violations.push({
        path: entry.path,
        message: `A 'known-gap' entry must name where the fix lives in \`tracking\` (an issue or Hub task); without one it is a by-design entry wearing a different label.`,
      });
    }
    if (entry.disposition === 'by-design' && entry.tracking) {
      violations.push({
        path: entry.path,
        message: `A 'by-design' entry carries \`tracking\` ("${entry.tracking}") — if something is meant to close it, it is a 'known-gap'.`,
      });
    }
  }
  return violations;
}

/**
 * Every file that reads one of the three models outside its access helper and
 * is not declared as an exception — plus every exception that has rotted.
 *
 * Pure: `files` is the roster of source paths to consider and `read` returns a
 * file's text (or `null` to skip it), so a test can hand it synthetic files and
 * prove it goes red. The two helper modules and this file are skipped by name
 * ({@link SKIPPED_FILES}) — the helpers query Prisma directly by definition.
 *
 * Reports a setup fault as a violation: run over zero files it could not have
 * found anything, and a glob that silently matched nothing is the quiet green
 * this whole module is written against.
 */
export function findUndeclaredOwnerlessReads(
  files: readonly string[],
  read: (path: string) => string | null,
  exceptions: readonly OwnerlessSurfaceException[] = OWNERLESS_SURFACE_EXCEPTIONS
): OwnerlessSurfaceViolation[] {
  if (files.length === 0) {
    return [
      {
        path: '(roster)',
        message:
          'findUndeclaredOwnerlessReads was handed no files, so it could not have found a read. The glob that builds the roster matched nothing.',
      },
    ];
  }

  const violations = validateExceptions(exceptions);
  const byPath = new Map(exceptions.map((e) => [e.path, e]));
  const seenPaths = new Set<string>();

  for (const path of files) {
    if (SKIPPED_FILES.has(path)) continue;
    const source = read(path);
    if (source === null) continue;
    seenPaths.add(path);

    const models = modelsRead(source);
    const imports = helperImports(source);
    const exception = byPath.get(path);

    if (models.size === 0) {
      if (exception) {
        violations.push({
          path,
          message: `Declared as an ownerless-surface exception but no longer reads AiWorkflowExecution, AiConversation or AiMessage. Delete the entry.`,
        });
      }
      continue;
    }

    const uncovered = [...models].filter((model) => !imports.modules.has(OWNERLESS_MODELS[model]));

    for (const name of imports.names) {
      if (!usesOutsideImports(source, name)) {
        violations.push({
          path,
          message: `Imports \`${name}\` from the access helper and never uses it. A bare import satisfies nothing — the query has to go through the helper, not sit beside it.`,
        });
      }
    }

    if (uncovered.length === 0) {
      if (exception) {
        violations.push({
          path,
          message: `Declared as an ownerless-surface exception (${exception.disposition}) but now imports the access helper for everything it reads. The entry is stale — delete it${exception.tracking ? `, and close ${exception.tracking} if this was the fix` : ''}.`,
        });
      }
      continue;
    }

    if (!exception) {
      const helpers = [...new Set(uncovered.map((m) => OWNERLESS_MODELS[m]))].join(', ');
      violations.push({
        path,
        message:
          `Reads ${uncovered.join(', ')} without importing \`@/lib/orchestration/access/${helpers}\`. ` +
          `Rows nobody owns will match nobody here, and the authorization policy is never asked. ` +
          `Go through the helper, or — if this file genuinely has no caller to scope to — declare it in ` +
          `OWNERLESS_SURFACE_EXCEPTIONS (core) or appOwnerlessSurfaceExceptions in lib/app/ci.ts (a fork), with the reason.`,
      });
    }
  }

  for (const entry of exceptions) {
    if (!seenPaths.has(entry.path)) {
      violations.push({
        path: entry.path,
        message: `Declared as an ownerless-surface exception but no such source file was scanned. Deleted or moved? Update or remove the entry.`,
      });
    }
  }

  return violations;
}
