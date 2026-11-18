/**
 * Guard: every `logCost` call site says which key its call went out on, or why
 * it has none (§137 t-1046).
 *
 * A call on an org's own vendor key is billed to the org, so its cost row is
 * marked (`AiCostLog.ownKey`) and left out of the org's and the global monthly
 * caps. Only the provider manager knows which key a call used
 * (`usesOrgOwnKey(provider)`), and the row is written by whichever caller made
 * the call. A caller that forgets to pass it writes `ownKey: false`: the org's
 * own vendor bill then counts against the caps that protect the platform's
 * keys, and against the global one every other org shares. Nothing fails; the
 * caps just fill early.
 *
 * So, as `cost-log-fk-attribution.test.ts` does for the foreign keys, this
 * derives every `logCost` call in the tree with what it passes for `ownKey`,
 * and compares the set with a written roster. A new call site fails until
 * someone adds it and says which provider it asks about, or why it makes no
 * vendor call. Changing what a site asks about changes its key and fails too.
 *
 * What it cannot see: whether the provider a site asks about is the one it
 * called. `own-key-spend.test.ts` runs a chat turn, a workflow step and
 * embeddings end to end for that.
 *
 * @see lib/orchestration/llm/cost-tracker.ts — `LogCostParams.ownKey`
 */

import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import ts from 'typescript';

const REPO_ROOT = process.cwd();

/** Not source. `tests` is excluded — a test may pass whatever it likes. */
const NOT_SOURCE = new Set(['node_modules', '.next', '.git', 'coverage', 'tests', '.claude']);

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

/** What a `logCost` argument passes for `ownKey`: its expression, `—` for none, or opaque. */
function ownKeyOf(arg: ts.Expression | undefined, src: ts.SourceFile): string {
  if (!arg || !ts.isObjectLiteralExpression(arg)) {
    return `opaque-argument(${arg ? norm(arg.getText(src)) : 'none'})`;
  }
  for (const prop of arg.properties) {
    if (
      ts.isPropertyAssignment(prop) &&
      ts.isIdentifier(prop.name) &&
      prop.name.text === 'ownKey'
    ) {
      return norm(prop.initializer.getText(src));
    }
    if (ts.isShorthandPropertyAssignment(prop) && prop.name.text === 'ownKey') return 'ownKey';
  }
  return '—';
}

/** Every `logCost(...)` call in `text`, as `file | ownKey=<what it passes>`. */
function keysIn(file: string, text: string): string[] {
  const src = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const keys: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const name = ts.isIdentifier(callee)
        ? callee.text
        : ts.isPropertyAccessExpression(callee)
          ? callee.name.text
          : '';
      if (name === 'logCost') keys.push(`${file} | ownKey=${ownKeyOf(node.arguments[0], src)}`);
    }
    ts.forEachChild(node, visit);
  };
  visit(src);
  return keys;
}

function findCallSites(): string[] {
  const keys: string[] = [];
  for (const file of walk(REPO_ROOT)) {
    const text = readFileSync(file, 'utf8');
    if (!text.includes('logCost')) continue;
    keys.push(...keysIn(relative(REPO_ROOT, file).split(sep).join('/'), text));
  }
  return keys.sort();
}

/**
 * Every `logCost` call site, and which provider it asks `usesOrgOwnKey` about.
 *
 * ADDING AN ENTRY IS THE POINT. A failure here with an unexpected key is a new
 * or changed call site: if it makes a vendor call, pass
 * `ownKey: usesOrgOwnKey(<the provider it called>)`; if it does not, say why
 * below.
 */
