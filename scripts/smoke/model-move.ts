/**
 * Smoke: the model move edits each org's rows inside its own scope, and
 * nothing else (§136 t-1066).
 *
 * `moveModelUses` walks every active org and writes agents, agent versions,
 * workflows, workflow versions and audit rows. The unit tests run it against
 * fakes; this runs the real thing against a real database at
 * `TENANCY_MODE=multi`, with three orgs it makes for the run:
 *
 *   - A and B (active): each has an agent bound to the retiring model, an
 *     agent on another model, and a workflow pinning the model in its draft
 *     and its published version;
 *   - C (suspended): an agent bound to the retiring model.
 *
 * It proves, after a preview that changes nothing:
 *   - A's and B's bound agents are on the replacement, provider unchanged;
 *     their other agents, and C's agent, are not;
 *   - every agent version and workflow version the move wrote carries the org
 *     of the row it versions. The data layer stamps `orgId` from the scope a
 *     row is created in, so a write made in the wrong org's scope, or none,
 *     shows here; with the isolation policies enabled it would be refused too;
 *   - each workflow's draft and a NEW published version pin the replacement
 *     as a pair, and the old published version is untouched;
 *   - each per-entity audit row names its own org (`actingOrgId`), and the
 *     summary row names the install org the move was run from.
 *
 * It does not test an org's own key (that needs a vendor; the unit tests
 * cover the skip). It touches no install setting: the models it makes are
 * its own, on a provider slug of its own, which no setting names.
 *
 *   TENANCY_MODE=multi npx tsx --env-file=.env.local scripts/smoke/model-move.ts
 *
 * Runs on the dev database or a throwaway one, with or without the isolation
 * policies (with them, run it as the app role, as the isolation smoke is).
 * Refuses to run at `single`; skips clean when no database is reachable.
 * Self-cleaning: everything it creates is removed on the way out, under the
 * system scope, whether or not the checks held, and a failed cleanup fails
 * the run.
 */
import '@/prisma/load-env';
import { prisma } from '@/lib/db/client';
import { formatModelPin } from '@/lib/orchestration/llm/model-pin';
import {
  loadMoveTarget,
  moveModelUses,
  previewModelMove,
} from '@/lib/orchestration/model-lifecycle/move';
import { INSTALL_ORG_ID } from '@/lib/tenancy/constants';
import { isMultiTenant, runAsOrg, runAsSystem } from '@/lib/tenancy/context';

const stamp = Date.now().toString(36);
const PROVIDER = `smoke-move-${stamp}`;
const OLD = 'smoke-old';
const NEW = 'smoke-new';
const OTHER = 'smoke-other';

let failures = 0;
function check(cond: boolean, msg: string): void {
  if (cond) {
    console.log(`  ✓ ${msg}`);
    return;
  }
  failures += 1;
  console.log(`  ✗ ${msg}`);
}

async function dbReachable(): Promise<boolean> {
  try {
    await runAsSystem('smoke: reachability', () => prisma.$queryRaw`SELECT 1`);
    return true;
  } catch {
    return false;
  }
}

function definition(override: string) {
  return {
    entryStepId: 'ask',
    errorStrategy: 'fail',
    steps: [
      {
        id: 'ask',
        name: 'Ask',
        type: 'llm_call',
        config: { prompt: 'Say hello', modelOverride: override },
        nextSteps: [],
      },
    ],
  };
}

function overrideOf(def: unknown): unknown {
  if (!def || typeof def !== 'object' || !('steps' in def) || !Array.isArray(def.steps)) {
    return undefined;
  }
  const first: unknown = def.steps[0];
  if (!first || typeof first !== 'object' || !('config' in first)) return undefined;
  const config: unknown = first.config;
  return config && typeof config === 'object' && 'modelOverride' in config
    ? config.modelOverride
    : undefined;
}

interface OrgRows {
  orgId: string;
  bound: string;
  other: string;
  workflow: string | null;
}

