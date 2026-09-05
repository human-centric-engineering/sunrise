/**
 * AgentForm — version-restore `reset()` parity with the form schema.
 *
 * `reset(values)` in react-hook-form REPLACES form state wholesale rather than
 * merging. Any field `agentFormSchema` requires but the restore handler omits
 * therefore becomes `undefined`, and every save after a version restore fails
 * the resolver.
 *
 * That is not hypothetical: ten fields were missing (`kind`, `personaMode`,
 * `voiceMode`, `guardrailsMode`, the three `enable*Input` booleans, plus
 * `profileId` / `persona` / `guardrails`), seven of them required enums or
 * booleans. Restoring any version left the form permanently unsavable. It went
 * unnoticed for so long because `handleSubmit` had no `onInvalid` branch, so
 * the failure was a completely silent no-op — the click just did nothing.
 *
 * A behavioural test would have to drive the child tab's `onRestored`
 * callback through a mocked API round trip; this reads the two field lists
 * out of the source instead, which is the cheap check that actually catches
 * the drift — someone adding a required field to the schema and forgetting the
 * restore path. Same shape as `export-sources.test.ts` parsing the Prisma
 * schema.
 *
 * If the anchors below stop matching (a refactor moved or reshaped either
 * block) this test THROWS rather than passing vacuously. That is deliberate:
 * a parity guard that silently stops looking is worse than no guard.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SOURCE = readFileSync(
  join(process.cwd(), 'components/admin/orchestration/agent-form.tsx'),
  'utf-8'
);

function schemaFields(): Set<string> {
  const match = /const agentFormSchema = z\s*\.object\(\{(.*?)\n {2}\}\)/s.exec(SOURCE);
  if (!match) throw new Error('Could not locate `agentFormSchema` — update this test`s anchor.');
  return new Set([...match[1].matchAll(/^ {4}(\w+):/gm)].map((m) => m[1]));
}

function restoreResetFields(): Set<string> {
  const match = /reset\(\{(.*?)\n {20}\}\);/s.exec(SOURCE);
  if (!match) {
    throw new Error(
      'Could not locate the version-restore `reset({...})` — update this test`s anchor.'
    );
  }
  return new Set([...match[1].matchAll(/^ +(\w+):/gm)].map((m) => m[1]));
}

describe('AgentForm — version-restore reset parity', () => {
  it('locates both blocks (guard against a vacuous pass)', () => {
    expect(schemaFields().size).toBeGreaterThan(30);
    expect(restoreResetFields().size).toBeGreaterThan(30);
  });

  it('the restore reset() sets every field agentFormSchema declares', () => {
    const missing = [...schemaFields()].filter((f) => !restoreResetFields().has(f)).sort();

    expect(
      missing,
      `Version restore would leave these fields undefined, and every save after a restore ` +
        `would fail validation: ${missing.join(', ')}. Add them to the reset({...}) in ` +
        `AgentVersionHistoryTab's onRestored handler.`
    ).toEqual([]);
  });

  it('the restore reset() sets nothing the schema does not declare', () => {
    // The other direction matters too: a key here that the schema dropped is
    // dead weight that reads as though it still round-trips.
    const extra = [...restoreResetFields()].filter((f) => !schemaFields().has(f)).sort();
    expect(extra).toEqual([]);
  });
});
