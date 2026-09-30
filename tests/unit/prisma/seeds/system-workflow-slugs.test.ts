/**
 * Every seed that writes a system workflow is known to SYSTEM_WORKFLOW_SLUGS (t-729).
 *
 * `SYSTEM_WORKFLOW_SLUGS` is a hand-written list: the backup importer refuses
 * those slugs whatever the target holds, because a row's `isSystem` flag is
 * invisible where the row is absent or another org's. A seed that starts
 * writing a new system workflow and does not add its slug leaves the importer
 * blind to it exactly there. Nothing imports a seed file, so no module graph
 * connects a new seed to this rule; this test reads `prisma/seeds/` off disk
 * and pins which units write `isSystem: true` workflows.
 *
 * What it does not see, so a green run is not a proof: a unit that writes a
 * system workflow through a helper, or sets `isSystem` from a variable; and a
 * second system workflow written by a unit already listed here. It pins
 * files, not slugs.
 *
 * If this fails because you added a seed that writes a system workflow: add
 * its slug to `SYSTEM_WORKFLOW_SLUGS` in
 * `lib/orchestration/workflows/template-catalogue.ts`, then add the unit here.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import { describe, it, expect, vi } from 'vitest';

vi.mock('@/lib/db/client', () => ({ prisma: {} }));

import { isSystemWorkflowSlug } from '@/lib/orchestration/workflows/template-catalogue';
import { PROVIDER_MODEL_AUDIT_TEMPLATE } from '@/prisma/seeds/data/templates/provider-model-audit';

const SEEDS_DIR = path.join(process.cwd(), 'prisma', 'seeds');

/** Seed units (recursively, excluding `data/`) as paths relative to the seeds dir. */
function seedUnits(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === 'data') continue;
      out.push(...seedUnits(full));
    } else if (entry.endsWith('.ts')) {
      out.push(path.relative(SEEDS_DIR, full));
    }
  }
  return out;
}

/** True when a unit writes AiWorkflow rows and sets `isSystem: true` somewhere. */
function writesSystemWorkflow(source: string): boolean {
  return (
    /\.aiWorkflow\.(create|update|upsert)(Many)?\b/.test(source) && /isSystem:\s*true/.test(source)
  );
}

describe('seeds that write system workflows', () => {
  it('reads a non-trivial set of seed units', () => {
    // An empty or wrong directory would make the pinned list below pass on
    // nothing; prove the scan sees the tree first.
    expect(seedUnits(SEEDS_DIR).length).toBeGreaterThan(10);
  });

  it('are exactly the units whose slugs SYSTEM_WORKFLOW_SLUGS knows', () => {
    const writers = seedUnits(SEEDS_DIR)
      .filter((unit) => writesSystemWorkflow(readFileSync(path.join(SEEDS_DIR, unit), 'utf8')))
      .sort();

    expect(writers).toEqual(['010-model-auditor.ts']);
    // …and the workflow that unit writes is on the importer's list.
    expect(isSystemWorkflowSlug(PROVIDER_MODEL_AUDIT_TEMPLATE.slug)).toBe(true);
  });
});