/** An org's fixtures, made inside its scope so the data layer stamps them. */
async function seedOrg(orgId: string, label: string, withWorkflow: boolean): Promise<OrgRows> {
  return runAsOrg(orgId, async () => {
    const agent = (name: string, model: string) =>
      prisma.aiAgent.create({
        data: {
          name: `${label} ${name}`,
          slug: `smoke-move-${stamp}-${name}`,
          description: 'smoke:model-move',
          systemInstructions: 'x',
          provider: PROVIDER,
          model,
        },
        select: { id: true },
      });
    const bound = await agent('bound', OLD);
    const other = await agent('other', OTHER);
    let workflow: string | null = null;
    if (withWorkflow) {
      const wf = await prisma.aiWorkflow.create({
        data: {
          name: `${label} pipeline`,
          slug: `smoke-move-${stamp}-${label.toLowerCase()}`,
          description: 'smoke:model-move',
          draftDefinition: definition(formatModelPin(PROVIDER, OLD)),
        },
        select: { id: true },
      });
      const v1 = await prisma.aiWorkflowVersion.create({
        data: { workflowId: wf.id, version: 1, snapshot: definition(OLD) },
        select: { id: true },
      });
      await prisma.aiWorkflow.update({ where: { id: wf.id }, data: { publishedVersionId: v1.id } });
      workflow = wf.id;
    }
    return { orgId, bound: bound.id, other: other.id, workflow };
  });
}

