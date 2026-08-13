/**
 * Invariant: every `AiCapability` seed re-applies its code-owned fields.
 *
 * `functionDefinition`, `executionType` and `executionHandler` describe what
 * the code does — the schema the LLM and every MCP client are shown, and the
 * handler class the dispatcher resolves. They are not admin customisations, so
 * a seed that only writes them on `create` leaves an existing row advertising
 * the original schema forever. That is #545: a downstream fork added a
 * parameter to a capability, every test stayed green, and the MCP schema on
 * dev and prod never showed the new field.
 *
 * The tests it already had could not catch it — they pin the capability class
 * against the seed constant, not the seed constant against the DB write. This
 * one reads the `update` branch itself.
 *
 * **Source-level on purpose.** A behavioural test with a mock prisma would only
 * cover the seeds someone remembered to write a test for, and the failure mode
 * here is the *next* capability seed, written by someone who copied a file that
 * predates the rule. Parsing every seed catches that on the PR that adds it —
 * including a fork's own seeds in a `prisma/seeds/` subdirectory, which the runner
 * discovers recursively and the first version of this file did not read.
 *
 * Operator-owned fields are asserted absent as well, in both directions: a seed
 * that starts re-applying `isActive` would silently re-enable a capability an
 * operator turned off, and one that re-applies `name` would revert their
 * rename on the next deploy. The LLM-facing name and description live inside
 * `functionDefinition`, so nothing the model reads depends on those columns.
 *
 * @see tests/helpers/seed-capabilities.ts — the reader, and what it refuses to guess
 * @see .context/database/seeding.md — the ownership rule
 */

import { describe, it, expect } from 'vitest';

import { scanCapabilitySeeds } from '@/tests/helpers/seed-capabilities';

/** Must track the capability class — always re-applied. */
const CODE_OWNED = ['functionDefinition', 'executionType', 'executionHandler'] as const;

/** The operator's to change — a seed must never write these on update. */
const OPERATOR_OWNED = ['isActive', 'rateLimit', 'name', 'description', 'category'] as const;

describe('AiCapability seeds — code-owned fields are re-applied (#545)', () => {
  const { upserts, unparseable } = scanCapabilitySeeds();

  it('could read every capability upsert it found', () => {
    // A call site the reader cannot interpret — an `update:` hoisted into a
    // const, a helper call — used to be skipped, which reported success for
    // code nobody had checked. If this fires, extend the reader; do not
    // relax it.
    expect(unparseable).toEqual([]);
  });

  it('finds the capability seeds at all', () => {
    // Guards the parser: a silent zero would make every assertion below vacuous
    // and the suite would stay green while the invariant went unchecked.
    expect(upserts.length).toBeGreaterThanOrEqual(7);
  });

  it.each(CODE_OWNED)('every seed re-applies %s on update', (field) => {
    const missing = upserts.filter((u) => !u.update.includes(field)).map((u) => u.file);
    expect(missing).toEqual([]);
  });

  it.each(OPERATOR_OWNED)('no seed overwrites %s on update', (field) => {
    const clobbering = upserts.filter((u) => u.update.includes(field)).map((u) => u.file);
    expect(clobbering).toEqual([]);
  });
});