const ALLOWED_CALL_SITES: readonly string[] = [
  // Transcription: the audio provider the route called.
  'app/api/v1/admin/orchestration/chat/transcribe/route.ts | ownKey=usesOrgOwnKey(audio.provider)',
  // The retroactive supervisor review's one call.
  'app/api/v1/admin/orchestration/executions/[id]/review/route.ts | ownKey=usesOrgOwnKey(provider)',
  'app/api/v1/embed/speech-to-text/route.ts | ownKey=usesOrgOwnKey(audio.provider)',
  // A channel send (SMS, email) priced by its own vendor, not an AI provider:
  // no org holds a key for it.
  'lib/orchestration/capabilities/built-in/send-message-to-channel.ts | ownKey=—',
  // A capability's own cost (`model: 'n/a'`), not a call to an AI provider.
  'lib/orchestration/capabilities/dispatcher.ts | ownKey=—',
  // Turn cost (error path, terminal, tool loop): the provider serving the turn,
  // which moves on a mid-stream failover.
  'lib/orchestration/chat/streaming-handler.ts | ownKey=usesOrgOwnKey(currentProvider)',
  'lib/orchestration/chat/streaming-handler.ts | ownKey=usesOrgOwnKey(currentProvider)',
  'lib/orchestration/chat/streaming-handler.ts | ownKey=usesOrgOwnKey(currentProvider)',
  // The attachment row, billed with the turn's call: the provider it picked.
  'lib/orchestration/chat/streaming-handler.ts | ownKey=usesOrgOwnKey(provider)',
  'lib/orchestration/chat/summarizer.ts | ownKey=usesOrgOwnKey(provider)',
  'lib/orchestration/engine/executors/agent-call.ts | ownKey=usesOrgOwnKey(provider)',
  'lib/orchestration/engine/executors/chat-turn.ts | ownKey=usesOrgOwnKey(provider)',
  'lib/orchestration/engine/llm-runner.ts | ownKey=usesOrgOwnKey(provider)',
  // Opaque by construction: `costParams` is built first, with
  // `ownKey: usesOrgOwnKey(provider)` (pinned below).
  'lib/orchestration/evaluations/complete-session.ts | ownKey=opaque-argument(costParams)',
  // A zero-cost marker row joining a run's rows; the spend is on the rows of
  // the chat turns it ran.
  'lib/orchestration/evaluations/run-worker.ts | ownKey=—',
  // `embedText` and `embedBatch`: what each call (every batch, for a run)
  // reported from `usesOrgOwnKey(llm)`.
  'lib/orchestration/knowledge/embedder.ts | ownKey=batchesOnOwnKey === true',
  'lib/orchestration/knowledge/embedder.ts | ownKey=ownKey',
  'lib/orchestration/knowledge/keyword-enricher.ts | ownKey=usesOrgOwnKey(provider)',
];

describe('AiCostLog.ownKey at every logCost call site', () => {
  const sites = findCallSites();

  it('reads every shape a call site can take', () => {
    // So an empty or all-"—" result means "looked", not "could not look".
    const probe = `
      logCost({ model: 'm', ownKey: usesOrgOwnKey(provider) });
      logCost({ model: 'm', ownKey });
      logCost({ model: 'm' });
      logCost(params);
    `;
    expect(keysIn('probe.ts', probe)).toEqual([
      'probe.ts | ownKey=usesOrgOwnKey(provider)',
      'probe.ts | ownKey=ownKey',
      'probe.ts | ownKey=—',
      'probe.ts | ownKey=opaque-argument(params)',
    ]);
  });

  it('finds the call sites it is supposed to be looking at', () => {
    expect(sites.length).toBeGreaterThanOrEqual(15);
    expect(sites).toContain(
      'lib/orchestration/engine/llm-runner.ts | ownKey=usesOrgOwnKey(provider)'
    );
  });

  it('matches the roster: each site passes the key its call used, or makes no vendor call', () => {
    expect(sites).toEqual([...ALLOWED_CALL_SITES].sort());
  });

  it('the one opaque site sets ownKey on the params it builds', () => {
    const text = readFileSync(
      join(REPO_ROOT, 'lib/orchestration/evaluations/complete-session.ts'),
      'utf8'
    );
    expect(text).toMatch(/const costParams[^=]*=\s*\{[^}]*ownKey: usesOrgOwnKey\(provider\),/s);
  });
});