async function main(): Promise<void> {
  if (!(await dbReachable())) {
    console.log('smoke:model-move skipped — no database reachable.');
    return;
  }
  if (!isMultiTenant()) {
    console.error('smoke:model-move needs TENANCY_MODE=multi: at single there is one org to move.');
    process.exit(1);
  }

  const orgIds: string[] = [];
  const modelIds: string[] = [];
  const startedAt = new Date();
  try {
    const admin = await prisma.user.findFirst({ where: { role: 'ADMIN' }, select: { id: true } });
    if (!admin) throw new Error('No admin user to run the move as. Seed the database first.');

    // ── Fixtures ──────────────────────────────────────────────────────────
    const [oldModel, newModel] = await runAsSystem('smoke: model-move setup', async () => {
      for (const [slug, name, status] of [
        ['a', 'Smoke move A', 'ACTIVE'],
        ['b', 'Smoke move B', 'ACTIVE'],
        ['c', 'Smoke move C', 'SUSPENDED'],
      ] as const) {
        const org = await prisma.org.create({
          data: { slug: `smoke-move-${stamp}-${slug}`, name, status },
          select: { id: true },
        });
        orgIds.push(org.id);
      }
      const row = (modelId: string, retiresAt: Date | null) =>
        prisma.aiProviderModel.create({
          data: {
            slug: `${PROVIDER}-${modelId}`,
            providerSlug: PROVIDER,
            modelId,
            name: `Smoke ${modelId}`,
            description: 'smoke:model-move',
            capabilities: ['chat'],
            tierRole: 'worker',
            reasoningDepth: 'medium',
            latency: 'medium',
            costEfficiency: 'medium',
            contextLength: 'medium',
            toolUse: 'moderate',
            bestRole: 'smoke',
            retiresAt,
          },
          select: { id: true },
        });
      const made = [await row(OLD, new Date(Date.now() + 90 * 86_400_000)), await row(NEW, null)];
      modelIds.push(...made.map((m) => m.id));
      return made;
    });
    const [a, b, c] = [
      await seedOrg(orgIds[0], 'A', true),
      await seedOrg(orgIds[1], 'B', true),
      await seedOrg(orgIds[2], 'C', false),
    ];

    // ── Preview ───────────────────────────────────────────────────────────
    console.log('\n[1] preview: counts each org, changes nothing');
    const target = await loadMoveTarget(oldModel.id, newModel.id);
    const preview = await runAsOrg(INSTALL_ORG_ID, () => previewModelMove(target));
    const previewed = preview.orgs.filter((o) => orgIds.includes(o.orgId));
    check(
      JSON.stringify(previewed.map((o) => [o.orgId, o.agents, o.workflows])) ===
        JSON.stringify([
          [a.orgId, 1, 1],
          [b.orgId, 1, 1],
        ]),
      'A and B each have one agent and one workflow to move; suspended C is not entered'
    );
    const stillOld = await runAsSystem('smoke: read', () =>
      prisma.aiAgent.count({ where: { provider: PROVIDER, model: OLD } })
    );
    check(stillOld === 3, 'the preview moved nothing');

    // ── Move ──────────────────────────────────────────────────────────────
    console.log('\n[2] move: each org inside its own scope');
    const result = await runAsOrg(INSTALL_ORG_ID, () =>
      moveModelUses(target, { userId: admin.id, clientIp: null })
    );
    const ours = result.orgs.filter((o) => orgIds.includes(o.orgId));
    check(
      ours.every((o) => o.status === 'moved' && o.agents === 1 && o.workflows === 1) &&
        ours.length === 2,
      'A and B report moved: one agent and one workflow each'
    );
    check(result.settings.moved.length === 0, 'no install setting changed (none names the model)');

    await runAsSystem('smoke: model-move checks', async () => {
      const agents = await prisma.aiAgent.findMany({
        where: { id: { in: [a.bound, a.other, b.bound, b.other, c.bound] } },
        select: { id: true, provider: true, model: true },
      });
      const model = (id: string) => agents.find((x) => x.id === id)?.model;
      check(
        model(a.bound) === NEW && model(b.bound) === NEW,
        'A’s and B’s bound agents are on the replacement'
      );
      check(
        agents.every((x) => x.provider === PROVIDER),
        'every agent kept its provider'
      );
      check(
        model(a.other) === OTHER && model(b.other) === OTHER,
        'agents on another model are untouched'
      );
      check(model(c.bound) === OLD, 'the suspended org’s agent is untouched');

      for (const org of [a, b]) {
        const versions = await prisma.aiAgentVersion.findMany({
          where: { agentId: org.bound },
          select: { orgId: true, changeSummary: true },
          orderBy: { version: 'asc' },
        });
        check(
          versions.length >= 1 &&
            versions.every((v) => v.orgId === org.orgId) &&
            versions.some((v) => v.changeSummary?.startsWith('Model smoke-old moved') === true),
          `the agent versions in ${org === a ? 'A' : 'B'} carry that org, the move’s among them`
        );

        if (!org.workflow) continue;
        const wf = await prisma.aiWorkflow.findUnique({
          where: { id: org.workflow },
          select: {
            draftDefinition: true,
            publishedVersion: { select: { version: true, snapshot: true, orgId: true } },
            versions: { select: { version: true, snapshot: true }, orderBy: { version: 'asc' } },
          },
        });
        const pair = formatModelPin(PROVIDER, NEW);
        check(
          overrideOf(wf?.draftDefinition) === pair,
          `the draft in ${org === a ? 'A' : 'B'} pins the replacement as a pair`
        );
        check(
          wf?.publishedVersion?.version === 2 &&
            overrideOf(wf.publishedVersion.snapshot) === pair &&
            wf.publishedVersion.orgId === org.orgId,
          'a new published version (v2) pins it, stamped with the workflow’s org'
        );
        check(
          overrideOf(wf?.versions[0]?.snapshot) === OLD,
          'the old published version (v1) is untouched'
        );
      }

      const rows = await prisma.aiAdminAuditLog.findMany({
        where: {
          createdAt: { gte: startedAt },
          action: {
            in: ['agent.model_moved', 'workflow.model_moved', 'provider_model.uses_moved'],
          },
          OR: [
            { entityId: { in: [a.bound, b.bound, a.workflow ?? '', b.workflow ?? ''] } },
            { entityId: oldModel.id },
          ],
        },
        select: { action: true, entityId: true, actingOrgId: true },
      });
      const orgOf = (id: string) =>
        rows.find((r) => r.entityId === id && r.action !== 'provider_model.uses_moved')
          ?.actingOrgId;
      check(
        orgOf(a.bound) === a.orgId &&
          orgOf(a.workflow ?? '') === a.orgId &&
          orgOf(b.bound) === b.orgId &&
          orgOf(b.workflow ?? '') === b.orgId,
        'each per-entity audit row names its own org'
      );
      check(
        rows.some(
          (r) => r.action === 'provider_model.uses_moved' && r.actingOrgId === INSTALL_ORG_ID
        ),
        'the summary row names the install org the move ran from'
      );
    });
  } finally {
    // Audit rows are written fire-and-forget: give them a moment to land
    // before they are removed.
    await new Promise((resolve) => setTimeout(resolve, 500));
    await runAsSystem('smoke: model-move cleanup', async () => {
      await prisma.aiAdminAuditLog.deleteMany({
        where: {
          createdAt: { gte: startedAt },
          OR: [
            { actingOrgId: { in: orgIds } },
            { action: 'provider_model.uses_moved', entityId: { in: modelIds } },
          ],
        },
      });
      // Org rows cascade to their agents, workflows and versions.
      await prisma.org.deleteMany({ where: { id: { in: orgIds } } });
      await prisma.aiProviderModel.deleteMany({ where: { id: { in: modelIds } } });
    }).catch((err: unknown) => {
      console.error('✗ cleanup failed — remove the smoke-move rows by hand', err);
      process.exitCode = 1;
    });
    await prisma.$disconnect();
  }
  if (failures > 0) {
    console.error(`\n✗ smoke:model-move failed (${failures} check${failures === 1 ? '' : 's'})`);
    process.exitCode = 1;
  } else if (process.exitCode !== 1) {
    console.log('\n✓ smoke:model-move passed');
  }
}

main().catch((err: unknown) => {
  console.error('\n✗ smoke:model-move failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
